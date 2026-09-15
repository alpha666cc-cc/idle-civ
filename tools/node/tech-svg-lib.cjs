const fs = require('fs');

function loadTechs(path) {
  var techs;
  try { techs = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { console.error('INVALID JSON (' + path + '): ' + e.message); process.exit(1); }
  if (!Array.isArray(techs) || techs.length === 0) {
    console.error(path + ' is not a non-empty array');
    process.exit(1);
  }
  return techs;
}

function indexById(techs) {
  var m = new Map();
  techs.forEach(function(t) { m.set(t.id, t); });
  return m;
}

function computeDepth(techs, byId) {
  var depth = new Map();
  function getDepth(id) {
    if (depth.has(id)) return depth.get(id);
    var t = byId.get(id);
    if (!t || !t.prerequisites || t.prerequisites.length === 0) { depth.set(id, 0); return 0; }
    var d = 0;
    t.prerequisites.forEach(function(p) { d = Math.max(d, getDepth(p) + 1); });
    depth.set(id, d); return d;
  }
  techs.forEach(function(t) { getDepth(t.id); });
  return depth;
}

function layerByAgeDepth(techs, depth) {
  var byLayer = new Map();
  techs.forEach(function(t) {
    var layer = depth.get(t.id) || 0;
    var key = t.age + ':' + layer;
    if (!byLayer.has(key)) byLayer.set(key, []);
    byLayer.get(key).push(t);
  });
  var layerOrder = [];
  byLayer.forEach(function(arr, key) { layerOrder.push(key); });
  layerOrder.sort(function(a,b) {
    var aA = a.split(':')[0], aB = b.split(':')[0];
    var aL = a.split(':')[1], bL = b.split(':')[1];
    if (aL !== bL) return aL - bL;
    return aA - aB;
  });
  return { byLayer: byLayer, layerOrder: layerOrder };
}

var NODE_W = 170;
var NODE_H = 120;
var EFFECT_LINE_H = 12;
var EFFECT_LINES = 4;
var COL_GAP = 30;
var LEFT_MARGIN = 110;
var TOP_MARGIN = 140;
var RIGHT_MARGIN = 40;
var BOTTOM_MARGIN = 40;
var LEVEL_H = NODE_H + 50;

function computePositions(byLayer, layerOrder) {
  var positions = new Map();
  var runningX = LEFT_MARGIN;
  layerOrder.forEach(function(key) {
    var arr = byLayer.get(key);
    var layer = Number(key.split(':')[1]);
    arr.forEach(function(t, i) {
      var x = runningX;
      var y = TOP_MARGIN + layer * LEVEL_H + i * (NODE_H + 22);
      positions.set(t.id, { x: x, y: y, age: Number(key.split(':')[0]), layer: layer, idx: i });
    });
    runningX += NODE_W + COL_GAP;
  });
  var maxX = 0, maxY = 0;
  positions.forEach(function(p) {
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  });
  var W = Math.max(maxX + NODE_W + RIGHT_MARGIN, 1400);
  var H = Math.max(maxY + NODE_H + BOTTOM_MARGIN, 1000);
  return { positions: positions, W: W, H: H };
}

var EFFECT_CODE = {
  production_multiplier:'PM', building_cost_reduction:'BCR', resource_capacity:'Cap',
  cost_reduction:'Cost-', upkeep_reduction:'Upkeep-', building_capacity:'BldgCap',
  unlock_unit:'UnlUnit', unit_stat_boost:'Unit+', convert_unit:'Conv',
  global_production:'GlobProd', research_speed:'ResSpd', click_power:'Click+',
  worker_efficiency:'WorkEff', special_ability:'Special', offline_efficiency:'OffEffic',
  offline_cap:'OffCap', enhancer_scaling:'EnhScale', population_growth:'PopGrow'
};
var CAT_COLOR = { civilian:'#e8d9b5', military:'#c9d6ef' };
var CAT_STROKE = { civilian:'#9c7a3a', military:'#3f5a8a' };
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function effectLines(t) {
  var out = [];
  if (!t.effects || t.effects.length === 0) {
    out.push({ code:'none', tgt:'(none)', val:'' });
    return out;
  }
  t.effects.slice(0, EFFECT_LINES).forEach(function(e) {
    out.push({
      code: EFFECT_CODE[e.type] || e.type,
      tgt: (e.target || '?').slice(0,16),
      val: (e.value != null ? String(e.value) : '?')
    });
  });
  return out;
}

var ageNames = ['Ancient','Iron','Classical','Middle Ages','Renaissance','Industrial','Modern/Space'];

module.exports = {
  loadTechs: loadTechs,
  indexById: indexById,
  computeDepth: computeDepth,
  layerByAgeDepth: layerByAgeDepth,
  computePositions: computePositions,
  EFFECT_CODE: EFFECT_CODE,
  CAT_COLOR: CAT_COLOR,
  CAT_STROKE: CAT_STROKE,
  esc: esc,
  effectLines: effectLines,
  NODE_W: NODE_W,
  NODE_H: NODE_H,
  EFFECT_LINE_H: EFFECT_LINE_H,
  EFFECT_LINES: EFFECT_LINES,
  COL_GAP: COL_GAP,
  LEFT_MARGIN: LEFT_MARGIN,
  TOP_MARGIN: TOP_MARGIN,
  RIGHT_MARGIN: RIGHT_MARGIN,
  BOTTOM_MARGIN: BOTTOM_MARGIN,
  LEVEL_H: LEVEL_H,
  ageNames: ageNames
};
