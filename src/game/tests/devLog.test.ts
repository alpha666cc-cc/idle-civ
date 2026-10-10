import { describe, expect, it } from "vitest";
import { CivilizationState } from "../civilizationState";
import {
  DEFAULT_DEV_LOG_SNAPSHOT_SECONDS,
  appendDevLogEvent,
  appendDevLogSnapshot,
  buildDevLogEvent,
  buildDevLogSnapshot,
  createDevLog,
  devLogFileName,
  devLogFromSave,
  devLogGameSeconds,
  diffDevLogEvents,
  isDevLogSnapshotDue,
} from "../devLog";
import {
  createSaveData,
  loadSaveData,
  saveFromJson,
  saveToJson,
} from "../saveSystem";
import {
  emptyResourceAmounts,
  emptyResourceFactors,
  emptyWorkerAssignments,
} from "../attributes";
import { emptyStatistics } from "../statistics";

const runId = "abcdef12-3456-7890-abcd-ef1234567890";

/**
 * A settlement that already has five citizens, built directly rather than via
 * `build("people", …)`: a bare state carries no `peopleCapacity`, so the citizen
 * building is capacity-gated to zero and the build silently no-ops.
 */
const settledState = (people: number): CivilizationState =>
  new CivilizationState(
    emptyResourceAmounts(),
    emptyWorkerAssignments(),
    { townHall: 1, people },
    emptyResourceFactors(),
    {},
    0,
    [],
    [],
    [],
    [],
    emptyStatistics(),
    {},
  );

describe("dev run log", () => {
  it("records remarkable events between two states", () => {
    const before = new CivilizationState();
    const after = before.enterAge("age1").defeatEncounter("age0_1_first_fire");

    const events = diffDevLogEvents(before, after, 42);
    const types = events.map((event) => `${event.type}:${event.id}`);

    expect(types).toContain("age:age1");
    expect(types).toContain("battle:age0_1_first_fire");
    // Every event carries the state reading the simulator also records.
    expect(events[0].time).toBe(42);
    expect(events[0].population).toBeTypeOf("string");
    expect(events[0].resources).toHaveProperty("food");
  });

  it("gives an event the same full reading a snapshot gets", () => {
    // An event is only useful read in context: an event that logged a population
    // and a bag of resources but not the army, the research or the worker split
    // forced every reader back to the nearest snapshot. Events and snapshots now
    // share one payload type, so the field sets must match exactly.
    const state = new CivilizationState()
      .build("farm", 3)
      .assignWorker("food", 2)
      .assignWorker("wood", 1)
      .buyResearch("agriculture");

    const event = buildDevLogEvent(state, "research", "agriculture", 12);
    const snapshot = buildDevLogSnapshot(state, 12);

    const keysOf = (value: object): string[] =>
      Object.keys(value)
        .filter((key) => !["time", "type", "id", "detail"].includes(key))
        .sort();
    expect(keysOf(event)).toEqual(keysOf(snapshot));
    // And the values agree, not just the shape.
    for (const key of keysOf(snapshot)) {
      expect((event as Record<string, unknown>)[key], key).toEqual(
        (snapshot as Record<string, unknown>)[key],
      );
    }
  });

  it("records the worker split and the idle pool", () => {
    // The rates alone cannot explain a curve: a rate only reads next to how many
    // hands are on it, and the idle count separates "cannot grow" from "chose
    // not to".
    const state = settledState(5)
      .assignWorker("food", 3)
      .assignWorker("wood", 2);
    const snapshot = buildDevLogSnapshot(state, 30);

    expect(snapshot.workers).toEqual([
      { resource: "food", count: "3" },
      { resource: "wood", count: "2" },
    ]);
    // Five citizens, five assigned: nothing idle.
    expect(snapshot.workersIdle).toBe("0");
    expect(snapshot.population).toBe("5");
  });

  it("reports nothing when the progression lists are unchanged", () => {
    const state = new CivilizationState();
    expect(diffDevLogEvents(state, state.tick(), 1)).toEqual([]);
  });

  it("ignores an event id it has already recorded", () => {
    const state = new CivilizationState();
    const log = createDevLog(runId, 1000);
    const event = buildDevLogEvent(state, "battle", "age0_1_first_fire", 5);

    const once = appendDevLogEvent(log, event);
    const twice = appendDevLogEvent(once, event);

    expect(once.events).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("snapshots on the 60 second cadence", () => {
    expect(DEFAULT_DEV_LOG_SNAPSHOT_SECONDS).toBe(60);
    const log = createDevLog(runId, 1000);
    const state = new CivilizationState();

    // The first snapshot is always due.
    expect(isDevLogSnapshotDue(log, 0)).toBe(true);
    const first = appendDevLogSnapshot(log, buildDevLogSnapshot(state, 0));
    expect(isDevLogSnapshotDue(first, 59)).toBe(false);
    expect(isDevLogSnapshotDue(first, 60)).toBe(true);
  });

  it("names one file per run, so a reset changes the file", () => {
    const first = createDevLog(runId, 1_700_000_000_000);
    const second = createDevLog("99999999-other", 1_700_000_000_000);

    expect(first.fileName).toMatch(/^idle-civ-run-abcdef12-.*\.json$/);
    expect(second.fileName).not.toBe(first.fileName);
    // The path is fixed at creation and travels in the save, so the same run
    // always writes to the same file.
    expect(appendDevLogEvent(first, buildDevLogEvent(new CivilizationState(), "load", "x", 1)).fileName).toBe(
      first.fileName,
    );
  });

  it("survives a save round trip and can be read back", () => {
    const state = new CivilizationState();
    const log = appendDevLogEvent(
      createDevLog(runId, 1_700_000_000_000),
      buildDevLogEvent(state, "load", "this browser", 10, "offline 2h; no offline gain"),
    );

    const data = createSaveData(state, runId, 1_700_000_000_000, { devLog: log });
    const parsed = saveFromJson(saveToJson(data));
    const reloaded = devLogFromSave(parsed.devLog);

    expect(reloaded?.runId).toBe(runId);
    expect(reloaded?.events).toHaveLength(1);
    expect(reloaded?.events[0].detail).toContain("offline 2h");
    // The log is a diagnostic: it must not disturb the game state.
    expect(loadSaveData(data).population.toString()).toBe(
      state.population.toString(),
    );
  });

  it("keeps the same log path across a save round trip", () => {
    // The point of storing the path: reopening the browser must append to the
    // file the save remembers, not open a new one beside it.
    const state = new CivilizationState();
    const log = appendDevLogEvent(
      createDevLog(runId, 1_700_000_000_000),
      buildDevLogEvent(state, "battle", "age0_1_first_fire", 30),
    );
    const data = createSaveData(state, runId, 1_700_000_000_000, { devLog: log });
    const restored = devLogFromSave(saveFromJson(saveToJson(data)).devLog);

    expect(restored?.fileName).toBe(log.fileName);
    // A reload continues the same document rather than starting over.
    expect(restored?.events).toHaveLength(1);
    expect(restored?.runId).toBe(log.runId);
  });

  it("derives a path for a log saved before the path was stored", () => {
    const legacy = {
      runId,
      startedAtMs: 1_700_000_000_000,
      events: [],
      snapshots: [],
    };
    expect(devLogFromSave(legacy)?.fileName).toBe(
      devLogFileName(runId, 1_700_000_000_000),
    );
  });

  it("omits the dev section entirely when dev mode never ran", () => {
    const data = createSaveData(new CivilizationState(), runId, 1);
    expect(data.devLog).toBeUndefined();
    expect(saveToJson(data)).not.toContain("devLog");
  });

  it("reads a save with no log, or a broken one, as null", () => {
    expect(devLogFromSave(undefined)).toBeNull();
    expect(devLogFromSave({ runId: "" })).toBeNull();
    expect(devLogFromSave({ runId: "a", startedAtMs: 1, events: "no" })).toBeNull();
  });

  it("keeps the log clock on run time", () => {
    expect(devLogGameSeconds(new CivilizationState())).toBe(0);
    expect(devLogGameSeconds(new CivilizationState().tick().tick())).toBe(2);
  });
});
