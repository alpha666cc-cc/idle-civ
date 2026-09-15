const fs = require('fs');
const s = fs.readFileSync('./temp/tech tree-v1-effects.json','utf8');
let j;
try { j = JSON.parse(s) } catch(e) { console.error('INVALID JSON: ' + e.message); process.exit(1); }
if (!Array.isArray(j)) {
  console.log('TOP: not-array. keys=' + Object.keys(j).join(', '));
  console.log('sample: ' + JSON.stringify(j).slice(0,500));
  process.exit(0);
}
console.log('TOP: array, length=' + j.length);
const r = j[0];
console.log('FIRST_ENTRY_KEYS=' + Object.keys(r).join(', '));
console.log('--- first entry ---');
console.log(JSON.stringify(r, null, 2));
console.log('--- categories present ---');
const cats = new Set(j.map(e => e.category).filter(Boolean));
console.log('categories=' + [...cats].join(', '));
console.log('--- ages present ---');
const ages = new Set(j.map(e => String(e.age)).filter(Boolean));
console.log('ages=' + [...ages].sort((a,b)=>a-b).join(', '));
console.log('--- types of effects ---');
const etypes = new Set();
const allEff = j.map(e => e.effects).filter(Boolean).flat();
allEff.forEach(e => { if (e && e.type) etypes.add(e.type); });
console.log('effect_types=' + [...etypes].join(', '));
console.log('total_techs=' + j.length);
console.log('total_effects=' + allEff.length);
console.log('done');
