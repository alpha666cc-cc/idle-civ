import fs from "fs";
import path from "path";

function toCamelCase(str) {
  return str.replace(/-([a-z0-9])/g, function (g) {
    return g[1].toUpperCase();
  });
}

const idList = [
  "building-count",
  "food-multiplier",
  "wood-multiplier",
  "stone-multiplier",
  "gold-multiplier",
  "food-hoarder",
  "wood-hoarder",
  "stone-hoarder",
  "gold-hoarder",
  "master-builder",
  "buildings-total",
  "offline-time",
  "active-time",
  "military-multiplier",
  "science-multiplier",
  "metalwork-multiplier",
  "science-hoarder",
  "military-hoarder",
  "metalwork-hoarder",
  "trade-multiplier",
  "anti-armor",
  "upgrade-count",
  "resource-amount",
  "resource-drain",
  "research-count",
  "click-count",
  "population",
  "active-time", // population has no hyphen, but just in case
]
  .filter((x) => x.includes("-"))
  .sort((a, b) => b.length - a.length);

console.log("IDs to replace:", idList);

function replaceInFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  let changed = false;

  idList.forEach((id) => {
    const camel = toCamelCase(id);
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
