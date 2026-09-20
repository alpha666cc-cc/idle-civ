const state = {
  battles: [],
  units: [],
  battle: null,
  selected: new Set(),
};

const $ = (id) => document.getElementById(id);
const battlesElement = $("battles");
const unitsElement = $("units");
const unitsSection = $("units-section");
const enemyElement = $("enemy");
const statusElement = $("simulation-status");
const resultsSection = $("results-section");
const resultsElement = $("results");
const resultsStatusElement = $("results-status");

const unitById = (id) => state.units.find((unit) => unit.id === id);
const iconUrl = (unit) => `/public/units/${unit.id}.svg`;
const typeLabel = (unit) =>
  [unit.domain, ...(unit.tags ?? []).slice(0, 2)].join(" · ");

const candidateUnits = (battle) => {
  const ageBattles = state.battles.filter(({ age }) => age === battle.age);
  const ordinal = ageBattles.findIndex(({ key }) => key === battle.key);
  const current = state.units.filter(
    (unit) => unit.costs?.length && unit.age === battle.age,
  );
  const previous = state.units.filter(
    (unit) => unit.costs?.length && unit.age === battle.age - 1,
  );
  if (battle.age === 0 && ordinal === 0) {
    return state.units.filter((unit) => unit.id === "warrior");
  }
  if (battle.isBoss) return [...previous, ...current];
  if (ordinal === 0) return [...previous, ...current.slice(0, 2)];
  if (ordinal === 1)
    return [...previous, ...current.slice(0, Math.ceil(current.length / 2))];
  return [...previous, ...current];
};

const defaultSelection = (battle) =>
  new Set(
    candidateUnits(battle)
      .filter((unit) => unit.age === battle.age - 1 || unit.id === "warrior")
      .map((unit) => unit.id),
  );

const renderResults = (result) => {
  const composition = result.composition
    .map(
      (unit) => `
        <article class="result-unit">
          <img src="${iconUrl(unit)}" alt="" class="result-unit-art" onerror="this.hidden=true">
          <div><strong>${unit.name}</strong><small>${unit.id}</small></div>
          <b>×${unit.count}</b>
        </article>`,
    )
    .join("");
  const costs = result.costs
    .map(
      (cost) =>
        `<div class="result-cost"><span>${cost.resource}</span><strong>${cost.amount}</strong></div>`,
    )
    .join("");
  resultsElement.innerHTML = `
    <div class="result-summary">
      <div><span class="eyebrow">Winning composition</span><strong>${result.battle}</strong></div>
      <div class="result-budget"><span>Military budget</span><b>${result.military}</b></div>
    </div>
    <div class="result-units">${composition}</div>
    <div class="result-costs"><span class="eyebrow">Total resources</span>${costs}</div>
  `;
};

const renderBattleCards = () => {
  $("battle-count").textContent = `${state.battles.length} encounters`;
  battlesElement.replaceChildren();
  state.battles.forEach((battle, index) => {
    const card = document.createElement("label");
    card.className = `battle-card${state.battle?.key === battle.key ? " selected" : ""}`;
    card.innerHTML = `
      <input type="radio" name="battle" value="${battle.key}" ${state.battle?.key === battle.key ? "checked" : ""}>
      <span class="card-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="card-copy">
        <strong>${battle.name}</strong>
        <small>Age ${battle.age} · ${battle.isBoss ? "Age boss" : "Skirmish"}</small>
        <small>${battle.enemyArmy.length} enemy stacks · year ${battle.year}</small>
      </span>
      <span class="card-total">${battle.enemyArmy.reduce((sum, stack) => sum + stack.count, 0)}</span>
    `;
    card
      .querySelector("input")
      .addEventListener("change", () => selectBattle(battle));
    battlesElement.append(card);
  });
};

const renderEnemy = () => {
  enemyElement.innerHTML = `
    <div><span class="eyebrow">Enemy force</span><strong>${state.battle.name}</strong></div>
    <div class="enemy-stacks">${state.battle.enemyArmy
      .map((stack) => {
        const unit = unitById(stack.unitId);
        return `<span><img src="${iconUrl(unit)}" alt="">${unit?.name ?? stack.unitId} ×${stack.count}</span>`;
      })
      .join("")}</div>
  `;
};

const renderUnits = () => {
  const candidates = candidateUnits(state.battle);
  $("unit-count").textContent =
    `${state.selected.size} of ${candidates.length} selected`;
  unitsElement.replaceChildren();
  candidates.forEach((unit) => {
    const card = document.createElement("label");
    card.className = `unit-card${state.selected.has(unit.id) ? " selected" : ""}`;
    card.innerHTML = `
      <input type="checkbox" value="${unit.id}" ${state.selected.has(unit.id) ? "checked" : ""}>
      <img src="${iconUrl(unit)}" alt="" class="unit-art" onerror="this.hidden=true">
      <span class="unit-copy"><strong>${unit.name}</strong><small>Age ${unit.age} · ${typeLabel(unit)}</small></span>
      <span class="unit-stats"><small>${unit.hp} HP</small><small>${unit.attack} ATK</small></span>
    `;
    card.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(unit.id);
      else state.selected.delete(unit.id);
      renderUnits();
      renderStatus();
    });
    unitsElement.append(card);
  });
};

const renderStatus = () => {
  if (!state.battle || state.selected.size === 0) {
    statusElement.textContent = "Select a battle and at least one unit.";
    return;
  }
  statusElement.textContent = `${state.selected.size} unit types ready for simulation.`;
};

const selectBattle = (battle) => {
  state.battle = battle;
  state.selected = defaultSelection(battle);
  resultsSection.classList.add("is-hidden");
  resultsElement.textContent = "";
  resultsStatusElement.textContent = "";
  unitsSection.classList.remove("is-hidden");
  renderBattleCards();
  renderEnemy();
  renderUnits();
  renderStatus();
  unitsSection.scrollIntoView({ behavior: "smooth", block: "start" });
};

$("select-all").addEventListener("click", () => {
  if (!state.battle) return;
  candidateUnits(state.battle).forEach((unit) => state.selected.add(unit.id));
  renderUnits();
  renderStatus();
});

$("clear-all").addEventListener("click", () => {
  state.selected.clear();
  renderUnits();
  renderStatus();
});

$("launch-simulation").addEventListener("click", async () => {
  if (!state.battle || state.selected.size === 0) return;
  const button = $("launch-simulation");
  const candidates = candidateUnits(state.battle);
  const excludedIndexes = candidates.reduce((excluded, unit, index) => {
    if (!state.selected.has(unit.id)) excluded.push(index);
    return excluded;
  }, []);
  button.disabled = true;
  button.textContent = "Simulating...";
  resultsSection.classList.remove("is-hidden");
  resultsStatusElement.textContent = "Running";
  resultsElement.innerHTML =
    '<div class="result-loading">The solver is searching for the lowest military cost...</div>';
  resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        battleIndex: state.battles.indexOf(state.battle),
        excludedIndexes,
        requireMixed: state.selected.size >= 2,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Simulation failed.");
    resultsStatusElement.textContent = "Complete";
    renderResults(result);
  } catch (error) {
    resultsStatusElement.textContent = "Error";
    resultsElement.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Launch simulation";
  }
});

const load = async () => {
  const [battleResponse, unitResponse] = await Promise.all([
    fetch("/src/game/data/encounters.json"),
    fetch("/src/game/data/units.json"),
  ]);
  state.battles = await battleResponse.json();
  state.units = await unitResponse.json();
  renderBattleCards();
};

load().catch((error) => {
  battlesElement.textContent = `Could not load game data: ${error.message}`;
});
