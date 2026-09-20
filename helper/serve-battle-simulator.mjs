import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4174);
const types = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const runSimulation = (body) =>
  new Promise((resolve, reject) => {
    const battleIndex = Number(body.battleIndex);
    const excludedIndexes = Array.isArray(body.excludedIndexes)
      ? body.excludedIndexes.join(",")
      : "";
    const mode = body.requireMixed === false ? "solo" : "mixed";
    if (!Number.isInteger(battleIndex) || battleIndex < 0) {
      reject(new Error("A valid battle is required."));
      return;
    }
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(root, "temp/min-army.mjs"),
        String(battleIndex),
        excludedIndexes,
        mode,
      ],
      { cwd: root },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) {
        const compositionSection =
          output.split("=== Minimum army to defeat ")[1] ?? "";
        const [battle, remainder] = compositionSection.split(" ===\n");
        const composition = [];
        for (const line of remainder?.split("\n") ?? []) {
          const match = line.match(/^  (.+) \(([^)]+)\) x(.+)$/);
          if (match)
            composition.push({ name: match[1], id: match[2], count: match[3] });
        }
        const costs = [];
        const costSection = output.split("Total cost:\n")[1] ?? "";
        for (const line of costSection.split("\n")) {
          const match = line.match(/^  ([a-z]+): (.+)$/);
          if (match) costs.push({ resource: match[1], amount: match[2] });
        }
        const military =
          output.match(/Military \(optimized\): (.+)/)?.[1] ?? "-";
        resolve({ battle: battle ?? "Battle", composition, costs, military });
      } else reject(new Error(error || `Simulation exited with code ${code}.`));
    });
  });

createServer(async (request, response) => {
  if (request.url === "/api/simulate" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      try {
        const result = await runSimulation(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }
  const requested =
    request.url === "/" ? "/helper/battle-simulator.html" : request.url;
  const filePath = normalize(join(root, requested.split("?")[0]));
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(
    `Battle helper: http://127.0.0.1:${port}/helper/battle-simulator.html`,
  );
});
