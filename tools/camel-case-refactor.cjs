import fs from "fs";
import path from "path";

function toCamelCase(str) {
  return str.replace(/-([a-z0-9])/g, function (g) {
    return g[1].toUpperCase();
  });
}

// 1. First, identify all the dashed IDs
const dir = "src/game/data";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

let dashedIds = new Set();

files.forEach((f) => {
  const c = fs.readFileSync(path.join(dir, f), "utf8");
  // Match "key": "..." or "id": "..." or "destination": "..."
  const m = c.match(/"(?:id|key|destination|building|resource)":\s*"([^"]+)"/g);
  if (m) {
    m.forEach((x) => {
      const match = x.match(
        /"(?:id|key|destination|building|resource)":\s*"([^"]+)"/,
      );
      if (match && match[1].includes("-")) {
        dashedIds.add(match[1]);
      }
    });
  }
});

// Also include specific hardcoded dashed keys we know about
dashedIds.add("lumber-yard");
dashedIds.add("gold-mine");
dashedIds.add("town-hall");
dashedIds.add("lumber-yardCapacity");
dashedIds.add("gold-mineCapacity");
dashedIds.add("town-hallCapacity");
dashedIds.add("click-100"); // achievements etc
// Let's just collect ALL dashed identifiers we can find in the source code as well just to be safe?
// Actually, sorting the IDs by length (longest first) is safest for replacement.

let idList = Array.from(dashedIds).sort((a, b) => b.length - a.length);
console.log("IDs to replace:", idList);

function replaceInFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  let changed = false;

  idList.forEach((id) => {
    const camel = toCamelCase(id);
    // Replace exact matches in quotes (e.g. "lumber-yard" or 'lumber-yard')
    // We should also replace it in strings that might be part of string interpolation, e.g. `lumber-yard`
    // And in normal text (like comments) if we want, but let's stick to quotes for safety?
    // Actually, because it's a global refactor, we can replace the raw string `lumber-yard` with `lumberYard`
    // as long as it's an exact word match.
    // Wait, regex word boundary \b doesn't include hyphens!
    // So we can use negative lookarounds or just global string replace.
    const regex = new RegExp(
      `(?<=[\\s"'\\\`\\[\\]\\{\\}\\(\\):,])(${id})(?=[\\s"'\\\`\\[\\]\\{\\}\\(\\):,]|$)`,
      "g",
    );
    if (regex.test(content)) {
      content = content.replace(regex, camel);
      changed = true;
    }
  });

  if (changed) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`Updated ${filePath}`);
  }
}

function walkDir(dir) {
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      walkDir(file);
    } else {
      if (
        file.endsWith(".ts") ||
        file.endsWith(".tsx") ||
        file.endsWith(".json") ||
        file.endsWith(".md")
      ) {
        replaceInFile(file);
      }
    }
  });
}

walkDir("src");
walkDir("tools");
walkDir("docs");
