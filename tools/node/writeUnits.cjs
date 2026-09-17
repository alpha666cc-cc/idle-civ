const fs = require('fs');
const path = require('path');

const unitsPath = path.join(__dirname, '..', '..', 'src', 'game', 'data', 'units.json');
let u = JSON.parse(fs.readFileSync(unitsPath, 'utf8'));

// X so that 1000000 * X^14 = 19876313885
const legMil = 19876313885;
const X = Math.pow(legMil / 1000000, 1/14);

// New early unit costs
const earlyCosts = {
  warrior: [{resource:'military', base:200, factor:1.2}, {resource:'food', base:10000, factor:1.2}],
  slinger: [{resource:'military', base:500, factor:1.2}, {resource:'stone', base:20000, factor:1.2}],
  archer_prehist: [{resource:'military', base:2000, factor:1.2}, {resource:'wood', base:100000, factor:1.2}],
  canoe: [{resource:'military', base:50000, factor:1.2}, {resource:'wood', base:10000000, factor:1.2}],
  spearman_bronze: [{resource:'military', base:1000000, factor:1.2}, {resource:'metalwork', base:10000, factor:1.2}],
};

const remapSequence = [
  {id:'axeman_bronze', N:1}, {id:'chariot_bronze', N:2}, {id:'bowman_bronze', N:3},
  {id:'trireme_bronze', N:4}, {id:'catapult_ancient', N:5}, {id:'spearman_iron', N:6},
  {id:'swordsman_iron', N:7}, {id:'chariot_iron', N:8}, {id:'cavalry_iron', N:9},
  {id:'war_galley_iron', N:10}, {id:'elephant_iron', N:11}, {id:'ballista', N:12},
  {id:'quinquereme', N:13},
];

// Transform costs
u = u.map(unit => {
  if (earlyCosts[unit.id]) return { ...unit, costs: earlyCosts[unit.id] };
  const remap = remapSequence.find(r => r.id === unit.id);
  if (remap) {
    const milCost = 1000000 * Math.pow(X, remap.N);
    const costs = [
      {resource:'military', base: milCost, factor:1.2},
      {resource:'metalwork', base: milCost / 10, factor:1.2},
    ];
    if (unit.costs.some(c => c.resource === 'wood')) costs.push({resource:'wood', base: milCost * 2, factor:1.2});
    if (unit.costs.some(c => c.resource === 'food')) costs.push({resource:'food', base: milCost * 5, factor:1.2});
    return { ...unit, costs };
  }
  return unit;
});

// Assign tier numbers
let tier = 0;
u = u.map(unit => {
  if (unit.costs && unit.costs.length > 0) {
    tier++;
    delete unit.tier;
    unit.tier = tier;
  } else {
    delete unit.tier;
  }
  return unit;
});

// Build JSON
let json = '[\n';
for (let i = 0; i < u.length; i++) {
  const unit = u[i];
  json += '  {\n';
  
  const keys = Object.keys(unit).filter(k => k !== 'costs' && k !== 'tier');
  for (let j = 0; j < keys.length; j++) {
    const key = keys[j];
    const val = unit[key];
    const hasCosts = unit.costs && unit.costs.length > 0;
    const comma = (j < keys.length - 1 || hasCosts || unit.tier) ? ',' : '';
    if (typeof val === 'string') json += `    "${key}": "${val}"${comma}\n`;
    else if (typeof val === 'boolean') json += `    "${key}": ${val}${comma}\n`;
    else if (Array.isArray(val)) json += `    "${key}": ${JSON.stringify(val)}${comma}\n`;
    else if (val === null) json += `    "${key}": null${comma}\n`;
    else json += `    "${key}": ${val}${comma}\n`;
  }
  
  if (unit.tier) json += `    "tier": ${unit.tier}${unit.costs.length > 0 ? ',' : ''}\n`;
  
  if (unit.costs && unit.costs.length > 0) {
    json += '    "costs": [\n';
    for (let j = 0; j < unit.costs.length; j++) {
      const cost = unit.costs[j];
      const comma = j < unit.costs.length - 1 ? ',' : '';
      
      let baseStr, baseIsString = false;
      if (typeof cost.base === 'string') {
        baseStr = cost.base;
        baseIsString = true;
      } else if (typeof cost.base === 'number') {
        if (!isFinite(cost.base)) {
          baseStr = cost.base > 0 ? '1e308' : '-1e308';
          baseIsString = true;
        } else if (cost.base >= 1000000) {
          baseStr = cost.base.toExponential(4);
        } else {
          baseStr = cost.base.toString();
        }
      } else {
        baseStr = String(cost.base);
      }
      
      const baseOut = baseIsString ? `"${baseStr}"` : baseStr;
      json += `      {"resource": "${cost.resource}", "base": ${baseOut}, "factor": ${cost.factor}}${comma}\n`;
    }
    json += '    ]\n';
  }
  
  json += '  }';
  if (i < u.length - 1) json += ',';
  json += '\n';
}
json += ']';

fs.writeFileSync(unitsPath, json);
console.log('Done! Wrote', u.length, 'units with tiers and scientific notation');

// Verify
const parsed = JSON.parse(fs.readFileSync(unitsPath, 'utf8'));
console.log('\nVerification:');
console.log('Total units:', parsed.length);
const costUnits = parsed.filter(w => w.costs && w.costs.length > 0);
console.log('Units with costs:', costUnits.length);

console.log('\nFirst 10 units with costs:');
for (const unit of costUnits.slice(0, 10)) {
  console.log(`Tier ${unit.tier}: ${unit.id}`);
  for (const cost of unit.costs) {
    const display = typeof cost.base === 'number' && cost.base >= 1000000 
      ? cost.base.toExponential(4) : cost.base;
    console.log(`  ${cost.resource}: ${display} (${typeof cost.base})`);
  }
}

console.log('\nLarge value units:');
for (const id of ['quinquereme', 'legionary', 'bombard']) {
  const unit = parsed.find(w => w.id === id);
  if (unit) {
    console.log(`Tier ${unit.tier}: ${unit.id}`);
    for (const cost of unit.costs) {
      console.log(`  ${cost.resource}: ${cost.base} (${typeof cost.base})`);
    }
  }
}
