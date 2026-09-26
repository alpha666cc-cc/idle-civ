import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Dev-only writer for the in-game run log. The browser cannot touch the disk, so
// the dev server stands in for it: the client POSTs the log here and it lands in
// `saves/auto/` (gitignored, like every other save). It exists only under
// `vite dev`; a production build has no server and falls back to the save's dev
// section plus the manual download in Dev Tools.
const devLogDirectory = path.resolve(process.cwd(), 'saves', 'auto')
const devLogEndpoint = '/__dev-log'
const maxLogBytes = 8 * 1024 * 1024

/** Only ever write a plain `.json` file name, inside `saves/auto`. */
const safeLogFileName = (name: unknown): string | null => {
  if (typeof name !== 'string') return null
  const base = path.basename(name)
  if (!base.endsWith('.json')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null
  return base
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxLogBytes) {
        reject(new Error('log too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const devLogWriter = (): Plugin => ({
  name: 'idle-civ-dev-log',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(devLogEndpoint, (request, response) => {
      const reply = (status: number, body: string) => {
        response.statusCode = status
        response.setHeader('Content-Type', 'text/plain')
        response.end(body)
      }
      if (request.method !== 'POST') {
        reply(405, 'POST only')
        return
      }
      void readBody(request)
        .then(async (raw) => {
          const payload: unknown = raw.length > 0 ? JSON.parse(raw) : null
          const name =
            payload && typeof payload === 'object'
              ? safeLogFileName((payload as Record<string, unknown>).name)
              : null
          const text =
            payload && typeof payload === 'object'
              ? (payload as Record<string, unknown>).text
              : null
          if (!name || typeof text !== 'string') {
            reply(400, 'bad payload')
            return
          }
          await mkdir(devLogDirectory, { recursive: true })
          await writeFile(path.join(devLogDirectory, name), text, 'utf8')
          reply(200, 'ok')
        })
        .catch((error: unknown) => {
          reply(500, error instanceof Error ? error.message : 'write failed')
        })
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devLogWriter()],
})

