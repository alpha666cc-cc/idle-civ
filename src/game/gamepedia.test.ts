import { describe, expect, it } from "vitest";
import type { Bonus } from "./bonus";
import {
  gamepedia,
  type GamepediaEntry,
} from "./gamepedia";
import {
  parseUnitStatTarget,
  unitDefinitions,
  unitMatchesStatTarget,
} from "./units";

describe("Gamepedia unit stat bonus relations", () => {
  it("links units to research, battle, and other stat bonus sources", () => {
    const sources = gamepedia.all().filter(({ category }) =>
      ["achievement", "age", "combat", "research", "upgrade"].includes(
        category,
      ),
    );
    const scopes = new Set<string>();
    const sourceCategories = new Set<string>();

    for (const source of sources) {
      const bonuses =
        (source.object as GamepediaEntry["object"] & {
          bonuses?: readonly Bonus[];
        }).bonuses ?? [];

      for (const bonus of bonuses) {
        const target = parseUnitStatTarget(String(bonus.destination));
        if (!target) continue;

        scopes.add(target.scope);
        sourceCategories.add(source.category);
        const matchingUnits = unitDefinitions.filter((unit) =>
          unitMatchesStatTarget(unit, target),
        );

        for (const unit of matchingUnits) {
          expect(source.relatedIds, source.object.id).toContain(unit.key);
          expect(
            gamepedia.require(unit.key).relatedIds,
            unit.key,
          ).toContain(source.object.id);
        }
      }
    }

    expect(scopes).toContain("all");
    expect(scopes).toContain("tag");
    expect(sourceCategories).toContain("research");
    expect(sourceCategories).toContain("combat");
  });
});
