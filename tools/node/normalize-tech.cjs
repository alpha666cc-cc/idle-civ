const fs = require('fs');

// Deterministic 2-space JSON normalization, no trailing commas.
// Arrays are expanded across lines only when they are multi-item or contain
// nested objects/arrays (so a single primitive stays on one line).
function stringify(v, depth) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v);

  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map(x => stringify(x, depth + 1));
    const expand =
      v.length > 1 || v.some(x => x != null && typeof x === 'object');
    if (!expand) return '[' + items.join(', ') + ']';
    const pad = ' '.repeat(depth * 2);
    const inner = ' '.repeat((depth + 1) * 2);
    return '[\n' + items.map(s => inner + s).join(',\n') + '\n' + pad + ']';
  }

  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  const pairs = keys.map(k =>
    '\n' + ' '.repeat((depth + 1) * 2) + JSON.stringify(k) + ': ' + stringify(v[k], depth + 1)
  );
  const pad = ' '.repeat(depth * 2);
  return '{\n' + pairs.join(',\n') + '\n' + pad + '}';
}

function norm(path) {
  const txt = fs.readFileSync(path, 'utf8');
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch (e) {
    console.error(path + ': INVALID JSON — ' + e.message);
    return;
  }
  const out = stringify(obj) + '\n';
  fs.writeFileSync(path, out, 'utf8');
  const lines = out.split('\n').length - 1;
  console.log(path.split('/').pop() + ': ' + lines + ' lines');
}

norm('./temp/tech tree-v0.json');
norm('./temp/tech tree-v0-fixed.json');
console.log('done');
