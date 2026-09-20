import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Building2,
  ChartColumn,
  Coins,
  Leaf,
  Pickaxe,
  Search,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Wheat,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BuildingDefinition } from "../game/buildings";
import type { EncounterDefinition } from "../game/encounters";
import {
  unitStatKeys,
  unitStatLabels,
  type UnitDefinition,
  type UnitStatKey,
} from "../game/units";
import type { AchievementDefinition } from "../game/achievements";
import type { Bonus } from "../game/bonus";
import type { UpgradeDefinition } from "../game/upgrades";
import { researchDefinitions, type ResearchDefinition } from "../game/research";
import type { CivilizationState } from "../game/civilizationState";
import {
  gamepedia,
  type GamepediaCategory,
  type GamepediaEntry,
} from "../game/gamepedia";
import {
  productionDefinitions,
  AttributeDefinition,
  type ProductionResourceKey,
  type ResourceFactor,
  type ResourceKey,
} from "../game/attributes";
import { ExpNumber } from "../game/expNumber";
import { formatNumber, type NumberFormat } from "../game/numberFormat";

type GamepediaModalProps = {
  gameState: CivilizationState;
  onClose: () => void;
  focusId?: string | null;
  numberFormat: NumberFormat;
};

type CategoryTab = {
  category: GamepediaCategory;
  label: string;
  icon: LucideIcon;
};

type FactorTab = "additional" | "multiplicative" | "drain";

const categoryTabs: CategoryTab[] = [
  { category: "resource", label: "Resources", icon: Leaf },
  { category: "building", label: "Buildings", icon: Building2 },
  { category: "unit", label: "Units", icon: Swords },
  { category: "upgrade", label: "Upgrades", icon: ArrowUpRight },
  { category: "achievement", label: "Achievements", icon: Trophy },
  { category: "stat", label: "Stats", icon: ChartColumn },
  { category: "research", label: "Research", icon: BookOpen },
  { category: "combat", label: "Battles", icon: Swords },
];

const categoryLabels: Record<GamepediaCategory, string> = {
  resource: "Resources",
  capacity: "Capacity",
  building: "Buildings",
  unit: "Units",
  upgrade: "Upgrades",
  achievement: "Achievements",
  stat: "Stats",
  research: "Research",
  combat: "Battles",
};

const factorTabLabels: Record<FactorTab, string> = {
  additional: "Add",
  multiplicative: "Mult",
  drain: "Drain",
};

const displayName = (object: { id: string }): string => {
  const definition = object as { id: string; name?: string; label?: string };
  return definition.name ?? definition.label ?? definition.id;
};

const capacityLabel = (buildingKey: string): string => {
  const entry = gamepedia.get(`${buildingKey}Capacity`);
  return entry ? displayName(entry.object) : `${buildingKey} capacity`;
};

const formatFactorValue = (
  tab: FactorTab,
  value: ExpNumber | number,
  format: NumberFormat,
): string => {
  const text = formatNumber(value, format);
  const positive = typeof value === "number" ? value > 0 : value.sign > 0;
  if (tab === "multiplicative") return `×${text}`;
  if (tab === "drain") return positive ? `−${text}` : text;
  return positive ? `+${text}` : text;
};

const factorSourceLabel = (source: ResourceFactor[0]): string =>
  source instanceof AttributeDefinition ? source.label : source;

const factorSourceId = (source: ResourceFactor[0]): string | undefined =>
  typeof source === "string" ? source : undefined;

/** Display name of a bonus destination (resource, capacity, building or stat id). */
const bonusDestinationName = (destination: string): string => {
  const entry = gamepedia.get(destination);
  return entry ? displayName(entry.object) : destination;
};

/** What a bonus modifies, e.g. "Food production" or "Click power". */
const bonusEffectLabel = (bonus: Bonus): string => {
  const destinationId = String(bonus.destination);
  const target = bonusDestinationName(destinationId);
  // A stat is a value in its own right, so its name alone reads best.
  if (gamepedia.get(destinationId)?.category === "stat") return target;
  switch (bonus.type) {
    case "attributeMultiplier":
      return `${target} production`;
    case "attributeFlat":
      return `${target} gain`;
    case "attributeDrain":
      return `${target} drain`;
    case "costReductionPercent":
      return `${target} cost`;
    case "costReductionFactor":
      return `${target} growth factor`;
    case "costReductionFlat":
      return `${target} cost`;
    case "costReductionBase":
      return `${target} base cost`;
    default:
      return target;
  }
};

/** The signed size of a bonus, e.g. "×1.25", "−50%" or "+2". */
const bonusValueText = (bonus: Bonus, format: NumberFormat): string => {
  switch (bonus.type) {
    case "attributeMultiplier":
      return `×${formatNumber(bonus.value, format)}`;
    case "costReductionPercent":
    case "costReductionBase":
      return `−${formatNumber(
        bonus.value.mul(ExpNumber.fromNumber(100)),
        format,
      )}%`;
    case "costReductionFactor":
      return `−${formatNumber(bonus.value.mul(ExpNumber.fromNumber(100)), format)} percentage points`;
    case "costReductionFlat":
      return `−${formatNumber(bonus.value, format)}`;
    case "attributeFlat":
      return `+${formatNumber(bonus.value, format)}`;
    case "attributeDrain":
      return `−${formatNumber(bonus.value, format)}`;
    default:
      return formatNumber(bonus.value, format);
  }
};

const factorSourceIcon = (source: ResourceFactor[0]): LucideIcon => {
  if (source instanceof AttributeDefinition) return Users;
  const normalizedSource = source.toLowerCase();
  if (normalizedSource.includes("lumber") || normalizedSource.includes("wood"))
    return Leaf;
  if (normalizedSource.includes("farm") || normalizedSource.includes("food"))
    return Wheat;
  if (normalizedSource.includes("quarry") || normalizedSource.includes("stone"))
    return Pickaxe;
  if (normalizedSource.includes("gold")) return Coins;
  if (
    normalizedSource.includes("science") ||
    normalizedSource.includes("academy")
  )
    return Sparkles;
  return Sparkles;
};

export default function GamepediaModal({
  gameState,
  onClose,
  focusId,
  numberFormat,
}: GamepediaModalProps) {
  const formatAmount = (amount: ExpNumber | number): string =>
    formatNumber(amount, numberFormat);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] =
    useState<GamepediaCategory>("resource");
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);

  const visibleEntries = query.trim()
    ? gamepedia.search(query)
    : gamepedia.visible();
  const selectedEntry = selectedId ? gamepedia.get(selectedId) : undefined;

  const categoryCount = (category: GamepediaCategory): number =>
    visibleEntries.filter(
      ({ category: entryCategory }) => entryCategory === category,
    ).length;

  const openEntry = (id: string) => setSelectedId(id);
  const goBack = () => setSelectedId(null);
  const selectCategory = (category: GamepediaCategory) => {
    setActiveCategory(category);
    setSelectedId(null);
  };

  const renderReference = (id: string, label?: string) => {
    const entry = gamepedia.get(id);
    if (!entry)
      return <span className="gamepedia-plain-ref">{label ?? id}</span>;
    return (
      <button
        type="button"
        className="gamepedia-ref-link"
        onClick={() => openEntry(id)}
        title={`Open ${displayName(entry.object)}`}
      >
        {label ?? displayName(entry.object)}
      </button>
    );
  };

  const renderRelated = (entry: GamepediaEntry) => {
    const related = gamepedia.relatedTo(entry.object.id);
    if (related.length === 0) return null;
    return (
      <div>
        <p className="gamepedia-category">Related</p>
        <div className="gamepedia-related-grid">
          {related.map(({ object }) => (
            <button
              type="button"
              className="gamepedia-related-chip"
              key={object.id}
              onClick={() => openEntry(object.id)}
              title={`Open ${displayName(object)}`}
            >
              <span>{displayName(object)}</span>
              <small>{object.id}</small>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderDetailHeader = (entry: GamepediaEntry) => (
    <div className="gamepedia-detail-header">
      <button
        type="button"
        className="gamepedia-back"
        onClick={goBack}
        aria-label="Back to gamepedia list"
      >
        <ArrowLeft size={15} />
      </button>
      <div>
        <p className="eyebrow">{categoryLabels[entry.category]}</p>
        <h3>{displayName(entry.object)}</h3>
      </div>
      <span className="gamepedia-detail-id">{entry.object.id}</span>
    </div>
  );

  const renderBuildingDetail = (entry: GamepediaEntry) => {
    const building = entry.object as BuildingDefinition;
    const count = gameState.getBuildingCount(building.key);
    const costs = gameState.getBuildingCost(building.key, count);
    const effects = gameState.getBuildingEffects(building.key);
    const totalEffects = gameState.getBuildingEffects(building.key, count);
    const parameters = gameState.getBuildingCostParameters(building.key);
    const { sources, reductions, globalMultiplier } =
      gameState.getBuildingCostModifiers(building.key);

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{building.description}</p>

        <p className="gamepedia-category">Price</p>
        <div className="gamepedia-cost-list">
          {costs.map(({ resource, base }) => {
            const factor = parameters.find(
              ({ cost }) => cost.resource === resource,
            )?.unitFactor;
            return (
              <div className="gamepedia-cost-row" key={resource}>
                <div className="gamepedia-cost-copy">
                  {renderReference(resource)}
                  {factor && (
                    <span className="gamepedia-cost-meta">
                      ×{formatAmount(factor)} each built (effective)
                    </span>
                  )}
                </div>
                <strong className="gamepedia-cost-next">
                  {formatAmount(base)} next
                </strong>
              </div>
            );
          })}
        </div>

        <p className="gamepedia-category">Cost reductions</p>
        <div className="gamepedia-recap">
          <p>
            Per building: base → growth → percentage → flat. Costs floor at 0;
            growth floors at 1.
          </p>
          <p>
            Base remaining:{" "}
            {formatAmount(reductions.base.mul(ExpNumber.fromNumber(100)))}%
          </p>
          <p>
            Growth reduction:{" "}
            {formatAmount(reductions.factor.mul(ExpNumber.fromNumber(100)))}{" "}
            percentage points
          </p>
          <p>
            Cost remaining after percentage reductions:{" "}
            {formatAmount(reductions.percent.mul(ExpNumber.fromNumber(100)))}%
          </p>
          <p>
            Flat reduction per cost resource: {formatAmount(reductions.flat)}
          </p>
          {parameters.map(({ cost, unitBase, unitFactor }) => (
            <div key={cost.resource}>
              {renderReference(cost.resource)}
              <p>
                Base: {formatAmount(cost.base)} → {formatAmount(unitBase)}
              </p>
              <p>
                Growth: ×{formatAmount(cost.factor)} → ×
                {formatAmount(unitFactor)}
              </p>
            </div>
          ))}
          <p>
            {renderReference("buildingCostMultiplier")}: ×
            {formatNumber(globalMultiplier, numberFormat)}
          </p>
          {sources.length === 0 && globalMultiplier.eq(ExpNumber.ONE) && (
            <p>No active cost reductions.</p>
          )}
          {sources.map(([source, bonus], index) => (
            <p key={`${source}-${index}`}>
              {renderReference(source)} — {bonusEffectLabel(bonus)}:{" "}
              {bonusValueText(bonus, numberFormat)}
            </p>
          ))}
        </div>

        <p className="gamepedia-category">Effects</p>
        <p className="gamepedia-recap">
          {renderReference(`${building.key}Power`)}: ×
          {formatAmount(gameState.getAttributeValue(`${building.key}Power`))}.
          Production and multiplier effects below include power; drains and
          capacity grants do not scale.
        </p>
        <div className="gamepedia-effect-list">
          {effects.resourceProduction && (
            <div className="gamepedia-effect-row">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.resourceProduction.resource)}
                <span className="gamepedia-effect-meta">
                  +{formatAmount(effects.resourceProduction.amount)}/s per
                  building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                +{formatAmount(totalEffects.resourceProduction!.amount)}/s now
              </strong>
            </div>
          )}
          {effects.resourceMultiplier ? (
            <div className="gamepedia-effect-row" key="multiplier">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.resourceMultiplier.resource)}
                <span className="gamepedia-effect-meta">
                  ×
                  {formatNumber(
                    effects.resourceMultiplier.factor,
                    numberFormat,
                  )}{" "}
                  gain per building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                ×
                {formatNumber(
                  totalEffects.resourceMultiplier!.factor,
                  numberFormat,
                )}{" "}
                now
              </strong>
            </div>
          ) : null}
          {effects.resourceDrain ? (
            <div className="gamepedia-effect-row" key="drain">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.resourceDrain.resource)}
                <span className="gamepedia-effect-meta">
                  {formatAmount(effects.resourceDrain.amount)}/s per building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                {formatAmount(totalEffects.resourceDrain!.amount)}
                /s now
              </strong>
            </div>
          ) : null}
          {effects.capacityProvided ? (
            <div className="gamepedia-effect-row" key="capacity">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.capacityProvided.building)}
                <span className="gamepedia-effect-meta">
                  +{formatAmount(effects.capacityProvided.perBuilding)}{" "}
                  {capacityLabel(effects.capacityProvided.building)} per
                  building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                +{formatAmount(totalEffects.capacityProvided!.perBuilding)} now
              </strong>
            </div>
          ) : null}
        </div>

        <p className="gamepedia-category">Capacity</p>
        <div className="gamepedia-effect-list">
          <div className="gamepedia-effect-row" key="capacity">
            <div className="gamepedia-effect-copy">
              {renderReference(`${building.key}Capacity`)}
              <span className="gamepedia-effect-meta">
                current capacity for this building
              </span>
            </div>
            <strong className="gamepedia-effect-total">
              {count} / {formatAmount(gameState.getBuildingMax(building.key))}
            </strong>
          </div>
        </div>

        {renderRelated(entry)}
      </div>
    );
  };
  const renderModifierRecap = (key: string, derived = false) => {
    const summary = gameState.getModifierSummary(key);
    const unit = derived ? "" : "/s";
    return (
      <div className="gamepedia-recap">
        {derived && <p>Base: {formatAmount(summary.base)}</p>}
        <p>
          Additions (sum): {formatAmount(summary.additional)}
          {unit}
        </p>
        <p>Multipliers (product): ×{formatAmount(summary.multiplier)}</p>
        <p>
          Drains (sum): {formatAmount(summary.drain)}
          {unit}
        </p>
        <p>
          {derived && `(${formatAmount(summary.base)} + `}
          {formatAmount(summary.additional)}
          {derived && ")"}
          {" × "}
          {formatAmount(summary.multiplier)} − {formatAmount(summary.drain)}
          {" = "}
          <strong>
            {formatAmount(summary.result)}
            {unit}
          </strong>
        </p>
      </div>
    );
  };

  const renderResourceDetail = (entry: GamepediaEntry) => {
    const key = entry.object.id as ResourceKey;
    const resources = gameState.resources as Record<string, ExpNumber>;
    const rate = gameState.computeResourceRate(key);
    const factors = gameState.getProductionFactors(key);
    const factorTabs: FactorTab[] = ["additional", "multiplicative", "drain"];
    const isPopulation = key === "population";
    const hasWorkers = productionDefinitions.some(
      ({ key: resourceKey }) => resourceKey === key,
    );
    const workerProduction = hasWorkers
      ? gameState.getWorkerProduction(key as ProductionResourceKey)
      : undefined;
    const multiplierProduct = gameState.getModifierSummary(key).multiplier;

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description}
        </p>

        {isPopulation ? (
          <>
            <div className="gamepedia-stats">
              <div className="gamepedia-stat">
                <span>Available workers</span>
                <strong>{gameState.availableWorkers}</strong>
              </div>
              <div className="gamepedia-stat">
                <span>All workers</span>
                <strong>{gameState.assignedWorkers}</strong>
              </div>
              <div className="gamepedia-stat">
                <span>Worker capacity</span>
                <strong>{formatAmount(gameState.maximumPopulation)}</strong>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="gamepedia-stats">
              <div className="gamepedia-stat">
                <span>Stored</span>
                <strong>{formatAmount(resources[key] ?? 0)}</strong>
              </div>
              <div className="gamepedia-stat">
                <span>Rate</span>
                <strong>
                  {rate.sign > 0 ? "+" : ""}
                  {formatAmount(rate)}/s
                </strong>
              </div>
            </div>
            <p className="gamepedia-category">Production</p>
            <div className="gamepedia-stats">
              {hasWorkers && workerProduction !== undefined && (
                <div className="gamepedia-stat">
                  <span>Workers</span>
                  <strong>
                    {formatNumber(workerProduction.workers, numberFormat)}
                  </strong>
                </div>
              )}
              {workerProduction !== undefined && (
                <>
                  <div className="gamepedia-stat">
                    <span>Base</span>
                    <strong>
                      {formatAmount(workerProduction.workerProduction)}/s
                    </strong>
                  </div>
                  <div className="gamepedia-stat">
                    <span>Auto</span>
                    <strong>
                      +{formatAmount(workerProduction.autoClickProduction)}/s
                    </strong>
                  </div>
                </>
              )}
              <div className="gamepedia-stat">
                <span>Multipliers</span>
                <strong>
                  {formatFactorValue(
                    "multiplicative",
                    multiplierProduct,
                    numberFormat,
                  )}
                </strong>
              </div>
            </div>

            <p className="gamepedia-category">Modifiers</p>
            {renderModifierRecap(key)}
            {factorTabs.map((tab) => {
              const group = factors[tab];
              if (group.length === 0) return null;
              return (
                <div key={tab}>
                  <p className="gamepedia-category">{factorTabLabels[tab]}</p>
                  <div className="factor-list">
                    {group.map(([source, value], index) => {
                      const sourceId = factorSourceId(source);
                      const entryForSource = sourceId
                        ? gamepedia.get(sourceId)
                        : undefined;
                      const Icon = factorSourceIcon(source);
                      return (
                        <div
                          className="factor-row"
                          key={`${sourceId ?? factorSourceLabel(source)}-${index}`}
                        >
                          <span className="factor-source-icon">
                            <Icon size={16} strokeWidth={1.8} />
                          </span>
                          {entryForSource ? (
                            <button
                              type="button"
                              className="factor-link"
                              onClick={() =>
                                openEntry(entryForSource.object.id)
                              }
                              title={`Open ${displayName(entryForSource.object)}`}
                            >
                              {factorSourceLabel(source)}
                            </button>
                          ) : (
                            <span className="factor-source">
                              {factorSourceLabel(source)}
                            </span>
                          )}
                          <strong>
                            {formatFactorValue(tab, value, numberFormat)}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {renderRelated(entry)}
      </div>
    );
  };
  const renderGenericDetail = (entry: GamepediaEntry) => (
    <div className="gamepedia-detail">
      {renderDetailHeader(entry)}
      <p className="gamepedia-detail-description">{entry.object.description}</p>
      {renderRelated(entry)}
    </div>
  );

  const renderCapacityDetail = (entry: GamepediaEntry) => {
    const resources = gameState.resources as Record<string, ExpNumber>;
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description}
        </p>
        <div className="gamepedia-stats">
          <div className="gamepedia-stat">
            <span>Current</span>
            <strong>{formatAmount(resources[entry.object.id] ?? 0)}</strong>
          </div>
        </div>
        {renderRelated(entry)}
      </div>
    );
  };

  const renderUpgradeDetail = (entry: GamepediaEntry) => {
    const upgrade = entry.object as UpgradeDefinition;

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description}
        </p>

        <p className="gamepedia-category">Cost</p>
        <div className="gamepedia-stats">
          {upgrade.costs.map(({ resource, base }) => (
            <div className="gamepedia-stat" key={resource}>
              <span>{renderReference(resource)}</span>
              <strong>{formatAmount(base)}</strong>
            </div>
          ))}
        </div>

        <p className="gamepedia-category">Effects</p>
        <div className="gamepedia-effect-list">
          {upgrade.bonuses.map((bonus, index) => (
            <div
              className="gamepedia-effect-row"
              key={`${bonus.type}-${bonus.destination}-${index}`}
            >
              <div className="gamepedia-effect-copy">
                <span className="gamepedia-effect-meta">
                  {bonusEffectLabel(bonus)}
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                {bonusValueText(bonus, numberFormat)}
              </strong>
            </div>
          ))}
        </div>

        {renderRelated(entry)}
      </div>
    );
  };

  const renderResearchDetail = (entry: GamepediaEntry) => {
    const research = entry.object as ResearchDefinition;
    const unlockedResearch = researchDefinitions.filter((candidate) =>
      candidate.prerequisites.includes(research.key),
    );

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description}
        </p>

        {research.prerequisites.length > 0 && (
          <>
            <p className="gamepedia-category">Prerequisites</p>
            <div className="gamepedia-reference-list">
              {research.prerequisites.map((id) => (
                <span key={id}>{renderReference(id)}</span>
              ))}
            </div>
          </>
        )}

        <p className="gamepedia-category">Cost</p>
        <div className="gamepedia-stats">
          {research.costs.map(({ resource, base }) => (
            <div className="gamepedia-stat" key={resource}>
              <span>{renderReference(resource)}</span>
              <strong>{formatAmount(base)}</strong>
            </div>
          ))}
        </div>

        {research.bonuses.length > 0 && (
          <>
            <p className="gamepedia-category">Effects</p>
            <div className="gamepedia-effect-list">
              {research.bonuses.map((bonus, index) => (
                <div
                  className="gamepedia-effect-row"
                  key={`${bonus.type}-${bonus.destination}-${index}`}
                >
                  <div className="gamepedia-effect-copy">
                    <span className="gamepedia-effect-meta">
                      {bonusEffectLabel(bonus)}
                    </span>
                  </div>
                  <strong className="gamepedia-effect-total">
                    {bonusValueText(bonus, numberFormat)}
                  </strong>
                </div>
              ))}
            </div>
          </>
        )}

        {research.unlocks.length > 0 && (
          <>
            <p className="gamepedia-category">Unlocks</p>
            <div className="gamepedia-reference-list">
              {research.unlocks.map((id) => (
                <span key={id}>{renderReference(id)}</span>
              ))}
            </div>
          </>
        )}

        {unlockedResearch.length > 0 && (
          <>
            <p className="gamepedia-category">Unlocks research</p>
            <div className="gamepedia-reference-list">
              {unlockedResearch.map((candidate) => (
                <span key={candidate.key}>
                  {renderReference(candidate.key, candidate.name)}
                </span>
              ))}
            </div>
          </>
        )}

        {renderRelated(entry)}
      </div>
    );
  };

  const renderAchievementDetail = (entry: GamepediaEntry) => {
    const achievement = entry.object as AchievementDefinition;
    const earned = gameState.isAchievementEarned(achievement.key);
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description.replaceAll("/sec", "/s")}
        </p>

        <p className="gamepedia-category">Record</p>
        <div className="gamepedia-stats">
          <div className="gamepedia-stat">
            <span>Status</span>
            <strong>{earned ? "Earned" : "Locked"}</strong>
          </div>
        </div>

        {achievement.bonuses.length > 0 && (
          <>
            <p className="gamepedia-category">Reward</p>
            <div className="gamepedia-effect-list">
              {achievement.bonuses.map((bonus, index) => (
                <div
                  className="gamepedia-effect-row"
                  key={`${bonus.type}-${bonus.destination}-${index}`}
                >
                  <div className="gamepedia-effect-copy">
                    <span className="gamepedia-effect-meta">
                      {bonusEffectLabel(bonus)}
                    </span>
                  </div>
                  <strong className="gamepedia-effect-total">
                    {bonusValueText(bonus, numberFormat)}
                  </strong>
                </div>
              ))}
            </div>
          </>
        )}

        {renderRelated(entry)}
      </div>
    );
  };

  const renderStatDetail = (entry: GamepediaEntry) => {
    const statKey = entry.object.id;
    const factors = gameState.getDerivedAttributeFactors(statKey);
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">
          {entry.object.description}
        </p>

        <p className="gamepedia-category">Current value</p>
        <div className="gamepedia-stats">
          <div className="gamepedia-stat">
            <span>Value</span>
            <strong>
              {statKey === "buildingCostMultiplier" && "×"}
              {formatNumber(gameState.getAttributeValue(statKey), numberFormat)}
            </strong>
          </div>
        </div>

        {factors && (
          <>
            <p className="gamepedia-category">Composition</p>
            {renderModifierRecap(statKey, true)}
            <div className="gamepedia-effect-list">
              <div className="gamepedia-effect-row" key="base">
                <div className="gamepedia-effect-copy">
                  <span className="gamepedia-effect-meta">Base value</span>
                </div>
                <strong className="gamepedia-effect-total">
                  {formatFactorValue("additional", factors.base, numberFormat)}
                </strong>
              </div>
              {factors.additional.map(([source, value], index) => {
                const sourceId = factorSourceId(source);
                return (
                  <div
                    className="gamepedia-effect-row"
                    key={`flat-${sourceId ?? index}`}
                  >
                    <div className="gamepedia-effect-copy">
                      <span className="gamepedia-effect-meta">
                        {sourceId !== undefined
                          ? renderReference(sourceId)
                          : factorSourceLabel(source)}
                      </span>
                    </div>
                    <strong className="gamepedia-effect-total">
                      {formatFactorValue("additional", value, numberFormat)}
                    </strong>
                  </div>
                );
              })}
              {factors.multiplicative.map(([source, value], index) => {
                const sourceId = factorSourceId(source);
                return (
                  <div
                    className="gamepedia-effect-row"
                    key={`mult-${sourceId ?? index}`}
                  >
                    <div className="gamepedia-effect-copy">
                      <span className="gamepedia-effect-meta">
                        {sourceId !== undefined
                          ? renderReference(sourceId)
                          : factorSourceLabel(source)}
                      </span>
                    </div>
                    <strong className="gamepedia-effect-total">
                      {formatFactorValue("multiplicative", value, numberFormat)}
                    </strong>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {renderRelated(entry)}
      </div>
    );
  };

  /** "Health 12 · Arm 25%" style text; fractions render as percentages. */
  const unitStatText = (
    key: UnitStatKey,
    value: ExpNumber | number,
  ): string => {
    if (key === "armor" || key === "accuracy") {
      return `${Math.round(Number(value) * 100)}%`;
    }
    return formatNumber(value, numberFormat);
  };

  const renderUnitDetail = (entry: GamepediaEntry) => {
    const unit = entry.object as UnitDefinition;
    const effective = gameState.getUnitStats(unit.key) ?? unit.stats;
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{unit.description}</p>
        <p className="gamepedia-category">
          Icon:{" "}
          <a href="https://game-icons.net/" target="_blank" rel="noreferrer">
            game-icons.net
          </a>{" "}
          (CC BY 3.0 — see public/units/ATTRIBUTION.md)
        </p>
        <p className="gamepedia-category">{unit.typeSummary}</p>
        <p className="gamepedia-category">
          Can hit: {unit.targetSummary || "—"}
        </p>
        <p className="gamepedia-category">Stats (current, bonuses applied)</p>
        <div className="gamepedia-stats">
          {unitStatKeys.map((key) => (
            <div className="gamepedia-stat" key={key}>
              <span>{unitStatLabels[key]}</span>
              <strong>{unitStatText(key, effective[key])}</strong>
            </div>
          ))}
        </div>
        {unit.costs.length > 0 ? (
          <>
            <p className="gamepedia-category">Base cost (next unit)</p>
            <div className="gamepedia-stats">
              {unit.costs.map(({ resource, base }) => (
                <div className="gamepedia-stat" key={resource}>
                  <span>{renderReference(resource)}</span>
                  <strong>{formatAmount(base)}</strong>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="gamepedia-category">Enemy-only unit</p>
        )}
        {renderRelated(entry)}
      </div>
    );
  };

  const renderBattleDetail = (entry: GamepediaEntry) => {
    const encounter = entry.object as EncounterDefinition;
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{encounter.description}</p>
        {encounter.historical && (
          <p className="gamepedia-detail-description">{encounter.historical}</p>
        )}
        <p className="gamepedia-category">Enemy army</p>
        <div className="gamepedia-effect-list">
          {encounter.enemyArmy.map((stack) => (
            <div className="gamepedia-effect-row" key={stack.unitId}>
              <div className="gamepedia-effect-copy">
                <span className="gamepedia-effect-meta">
                  {stack.label ?? renderReference(stack.unitId)}
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                ×{formatNumber(stack.count, numberFormat)}
              </strong>
            </div>
          ))}
        </div>
        <div className="gamepedia-stats">
          <div className="gamepedia-stat">
            <span>Year</span>
            <strong>{encounter.year}</strong>
          </div>
          <div className="gamepedia-stat">
            <span>Boss</span>
            <strong>{encounter.isBoss ? "Yes" : "No"}</strong>
          </div>
        </div>
        {renderRelated(entry)}
      </div>
    );
  };

  const renderDetail = (entry: GamepediaEntry) => {
    if (entry.category === "unit") return renderUnitDetail(entry);
    if (entry.category === "combat") return renderBattleDetail(entry);
    if (entry.category === "building") return renderBuildingDetail(entry);
    if (entry.category === "resource") return renderResourceDetail(entry);
    if (entry.category === "capacity") return renderCapacityDetail(entry);
    if (entry.category === "upgrade") return renderUpgradeDetail(entry);
    if (entry.category === "research") return renderResearchDetail(entry);
    if (entry.category === "achievement") return renderAchievementDetail(entry);
    if (entry.category === "stat") return renderStatDetail(entry);
    return renderGenericDetail(entry);
  };

  const renderList = () => {
    const listEntries = visibleEntries.filter(
      ({ category }) => category === activeCategory,
    );
    if (listEntries.length === 0) {
      return (
        <p className="gamepedia-empty">
          Nothing discovered here yet. Build and research to reveal new entries.
        </p>
      );
    }
    return (
      <div className="gamepedia-list">
        {listEntries.map(({ object }) => (
          <button
            type="button"
            className="gamepedia-row"
            key={object.id}
            onClick={() => openEntry(object.id)}
            title={`Open ${displayName(object)}`}
          >
            <span className="gamepedia-row-id">{object.id}</span>
            <strong>{displayName(object)}</strong>
            <small>{object.description}</small>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="gamepedia-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gamepedia-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="gamepedia-header">
          <div>
            <p className="eyebrow">Codex of the settlement</p>
            <h3 id="gamepedia-modal-title">Gamepedia</h3>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close gamepedia"
          >
            <X size={18} />
          </button>
        </header>

        <div className="gamepedia-search">
          <Search size={15} />
          <input
            type="search"
            placeholder="Search discoveries…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search gamepedia"
          />
        </div>

        <div
          className="gamepedia-tabs"
          role="tablist"
          aria-label="Gamepedia categories"
        >
          {categoryTabs.map(({ category, label, icon: Icon }) => {
            const count = categoryCount(category);
            return (
              <button
                type="button"
                key={category}
                role="tab"
                aria-selected={activeCategory === category}
                className={`gamepedia-tab ${activeCategory === category ? "active" : ""}`}
                onClick={() => selectCategory(category)}
              >
                <Icon size={13} strokeWidth={1.9} />
                <span>{label}</span>
                <em>{count}</em>
              </button>
            );
          })}
        </div>

        <div className="gamepedia-content">
          {selectedEntry ? renderDetail(selectedEntry) : renderList()}
        </div>
      </section>
    </div>
  );
}
