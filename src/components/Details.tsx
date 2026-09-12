import { useState } from "react";
import { Coins, Leaf, Pickaxe, Sparkles, Users, Wheat, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  baseResourceGenerator,
  type ResourceFactor,
  type ResourceFactors,
} from "../game/resources";

type FactorTab = keyof ResourceFactors;

export type DetailsResource = {
  label: string;
  icon: LucideIcon;
  tone: string;
};

type DetailsProps = {
  resource: DetailsResource;
  factors: ResourceFactors;
  rate: number;
  onClose: () => void;
};

const factorLabels: Record<FactorTab, string> = {
  additional: "Add",
  multiplicative: "Mult",
  drain: "Drain",
};

const sourceIcon = (source: string): LucideIcon => {
  const normalizedSource = source.toLowerCase();
  if (source === baseResourceGenerator) return Users;
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

const formatFactorValue = (tab: FactorTab, value: number): string =>
  tab === "multiplicative" ? `×${value}` : value > 0 ? `+${value}` : `${value}`;

export default function Details({
  resource,
  factors,
  rate,
  onClose,
}: DetailsProps) {
  const [factorTab, setFactorTab] = useState<FactorTab>("additional");
  const factorsForTab = factors[factorTab];
  const ResourceIcon = resource.icon;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="resource-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="resource-modal-header">
          <div className="resource-modal-title">
            <span className={`resource-icon ${resource.tone}`}>
              <ResourceIcon size={18} strokeWidth={1.8} />
            </span>
            <div>
              <p className="eyebrow">Details</p>
              <h3 id="resource-modal-title">{resource.label}</h3>
            </div>
          </div>
          <button
            className="modal-close"
            onClick={onClose}
            aria-label="Close details"
          >
            <X size={18} />
          </button>
        </header>
        <div className="rate-summary">
          <span>Current rate</span>
          <strong>
            {rate > 0 ? "+" : ""}
            {rate} / sec
          </strong>
        </div>
        <div
          className="factor-tabs"
          role="tablist"
          aria-label="Resource modifiers"
        >
          {(Object.keys(factorLabels) as FactorTab[]).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={factorTab === tab}
              className={factorTab === tab ? "active" : ""}
              onClick={() => setFactorTab(tab)}
            >
              {factorLabels[tab]} <span>{factors[tab].length}</span>
            </button>
          ))}
        </div>
        <div className="factor-list">
          {factorsForTab.length === 0 ? (
            <p className="empty-factors">
              No {factorLabels[factorTab].toLowerCase()} modifiers active.
            </p>
          ) : (
            factorsForTab.map(([source, value]: ResourceFactor) => {
              const SourceIcon = sourceIcon(source);
              return (
                <div className="factor-row" key={`${source}-${value}`}>
                  <span className="factor-source-icon">
                    <SourceIcon size={16} strokeWidth={1.8} />
                  </span>
                  <span className="factor-source">{source}</span>
                  <strong>{formatFactorValue(factorTab, value)}</strong>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
