var fs = require('fs');
var L = require('./tech-svg-lib.cjs');

var techs = L.loadTechs('./temp/tech tree-v1-effects.json');
var byId = L.indexById(techs);
var depth = L.computeDepth(techs, byId);
var lay = L.layerByAgeDepth(techs, depth);
var pos = L.computePositions(lay.byLayer, lay.layerOrder);

var parts = [];
function add(s) { parts.push(s); }

add('<?xml version="1.0" encoding="UTF-8"?>');
add('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + pos.W + ' ' + pos.H + '" width="' + pos.W + '" height="' + pos.H + '" font-family="Manrope, Segoe UI, Arial, sans-serif">');
add('<rect x="0" y="0" width="' + pos.W + '" height="' + pos.H + '" fill="#fbf7ef"/>');

// legend
var lx = L.LEFT_MARGIN;
add('<g id="legend" transform="translate(' + lx + ',20)">');
add('<rect x="0" y="0" width="320" height="96" fill="#fff" stroke="#c9bfa6" rx="6"/>');
add('<text x="10" y="18" style="font-size:13px;font-weight:600;fill:#2a2218">Legend</text>');
add('<rect x="10" y="28" width="14" height="14" fill="' + L.CAT_COLOR.civilian + '" stroke="' + L.CAT_STROKE.civilian + '" rx="2"/>');
add('<text x="28" y="40" style="font-size:11px;fill:#2a2218">civilian</text>');
add('<rect x="10" y="48" width="14" height="14" fill="' + L.CAT_COLOR.military + '" stroke="' + L.CAT_STROKE.military + '" rx="2"/>');
add('<text x="28" y="60" style="font-size:11px;fill:#2a2218">military</text>');
add('<line x1="10" y1="70" x2="310" y2="70" stroke="#c9bfa6"/>');
var codeY = 82;
var codeRows = Object.entries(L.EFFECT_CODE);
for (var ci = 0; ci < codeRows.length; ci += 2) {
  var row = codeRows.slice(ci, ci + 2);
  add('<text x="10" y=' + codeY + ' style="font-size:10px;fill:#5a4a32">' + L.esc(row.map(function(r){return r[1]+' '+r[0];}).join('   ')) + '</text>');
  codeY += 12;
}
add('</g>');

// age rail
lay.layerOrder.forEach(function(key, layerIdx) {
  var age = Number(key.split(':')[0]);
  var ageName = L.ageNames[age] || ('Age ' + age);
  var x = lx - 90;
  var y0 = L.TOP_MARGIN + layerIdx * L.LEVEL_H;
  var y1 = y0 + L.LEVEL_H - 22;
  add('<rect x="' + (x+2) + '" y="' + y0 + '" width="84" height="' + Math.max(1, y1-y0) + '" fill="rgba(40,30,20,0.05)" stroke="none"/>');
  add('<text x="' + (x+6) + '" y="' + (y0+13) + '" style="font-size:10px;font-weight:600;fill:#5a4a32">Age ' + age + '</text>');
  add('<text x="' + (x+6) + '" y="' + (y0+26) + '" style="font-size:9px;fill:#7a6a4a">' + L.esc(ageName) + '</text>');
});

// edges
var drawn = new Set();
techs.forEach(function(t) {
  var p = pos.positions.get(t.id);
  if (!p) return;
  if (!t.prerequisites || t.prerequisites.length === 0) return;
  t.prerequisites.forEach(function(pre) {
    var q = pos.positions.get(pre);
    if (!q) return;
    var key = pre + '->' + t.id;
    if (drawn.has(key)) return;
    drawn.add(key);
    var x1 = q.x + L.NODE_W / 2;
    var y1 = q.y + L.NODE_H;
    var x2 = p.x + L.NODE_W / 2;
    var y2 = p.y;
    add('<path d="M' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (y1+16).toFixed(1) + ' L' + x2.toFixed(1) + ',' + (y2-16).toFixed(1) + ' L' + x2.toFixed(1) + ',' + y2.toFixed(1) + '" fill="none" stroke="#7a6a4a" stroke-width="1" stroke-dasharray="3 3"/>');
    add('<polygon points="' + x2.toFixed(1) + ',' + (y2-1).toFixed(1) + ' ' + (x2-4).toFixed(1) + ',' + (y2-7).toFixed(1) + ' ' + (x2+4).toFixed(1) + ',' + (y2-7).toFixed(1) + '" fill="#7a6a4a"/>');
  });
});

// nodes
techs.forEach(function(t) {
  var p = pos.positions.get(t.id);
  if (!p) return;
  var x = p.x, y = p.y;
  var cat = t.category || 'civilian';
  var fill = L.CAT_COLOR[cat];
  var stroke = L.CAT_STROKE[cat];
  add('<rect x="' + x + '" y="' + y + '" width="' + L.NODE_W + '" height="' + L.NODE_H + '" rx="6" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.2"/>');
  add('<text x="' + (x+8) + '" y="' + (y+17) + '" style="font-size:12px;font-weight:600;fill:#2a2218">' + L.esc(t.name) + '</text>');
  add('<text x="' + (x+8) + '" y="' + (y+31) + '" style="font-size:9px;fill:#7a6a4a">' + L.esc(t.id) + '</text>');
  var ex = x + L.NODE_W + 12;
  var yy = y + 12;
  add('<text x="' + ex + '" y="' + yy + '" style="font-size:9px;font-weight:600;fill:#5a4a32">effects:</text>');
  yy += 13;
  L.effectLines(t).forEach(function(l) {
    add('<text x="' + ex + '" y="' + yy + '" style="font-size:10px;fill:#2a2218">' + L.esc(l.code) + ' ' + L.esc(l.tgt) + (l.val && l.val !== '?' ? ' ' + L.esc(l.val) : '') + '</text>');
    yy += L.EFFECT_LINE_H;
  });
  add('<text x="' + (x + L.NODE_W - 6) + '" y="' + (y + L.NODE_H - 6) + '" style="font-size:9px;fill:#7a6a4a" text-anchor="end">cost ' + L.esc(t.cost) + '</text>');
});

// footer
var totalEffects = techs.reduce(function(n,t){return n+(t.effects?t.effects.length:0);},0);
add('<text x="' + lx + '" y="' + (pos.H - 12) + '" style="font-size:10px;fill:#7a6a4a">Generated from ./temp/tech tree-v1-effects.json  -  ' + techs.length + ' techs, ' + totalEffects + ' effects  -  layout by (age, prerequisite depth)</text>');

add('</svg>');

var outPath = './temp/tech-tree-v1.svg';
fs.writeFileSync(outPath, parts.join('\n'), 'utf8');
var info = fs.statSync(outPath);
console.log('wrote ' + outPath);
console.log('size_bytes=' + info.size);
console.log('viewBox=' + pos.W + 'x' + pos.H);
console.log('techs=' + techs.length);
console.log('edges=' + drawn.size);
console.log('done');
