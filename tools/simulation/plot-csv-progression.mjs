/**
 * Generate progression graphs from a snapshot CSV.
 *
 * Usage:
 *   node tools/simulation/plot-csv-progression.mjs <input.csv> [output.html] [milestones.txt]
 *
 * Resource series are included when their CSV columns are present. All charts
 * use a logarithmic simulated-time axis. The signed
 * progression chart uses a symmetric-log value scale to retain zero/negative
 * changes while compressing large swings.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, output = input?.replace(/\.csv$/i, ".html"), milestonesPath] =
  process.argv.slice(2);
if (!input || input.startsWith("-")) {
  console.error(
    "Usage: node tools/simulation/plot-csv-progression.mjs <input.csv> [output.html] [milestones.txt]",
  );
  process.exit(1);
}
const maxProgressionPercent = 1_000;
const minBonusProgressionPercent = -50;
const bonusSmoothingFrames = 5;
const lines = readFileSync(input, "utf8").trimEnd().split(/\r?\n/);
const header = lines[0].split(",");
const indexes = Object.fromEntries(header.map((key, index) => [key, index]));
const resourceColumns = [
  ["food", ["bld.farm.production"]],
  ["wood", ["bld.lumberYard.production"]],
  ["stone", ["bld.quarry.production"]],
  ["gold", ["bld.goldMine.production"]],
  ["science", ["bld.university.production"]],
  ["military", ["bld.barracks.production"]],
  ["trade", ["trade_power_rate", "bld.market.production"]],
  ["metalwork", ["bld.smithy.production"]],
];
const productionSeries = resourceColumns
  .map(([name, columns]) => ({
    name,
    columns: columns.filter((column) => indexes[column] !== undefined),
  }))
  .filter(({ columns }) => columns.length);
const resourceKeys = productionSeries.map(({ name }) => name);
const bonusKeys = header.filter((key) => /^bld\..+\.bonus$/.test(key));
for (const required of [
  "sim_seconds",
  "population",
  "army_power_total",
  "research_bought",
]) {
  if (indexes[required] === undefined) {
    throw new Error(`Missing required CSV column: ${required}`);
  }
}

const rows = lines
  .slice(1)
  .map((line) => {
    const cells = line.split(",");
    return {
      time: Number(cells[indexes.sim_seconds]),
      population: Number(cells[indexes.population]),
      armyPower:
        indexes.army_power_total === undefined
          ? NaN
          : Number(cells[indexes.army_power_total]),
      researchCount:
        indexes.research_bought === undefined
          ? NaN
          : Number(cells[indexes.research_bought]),
      productions: Object.fromEntries(
        productionSeries.map(({ name, columns }) => [
          name,
          columns.reduce((sum, column) => {
            const value = Number(cells[indexes[column]]);
            return sum + (Number.isFinite(value) ? value : 0);
          }, 0),
        ]),
      ),
      resourceBonuses: Object.fromEntries(
        resourceKeys.map((key) => [key, { percent: 0, flat: 0 }]),
      ),
    };
  })
  .filter((row) => Number.isFinite(row.time));
if (!rows.length) throw new Error("No valid time rows in CSV");

const maxTime = rows.at(-1).time;
const timeStart = 60;
const milestones = (milestonesPath ? readFileSync(milestonesPath, "utf8") : "")
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(
      /^\S+\s+(.+?)\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$/,
    );
    if (!match || (!match[2] && !match[3] && !match[4])) return null;
    const time =
      Number(match[2] ?? 0) * 3600 +
      Number(match[3] ?? 0) * 60 +
      Number(match[4] ?? 0);
    return { time, label: match[1].trim() };
  })
  .filter(
    (milestone) =>
      milestone !== null &&
      milestone.time >= timeStart &&
      milestone.time <= maxTime,
  );
const validPopulation = rows.filter(
  (row) =>
    row.time >= timeStart &&
    Number.isFinite(row.population) &&
    row.population >= 0,
);
for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
  const cells = lines[rowIndex + 1].split(",");
  for (const key of bonusKeys) {
    const text = cells[indexes[key]] ?? "";
    for (const match of text.matchAll(
      /(?:^|\|)(food|wood|stone|gold|science|military|trade|metalwork)=\+([^|]+)/g,
    )) {
      const value = rows[rowIndex].resourceBonuses[match[1]];
      if (match[2].endsWith("%")) {
        value.percent += Number(match[2].slice(0, -1));
      } else if (match[2].endsWith("/s")) {
        value.flat += Number(match[2].slice(0, -2));
      }
    }
  }
}
const smoothSeries = (points, valueKey) =>
  points.map((point, index) => {
    const halfWindow = Math.floor(bonusSmoothingFrames / 2);
    const start = Math.max(
      0,
      Math.min(index - halfWindow, points.length - bonusSmoothingFrames),
    );
    const window = points.slice(start, start + bonusSmoothingFrames);
    return {
      ...point,
      [valueKey]:
        window.reduce((sum, frame) => sum + frame[valueKey], 0) / window.length,
    };
  });
const smoothFilteredProgression = (points) =>
  points
    .map((point, index) => {
      const start = Math.max(0, index - Math.floor(bonusSmoothingFrames / 2));
      const end = Math.min(points.length, start + bonusSmoothingFrames);
      const window = points
        .slice(start, end)
        .filter(
          (frame) =>
            frame.value >= minBonusProgressionPercent &&
            frame.value <= maxProgressionPercent,
        );
      return window.length
        ? {
            ...point,
            value:
              window.reduce((sum, frame) => sum + frame.value, 0) /
              window.length,
          }
        : null;
    })
    .filter((point) => point !== null);
const smoothedPopulation = smoothSeries(validPopulation, "population");
const smoothedProductions = Object.fromEntries(
  productionSeries.map(({ name }) => {
    const points = smoothSeries(
      rows
        .filter(
          (row) =>
            row.time >= timeStart &&
            Number.isFinite(row.productions[name]) &&
            row.productions[name] > 0,
        )
        .map((row) => ({ time: row.time, value: row.productions[name] })),
      "value",
    );
    return [name, points];
  }),
);
const resourceProgressions = Object.fromEntries(
  resourceKeys.map((key) => {
    const raw = rows
      .map((row, index) => {
        const value = row.resourceBonuses[key];
        const previous = rows[index - 1]?.resourceBonuses[key];
        if (!value || !previous) {
          return null;
        }
        const percentChange =
          previous.percent > 0
            ? ((value.percent - previous.percent) / previous.percent) * 100
            : null;
        const flatChange =
          previous.flat > 0
            ? ((value.flat - previous.flat) / previous.flat) * 100
            : null;
        return {
          time: row.time,
          percentChange,
          flatChange,
        };
      })
      .filter((point) => point !== null && point.time >= timeStart);
    return [
      key,
      {
        percent: smoothFilteredProgression(
          raw
            .map((point) => ({
              time: point.time,
              value: point.percentChange,
            }))
            .filter((point) => Number.isFinite(point.value)),
        ),
        flat: smoothFilteredProgression(
          raw
            .map((point) => ({
              time: point.time,
              value: point.flatChange,
            }))
            .filter((point) => Number.isFinite(point.value)),
        ),
      },
    ];
  }),
);
const militaryPower = smoothSeries(
  rows
    .filter(
      (row) =>
        row.time >= timeStart &&
        Number.isFinite(row.armyPower) &&
        row.armyPower > 0,
    )
    .map((row) => ({ time: row.time, value: row.armyPower })),
  "value",
);
const researchCounts = smoothSeries(
  rows
    .filter(
      (row) => row.time >= timeStart && Number.isFinite(row.researchCount),
    )
    .map((row) => ({ time: row.time, value: row.researchCount })),
  "value",
);
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const format = (value) =>
  Number(value)
    .toPrecision(5)
    .replace(/\.?0+$/, "");
const left = 90;
const width = 1120;
const top = 55;
const height = 220;
const firstHourWidth = 0.25;
const firstHour = 3600;
const laterLogSpan = Math.log10(maxTime / firstHour);
const x = (time) => {
  if (time <= timeStart) return left;
  if (time <= firstHour || maxTime <= firstHour) {
    const fraction =
      Math.log10(time / timeStart) / (Math.log10(firstHour / timeStart) || 1);
    return left + fraction * firstHourWidth * width;
  }
  const laterFraction = Math.log10(time / firstHour) / (laterLogSpan || 1);
  return left + width * (firstHourWidth + (1 - firstHourWidth) * laterFraction);
};
const timeTicks = [
  60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 43200, 72000,
].filter((time) => time >= timeStart && time <= maxTime);
const timeAxis = (bottom) =>
  timeTicks
    .map((time) => {
      const position = x(time);
      const label =
        time < 3600 ? `${format(time / 60)}m` : `${format(time / 3600)}h`;
      return `<line x1="${position}" x2="${position}" y1="${top}" y2="${bottom}" stroke="#ddd" stroke-width=".7"/><text x="${position}" y="${bottom + 16}" text-anchor="middle" font-size="9">${label}</text>`;
    })
    .join("");
const markerPositions = new Map();
const markerRowXs = [];
const markerRowGap = 14;
for (const milestone of milestones) {
  const actualX = x(milestone.time);
  let row = markerRowXs.findIndex(
    (lastX) => lastX === undefined || actualX - lastX >= markerRowGap,
  );
  if (row < 0) row = markerRowXs.length;
  markerRowXs[row] = actualX;
  markerPositions.set(milestone, { actualX, row });
}
const milestoneMarkers = (bottom) =>
  milestones
    .map((milestone, index) => {
      const markerX = x(milestone.time);
      const position = markerPositions.get(milestone);
      const badgeY = top + 9 + position.row * 12;
      return `<g><line x1="${markerX}" x2="${markerX}" y1="${top}" y2="${bottom}" stroke="#777" stroke-width=".8" stroke-dasharray="3 3"/><circle cx="${markerX}" cy="${badgeY}" r="6" fill="#444"><title>${index + 1}. ${escape(milestone.label)} at ${format(milestone.time / 60)} simulated minutes</title></circle><text x="${markerX}" y="${badgeY + 2.5}" text-anchor="middle" font-size="7" fill="white">${index + 1}</text></g>`;
    })
    .join("");
const milestoneKey = (startY) =>
  milestones
    .map((milestone, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const keyX = left + column * 560;
      const keyY = startY + row * 18;
      return `<g><circle cx="${keyX + 6}" cy="${keyY - 3}" r="5" fill="#555"/><text x="${keyX + 6}" y="${keyY}" text-anchor="middle" font-size="7" fill="white">${index + 1}</text><text x="${keyX + 16}" y="${keyY}" font-size="9">${escape(milestone.label)} — ${format(milestone.time / 60)}m</text></g>`;
    })
    .join("");
const milestoneKeyHeight = Math.ceil(milestones.length / 2) * 18;
const timeAxisLabel = (bottom) =>
  `<text x="${left + width / 2}" y="${bottom + 28}" text-anchor="middle" font-size="12">Simulated time (log scale; first hour = 25% of plot)</text>`;
const panelBottom = top + height + 28;
const milestoneKeyStart = panelBottom + 38;
const panelStride = milestoneKeyStart + milestoneKeyHeight + 24;
const path = (points, getY) =>
  points
    .map(
      (point, index) =>
        `${index ? "L" : "M"} ${x(point.time).toFixed(2)} ${getY(point).toFixed(2)}`,
    )
    .join(" ");

const smoothedPopulationMin = Math.min(
  ...smoothedPopulation.map((point) => point.population),
);
const smoothedPopulationMax = Math.max(
  ...smoothedPopulation.map((point) => point.population),
);
const populationMin = smoothedPopulationMin;
const populationMax = smoothedPopulationMax;
const populationY = (point) =>
  top +
  height -
  ((point.population - smoothedPopulationMin) /
    (smoothedPopulationMax - smoothedPopulationMin || 1)) *
    height;
const populationGrid = Array.from({ length: 5 }, (_, index) => {
  const value = populationMax - ((populationMax - populationMin) * index) / 4;
  const y = top + (height * index) / 4;
  return `<line x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" stroke="#e6e6e6"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" font-size="11">${escape(format(value))}</text>`;
}).join("");
const panelLegendStart = milestoneKeyStart;
const populationPanel = `<g transform="translate(0 0)"><text x="${left}" y="28" font-size="18" font-weight="bold">Population (5-frame smooth)</text><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="#bbb"/>${populationGrid}${timeAxis(top + height)}<path d="${path(smoothedPopulation, populationY)}" fill="none" stroke="#3c7498" stroke-width="1.7"/>${milestoneMarkers(top + height)}${timeAxisLabel(top + height + 18)}${milestoneKey(panelLegendStart)}<text transform="translate(20 ${top + height / 2}) rotate(-90)" text-anchor="middle" font-size="12">Population</text></g>`;

const symlogConstant = 1;
const symlog = (value) =>
  Math.sign(value) * Math.log10(1 + Math.abs(value) / symlogConstant);
const resourcePanels = productionSeries.map(({ name }, index) => {
  const progression = resourceProgressions[name];
  const productionPoints = smoothedProductions[name];
  const productionValues = productionPoints.map((point) =>
    Math.log10(point.value),
  );
  const productionMin = Math.min(...productionValues);
  const productionMax = Math.max(...productionValues);
  const productionY = (point) =>
    top +
    height -
    ((Math.log10(point.value) - productionMin) /
      (productionMax - productionMin || 1)) *
      height;
  const productionGrid = Array.from({ length: 5 }, (_, gridIndex) => {
    const exponent =
      productionMax - ((productionMax - productionMin) * gridIndex) / 4;
    const gridY = top + (height * gridIndex) / 4;
    return `<line x1="${left}" x2="${left + width}" y1="${gridY}" y2="${gridY}" stroke="#e6e6e6"/><text x="${left - 8}" y="${gridY + 4}" text-anchor="end" font-size="11">10^${format(exponent)}</text>`;
  }).join("");
  const productionPanelForResource = `<g transform="translate(0 ${panelStride + index * 2 * panelStride})"><text x="${left}" y="28" font-size="18" font-weight="bold">${name} production over time (5-frame smooth; log scale)</text><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="#bbb"/>${productionGrid}${timeAxis(top + height)}<path d="${path(productionPoints, productionY)}" fill="none" stroke="#39804a" stroke-width="1.7"/>${milestoneMarkers(top + height)}${timeAxisLabel(top + height + 18)}${milestoneKey(panelLegendStart)}<text transform="translate(20 ${top + height / 2}) rotate(-90)" text-anchor="middle" font-size="12">${name} per second (log10)</text></g>`;
  const series = [
    {
      label: "multiplier bonus",
      points: progression.percent,
      color: "#8054a1",
    },
    {
      label: "flat production bonus",
      points: progression.flat,
      color: "#ba6b28",
    },
  ].filter((entry) => entry.points.length);
  const allPoints = series.flatMap((entry) => entry.points);
  const min = allPoints.length
    ? Math.min(...allPoints.map((point) => point.value))
    : 0;
  const max = allPoints.length
    ? Math.max(...allPoints.map((point) => point.value))
    : 0;
  const transformedMin = symlog(min);
  const transformedMax = symlog(max);
  const y = (point) =>
    top +
    height -
    ((symlog(point.value) - transformedMin) /
      (transformedMax - transformedMin || 1)) *
      height;
  const grid = Array.from({ length: 5 }, (_, gridIndex) => {
    const transformed =
      transformedMax - ((transformedMax - transformedMin) * gridIndex) / 4;
    const value =
      Math.sign(transformed) *
      symlogConstant *
      (10 ** Math.abs(transformed) - 1);
    const gridY = top + (height * gridIndex) / 4;
    return `<line x1="${left}" x2="${left + width}" y1="${gridY}" y2="${gridY}" stroke="#e6e6e6"/><text x="${left - 8}" y="${gridY + 4}" text-anchor="end" font-size="11">${format(value)}%</text>`;
  }).join("");
  const legend = series
    .map(
      (entry, legendIndex) =>
        `<text x="${left + 12 + legendIndex * 190}" y="${top + 15}" font-size="10" fill="${entry.color}">━ ${entry.label}</text>`,
    )
    .join("");
  const paths = series
    .map(
      (entry) =>
        `<path d="${path(entry.points, y)}" fill="none" stroke="${entry.color}" stroke-width="1.5"/>`,
    )
    .join("");
  const progressionPanelForResource = `<g transform="translate(0 ${2 * panelStride + index * 2 * panelStride})"><text x="${left}" y="28" font-size="18" font-weight="bold">${name} bonus progression (workers excluded; 5-frame smooth)</text><text x="${left + width}" y="28" text-anchor="end" font-size="11">Filtered: ${minBonusProgressionPercent}% ≤ change ≤ ${maxProgressionPercent}%</text><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="#bbb"/>${grid}${legend}${timeAxis(top + height)}${paths}${milestoneMarkers(top + height)}${timeAxisLabel(top + height + 18)}${milestoneKey(panelLegendStart)}<text transform="translate(20 ${top + height / 2}) rotate(-90)" text-anchor="middle" font-size="12">Bonus change per keyframe (%)</text></g>`;
  return `${productionPanelForResource}${progressionPanelForResource}`;
});
const positiveMilitaryPower = militaryPower.map((point) =>
  Math.log10(point.value),
);
const militaryLogMin = Math.min(...positiveMilitaryPower);
const militaryLogMax = Math.max(...positiveMilitaryPower);
const militaryPowerY = (point) =>
  top +
  height -
  ((Math.log10(point.value) - militaryLogMin) /
    (militaryLogMax - militaryLogMin || 1)) *
    height;
const militaryPowerGrid = Array.from({ length: 5 }, (_, index) => {
  const exponent =
    militaryLogMax - ((militaryLogMax - militaryLogMin) * index) / 4;
  const y = top + (height * index) / 4;
  return `<line x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" stroke="#e6e6e6"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" font-size="11">10^${format(exponent)}</text>`;
}).join("");
const militaryPowerPanel = militaryPower.length
  ? `<g transform="translate(0 ${(1 + 2 * productionSeries.length) * panelStride})"><text x="${left}" y="28" font-size="18" font-weight="bold">Military power (5-frame smooth; log scale)</text><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="#bbb"/>${militaryPowerGrid}${timeAxis(top + height)}<path d="${path(militaryPower, militaryPowerY)}" fill="none" stroke="#b44848" stroke-width="1.5"/>${milestoneMarkers(top + height)}${timeAxisLabel(top + height + 18)}${milestoneKey(panelLegendStart)}<text transform="translate(20 ${top + height / 2}) rotate(-90)" text-anchor="middle" font-size="12">Army power (log10)</text></g>`
  : "";
const researchMin = Math.min(...researchCounts.map((point) => point.value));
const researchMax = Math.max(...researchCounts.map((point) => point.value));
const researchY = (point) =>
  top +
  height -
  ((point.value - researchMin) / (researchMax - researchMin || 1)) * height;
const researchGrid = Array.from({ length: 5 }, (_, index) => {
  const value = researchMax - ((researchMax - researchMin) * index) / 4;
  const y = top + (height * index) / 4;
  return `<line x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" stroke="#e6e6e6"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" font-size="11">${format(value)}</text>`;
}).join("");
const researchPanel = researchCounts.length
  ? `<g transform="translate(0 ${(2 + 2 * productionSeries.length) * panelStride})"><text x="${left}" y="28" font-size="18" font-weight="bold">Research count (5-frame smooth; linear scale)</text><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="white" stroke="#bbb"/>${researchGrid}${timeAxis(top + height)}<path d="${path(researchCounts, researchY)}" fill="none" stroke="#356caa" stroke-width="1.5"/>${milestoneMarkers(top + height)}${timeAxisLabel(top + height + 18)}${milestoneKey(panelLegendStart)}<text transform="translate(20 ${top + height / 2}) rotate(-90)" text-anchor="middle" font-size="12">Researches bought</text></g>`
  : "";

const panelCount =
  1 +
  productionSeries.length * 2 +
  Number(Boolean(militaryPowerPanel)) +
  Number(Boolean(researchPanel));
const totalHeight = panelStride * panelCount;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Snapshot CSV progression graphs</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}svg{width:100%;height:auto;background:#fafafa}p{line-height:1.5}</style></head><body><h1>Snapshot CSV progression graphs</h1><p>Source: ${escape(input)}. Available panels: population, resource production and worker-excluded bonus progression, military power, and research count. Bonus changes below −50% or above ${maxProgressionPercent}% are filtered. Curves use a centered 5-frame moving average. Production and military power use logarithmic value scales; research count uses a linear scale. Time uses a logarithmic axis starting at 1 minute.</p><svg viewBox="0 0 1280 ${totalHeight}" role="img" aria-label="Progression graphs">${populationPanel}${resourcePanels.join("")}${militaryPowerPanel}${researchPanel}</svg></body></html>`;

writeFileSync(output, html);
console.log(`Created ${output}`);
console.log(
  `Rows=${rows.length}; population=${validPopulation.length}; resource panels=${productionSeries.map(({ name }) => `${name}:production-${smoothedProductions[name].length},multiplier-${resourceProgressions[name].percent.length},flat-${resourceProgressions[name].flat.length}`).join(",")}; military power=${militaryPower.length}; research=${researchCounts.length}; milestones=${milestones.length}`,
);
