import { describe, expect, test } from "bun:test";
import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import type { MachineModuleReportV1 } from "@frockbot/core/machine-protocol";
import {
  MAX_PLUGIN_MODULE_REPORTS_V1,
  pluginModuleReportsTextV1,
  readPluginModuleReportsV1,
  recordPluginModuleReportsV1,
} from "./module-reports.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

const generation = {
  members: [
    {
      packageId: "beeper",
      modules: [{ id: "bridge", contentHash: "b".repeat(64), size: 10 }],
    },
    { packageId: "tuner" },
  ],
} as unknown as CompositionGenerationV1;

const machine = {
  generation,
  machineId: "mac-1",
  machineLabel: "Tims-Mac.local",
};

const log = (text: string): MachineModuleReportV1 => ({
  pluginId: "beeper",
  moduleId: "bridge",
  kind: "log",
  level: "log",
  text,
});

describe("what a Plugin's device modules report", () => {
  test("keeps the newest entries per Plugin, newest first, stamped by the cloud", async () => {
    const storage = new MemoryStorage();
    const at = new Date("2026-09-25T02:10:03.000Z");
    const receipt = await recordPluginModuleReportsV1(storage, {
      ...machine,
      reports: [
        {
          pluginId: "beeper",
          moduleId: "bridge",
          kind: "state",
          state: "starting",
        },
        log("connected"),
      ],
      now: at,
    });
    expect(receipt).toEqual({ recorded: 2, dropped: 0 });
    const kept = await readPluginModuleReportsV1(storage, "beeper");
    expect(kept.entries.map((entry) => entry.kind)).toEqual(["log", "state"]);
    expect(kept.entries[0]).toEqual({
      at: at.toISOString(),
      machineId: "mac-1",
      machineLabel: "Tims-Mac.local",
      moduleId: "bridge",
      kind: "log",
      level: "log",
      text: "connected",
    });

    for (let index = 0; index < MAX_PLUGIN_MODULE_REPORTS_V1; index += 1) {
      await recordPluginModuleReportsV1(storage, {
        ...machine,
        reports: [log(`line ${index}`)],
        now: at,
      });
    }
    const bounded = await readPluginModuleReportsV1(storage, "beeper");
    expect(bounded.entries).toHaveLength(MAX_PLUGIN_MODULE_REPORTS_V1);
    expect(bounded.entries[0]).toMatchObject({ text: "line 49" });
    // The state scrolled out of the entries and is still known.
    expect(bounded.states).toEqual([
      {
        at: at.toISOString(),
        machineId: "mac-1",
        machineLabel: "Tims-Mac.local",
        moduleId: "bridge",
        state: "starting",
      },
    ]);
  });

  test("keeps one latest state per machine and module", async () => {
    const storage = new MemoryStorage();
    const state = (
      machineId: string,
      value: "running" | "crashed",
      detail?: string,
    ) =>
      recordPluginModuleReportsV1(storage, {
        ...machine,
        machineId,
        reports: [
          {
            pluginId: "beeper",
            moduleId: "bridge",
            kind: "state",
            state: value,
            ...(detail === undefined ? {} : { detail }),
          },
        ],
        now: new Date("2026-09-25T00:00:00.000Z"),
      });
    await state("mac-1", "running");
    await state("mac-2", "running");
    await state("mac-1", "crashed", "exit 1");
    const { states } = await readPluginModuleReportsV1(storage, "beeper");
    expect(
      states.map((held) => [held.machineId, held.state, held.detail]),
    ).toEqual([
      ["mac-2", "running", undefined],
      ["mac-1", "crashed", "exit 1"],
    ]);
  });

  test("drops a report for a Plugin or module the active generation does not carry", async () => {
    const storage = new MemoryStorage();
    const receipt = await recordPluginModuleReportsV1(storage, {
      ...machine,
      reports: [
        { ...log("gone"), pluginId: "removed" },
        { ...log("no module"), pluginId: "tuner" },
        { ...log("renamed"), moduleId: "old" },
        log("kept"),
      ],
      now: new Date(),
    });
    expect(receipt).toEqual({ recorded: 1, dropped: 3 });
    expect(storage.values.size).toBe(1);
    expect(
      (await readPluginModuleReportsV1(storage, "removed")).entries,
    ).toEqual([]);
  });

  test("reads as each module's state, with a crash's detail, then its logs", () => {
    expect(
      pluginModuleReportsTextV1("beeper", { entries: [], states: [] }),
    ).toMatch(/have reported nothing/);
    const origin = {
      machineId: "mac-1",
      machineLabel: "Tims-Mac.local",
      moduleId: "bridge",
    };
    expect(
      pluginModuleReportsTextV1("beeper", {
        entries: [
          {
            ...origin,
            at: "2026-09-25T00:00:02.000Z",
            kind: "log",
            level: "error",
            text: "ECONNREFUSED localhost:23373",
          },
          {
            ...origin,
            at: "2026-09-25T00:00:01.000Z",
            kind: "state",
            state: "crashed",
            detail: "exit 1",
          },
        ],
        states: [
          {
            ...origin,
            at: "2026-09-25T00:00:01.000Z",
            state: "crashed",
            detail: "exit 1",
          },
        ],
      }),
    ).toBe(
      [
        "beeper's device modules, latest state on each desktop:",
        "- bridge on Tims-Mac.local: crashed since 2026-09-25T00:00:01.000Z. exit 1",
        "1 log line(s), newest first:",
        "2026-09-25T00:00:02.000Z error (bridge on Tims-Mac.local): ECONNREFUSED localhost:23373",
      ].join("\n"),
    );
  });
});
