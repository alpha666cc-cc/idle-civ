import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

// Dev-only writer for the in-game run log. The browser cannot touch the disk, so
// the dev server stands in for it: the client POSTs the log here and it lands in
// `saves/auto/` (gitignored, like every other save). It exists only under
// `vite dev`; a production build has no server and falls back to the save's dev
// section plus the manual download in Dev Tools.
const savesDirectory = path.resolve(process.cwd(), "saves");
const devLogDirectory = path.join(savesDirectory, "auto");
const battleSeedFile = path.resolve(
  process.cwd(),
  "src",
  "game",
  "data",
  "battleSeeds.json",
);
const devLogEndpoint = "/__dev-log";
const battleDebugDirectory = path.join(devLogDirectory, "battle");
const battleDebugEndpoint = "/__battle-debug";
const battleDebugFilePrefix = "/__battle-debug/";
const battleSeedsEndpoint = "/__battle-debug-seeds";
const maxLogBytes = 8 * 1024 * 1024;

/** Only ever write a plain `.json` file name, inside `saves/auto`. */
const safeLogFileName = (name: unknown): string | null => {
  if (typeof name !== "string") return null;
  const base = path.basename(name);
  if (!base.endsWith(".json")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null;
  return base;
};

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxLogBytes) {
        reject(new Error("log too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const devLogWriter = (): Plugin => ({
  name: "idle-civ-dev-log",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use(devLogEndpoint, (request, response) => {
      const reply = (status: number, body: string) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "text/plain");
        response.end(body);
      };
      if (request.method !== "POST") {
        reply(405, "POST only");
        return;
      }
      void readBody(request)
        .then(async (raw) => {
          const payload: unknown = raw.length > 0 ? JSON.parse(raw) : null;
          const name =
            payload && typeof payload === "object"
              ? safeLogFileName((payload as Record<string, unknown>).name)
              : null;
          const text =
            payload && typeof payload === "object"
              ? (payload as Record<string, unknown>).text
              : null;
          if (!name || typeof text !== "string") {
            reply(400, "bad payload");
            return;
          }
          await mkdir(devLogDirectory, { recursive: true });
          await writeFile(path.join(devLogDirectory, name), text, "utf8");
          reply(200, "ok");
        })
        .catch((error: unknown) => {
          reply(500, error instanceof Error ? error.message : "write failed");
        });
    });
  },
});

const battleDebugWriter = (): Plugin => ({
  name: "idle-civ-battle-debug",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const requestUrl = request.url ?? "/";
      const pathname = requestUrl.split("?")[0];
      if (pathname !== battleSeedsEndpoint) {
        next();
        return;
      }

      const reply = (status: number, body: string): void => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(body);
      };
      if (request.method !== "GET") {
        reply(405, JSON.stringify({ error: "GET only" }));
        return;
      }

      const battleId = new URL(requestUrl, "http://localhost").searchParams.get(
        "battleId",
      );
      if (!battleId || !/^[A-Za-z0-9_-]+$/.test(battleId)) {
        reply(400, JSON.stringify({ error: "invalid battleId" }));
        return;
      }

      void (async () => {
        const parsed: unknown = JSON.parse(
          await readFile(battleSeedFile, "utf8"),
        );
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("schemaVersion" in parsed) ||
          parsed.schemaVersion !== 1 ||
          !("seeds" in parsed) ||
          !Array.isArray(parsed.seeds)
        ) {
          throw new Error("battle seed file has an unsupported schema");
        }
        const seeds = parsed.seeds.flatMap((entry) => {
          if (
            !entry ||
            typeof entry !== "object" ||
            !("battleId" in entry) ||
            entry.battleId !== battleId ||
            !("playerArmy" in entry) ||
            !Array.isArray(entry.playerArmy)
          ) {
            return [];
          }
          return [{ playerArmy: entry.playerArmy }];
        });
        reply(
          200,
          JSON.stringify({ seeds, scanned: parsed.seeds.length }),
        );
      })().catch((error: unknown) => {
        console.error("[battle seeds] could not read static seed data", error);
        reply(500, JSON.stringify({ error: "could not read battle seed file" }));
      });
    });

    server.middlewares.use(battleDebugEndpoint, (request, response) => {
      const reply = (status: number, body: string): void => {
        response.statusCode = status;
        response.setHeader("Content-Type", "text/plain");
        response.end(body);
      };
      if (request.method === "POST") {
        void readBody(request)
          .then(async (raw) => {
            const payload: unknown = raw.length > 0 ? JSON.parse(raw) : null;
            const record =
              payload && typeof payload === "object"
                ? (payload as Record<string, unknown>)
                : {};
            const name = safeLogFileName(record.name);
            if (!name || typeof record.text !== "string") {
              reply(400, "bad payload");
              return;
            }
            await mkdir(battleDebugDirectory, { recursive: true });
            await writeFile(path.join(battleDebugDirectory, name), record.text, "utf8");
            reply(200, "ok");
          })
          .catch((error: unknown) => {
            reply(500, error instanceof Error ? error.message : "write failed");
          });
        return;
      }
      if (request.method === "GET") {
        const rawPath = request.url?.split("?")[0] ?? "";
        const requestedPath = rawPath.startsWith("/")
          ? rawPath
          : `/${rawPath}`;
        const requestedName = requestedPath.startsWith(battleDebugFilePrefix)
          ? requestedPath.slice(battleDebugFilePrefix.length)
          : requestedPath.slice(1);
        let decodedName: string | undefined;
        try {
          decodedName = requestedName ? decodeURIComponent(requestedName) : undefined;
        } catch {
          reply(400, "bad file name");
          return;
        }
        const name = safeLogFileName(decodedName);
        if (!name) {
          reply(400, "bad file name");
          return;
        }
        void readFile(path.join(battleDebugDirectory, name), "utf8")
          .then((text) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(text);
          })
          .catch(() => reply(404, "battle debug file not found"));
        return;
      }
      reply(405, "GET or POST only");
    });
  },
});

const runGit = (args: readonly string[]): string | null => {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout (CI tarball, zip download): the UI shows "dev".
    return null;
  }
};

/**
 * Build version stamped into the app via `define`: `git describe` when tags
 * exist, otherwise the short SHA (with a `-dirty` suffix when the tree is
 * modified), e.g. `v0.3.0-4-g989c077` or `989c077-dirty`. Start tagging
 * releases (`git tag v0.1.0`) and the version numbers itself from then on.
 */
const appVersion =
  runGit(["describe", "--tags", "--always", "--dirty"]) ?? "dev";
const appCommitDate = runGit(["log", "-1", "--format=%cs"]) ?? "";

// https://vite.dev/config/
export default defineConfig({
  // Relative base so one build serves both the GitHub Pages subpath
  // (https://<user>.github.io/idle-civ/) and a root-served LAN preview.
  base: "./",
  define: {
    __APP_BUILD_INFO__: JSON.stringify({
      version: appVersion,
      commitDate: appCommitDate,
    }),
  },
  plugins: [react(), devLogWriter(), battleDebugWriter()],
});
