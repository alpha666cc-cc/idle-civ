const fs = require("fs");
const path = require("path");
const dir = "src/game/data";
fs.readdirSync(dir).forEach((f) => {
  const c = fs.readFileSync(path.join(dir, f), "utf8");
  const m = c.match(/"(id|key)":\s*"[^"]+"/g);
  if (m) {
    m.forEach((x) => {
      if (x.includes("-")) console.log(f, x);
    });
  }
});
