import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Building2,
  Coins,
  Leaf,
  Pickaxe,
  Search,
  Sparkles,
  Swords,
  Users,
  Wheat,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BuildingDefinition } from "../game/buildings";
import type { CivilizationState } from "../game/civilizationState";
import {
  gamepedia,
  type GamepediaCategory,
  type GamepediaEntry,
} from "../game/gamepedia";
import {
  resourceDefinitions,
  ResourceDefinition,
  type ProductionResourceKey,
  type ResourceFactor,
  type ResourceKey,
} from "../game/resources";
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
  { category: "upgrade", label: "Upgrades", icon: ArrowUpRight },
  { category: "research", label: "Research", icon: BookOpen },
  { category: "combat", label: "Combat", icon: Swords },
];

const categoryLabels: Record<GamepediaCategory, string> = {
  resource: "Resources",
  capacity: "Capacity",
  building: "Buildings",
  upgrade: "Upgrades",
  research: "Research",
  combat: "Combat",
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
  value: number,
): string =>
  tab === "multiplicative"
    ? `×${value}`
    : value > 0
      ? `+${value}`
      : `${value}`;

const factorSourceLabel = (source: ResourceFactor[0]): string =>
  source instanceof ResourceDefinition ? source.label : source;

const factorSourceId = (source: ResourceFactor[0]): string | undefined =>
  typeof source === "string" ? source : undefined;

const factorSourceIcon = (source: ResourceFactor[0]): LucideIcon => {
  if (source instanceof ResourceDefinition) return Users;
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
  const formatAmount = (amount: number): string =>
    formatNumber(Math.floor(amount), numberFormat);
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
    if (!entry) return <span className="gamepedia-plain-ref">{label ?? id}</span>;
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
    const count = gameState.builtBuildings.filter(
      (key) => key === building.key,
    ).length;
    const costs = gameState.getBuildingCost(building.key, count);
    const effects = building.effects;
    const costFactors = new Map(
      building.costs.map((cost) => [cost.resource, cost.factor]),
    );

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{building.description}</p>

        <p className="gamepedia-category">Price</p>
        <div className="gamepedia-cost-list">
          {costs.map(({ resource, base }) => {
            const factor = costFactors.get(resource) ?? 1;
            return (
              <div className="gamepedia-cost-row" key={resource}>
                <div className="gamepedia-cost-copy">
                  {renderReference(resource)}
                  {factor !== 1 && (
                    <span className="gamepedia-cost-meta">
                      ×{factor} each built
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

        <p className="gamepedia-category">Effects</p>
        <div className="gamepedia-effect-list">
          {effects.resourceMultiplier ? (
            <div className="gamepedia-effect-row" key="multiplier">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.resourceMultiplier.resource)}
                <span className="gamepedia-effect-meta">
                  ×{effects.resourceMultiplier.factor} gain per building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                ×{Math.round((effects.resourceMultiplier.factor ** count) * 100) / 100}{" "}
                now
              </strong>
            </div>
          ) : null}
          {effects.resourceDrain ? (
            <div className="gamepedia-effect-row" key="drain">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.resourceDrain.resource)}
                <span className="gamepedia-effect-meta">
                  {formatAmount(effects.resourceDrain.amount)}/sec per building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                {formatAmount(effects.resourceDrain.amount * count)}/sec now
              </strong>
            </div>
          ) : null}
          {effects.capacityProvided ? (
            <div className="gamepedia-effect-row" key="capacity">
              <div className="gamepedia-effect-copy">
                {renderReference(effects.capacityProvided.building)}
                <span className="gamepedia-effect-meta">
                  +{formatAmount(effects.capacityProvided.perBuilding)}{" "}
                  {capacityLabel(effects.capacityProvided.building)} per building
                </span>
              </div>
              <strong className="gamepedia-effect-total">
                +{formatAmount(effects.capacityProvided.perBuilding * count)} now
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
              {count} / {gameState.getBuildingMax(building.key)}
            </strong>
          </div>
        </div>

        {renderRelated(entry)}
      </div>
    );
  };
const renderResourceDetail = (entry: GamepediaEntry) => {
    const key = entry.object.id as ResourceKey;
    const resources = gameState.resources as Record<string, number>;
    const rate = gameState.computeResourceRate(key);
    const factors = gameState.getFactors(key);
    const factorTabs: FactorTab[] = ["additional", "multiplicative", "drain"];
    const isPopulation = key === "population";
    const workerProduction = isPopulation
      ? undefined
      : gameState.getWorkerProduction(key as ProductionResourceKey);
    const multiplierProduct = factors.multiplicative.reduce(
      (product, [, value]) => product * value,
      1,
    );
    const hasWorkers =
      workerProduction !== undefined &&
      resourceDefinitions.some(({ key: resourceKey }) => resourceKey === key);

    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{entry.object.description}</p>

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
                <strong>{gameState.maximumPopulation}</strong>
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
                  {rate > 0 ? "+" : ""}
                  {formatAmount(rate)}/sec
                </strong>
              </div>
            </div>
            <p className="gamepedia-category">Production</p>
            <div className="gamepedia-stats">
              {hasWorkers && workerProduction !== undefined && (
                <div className="gamepedia-stat">
                  <span>Workers</span>
                  <strong>{workerProduction.workers}</strong>
                </div>
              )}
              {workerProduction !== undefined && (
                <>
                  <div className="gamepedia-stat">
                    <span>Base</span>
                    <strong>
                      {formatAmount(workerProduction.workerProduction)}/sec
                    </strong>
                  </div>
                  <div className="gamepedia-stat">
                    <span>Auto</span>
                    <strong>
                      +{formatAmount(workerProduction.autoClickProduction)}/sec
                    </strong>
                  </div>
                </>
              )}
              <div className="gamepedia-stat">
                <span>Multipliers</span>
                <strong>{formatFactorValue("multiplicative", multiplierProduct)}</strong>
              </div>
            </div>

            <p className="gamepedia-category">Modifiers</p>
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
                              onClick={() => openEntry(entryForSource.object.id)}
                              title={`Open ${displayName(entryForSource.object)}`}
                            >
                              {factorSourceLabel(source)}
                            </button>
                          ) : (
                            <span className="factor-source">
                              {factorSourceLabel(source)}
                            </span>
                          )}
                          <strong>{formatFactorValue(tab, value)}</strong>
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
    const resources = gameState.resources as Record<string, number>;
    return (
      <div className="gamepedia-detail">
        {renderDetailHeader(entry)}
        <p className="gamepedia-detail-description">{entry.object.description}</p>
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

  const renderDetail = (entry: GamepediaEntry) => {
    if (entry.category === "building") return renderBuildingDetail(entry);
    if (entry.category === "resource") return renderResourceDetail(entry);
    if (entry.category === "capacity") return renderCapacityDetail(entry);
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