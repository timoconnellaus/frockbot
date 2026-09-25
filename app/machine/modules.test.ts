import { describe, expect, test } from "bun:test";
import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import { generationCarriesModuleV1, machineModulesV1 } from "./modules.js";

const bridge = {
  id: "bridge",
  platforms: ["macos"],
  read: [],
  net: ["localhost:23373"],
  appleEvents: [],
  calls: ["send"],
  events: ["message"],
};

const generation = {
  members: [
    {
      packageId: "beeper",
      descriptor: { device: { abilities: [], modules: [bridge] } },
      modules: [{ id: "bridge", contentHash: "b".repeat(64), size: 42 }],
    },
    { packageId: "tuner", descriptor: {} },
  ],
} as unknown as CompositionGenerationV1;

describe("the modules a desktop runs", () => {
  test("joins each stored module with its declaration", () => {
    expect(machineModulesV1(generation, "macos")).toEqual([
      {
        pluginId: "beeper",
        moduleId: "bridge",
        contentHash: "b".repeat(64),
        size: 42,
        read: [],
        net: ["localhost:23373"],
        appleEvents: [],
        calls: ["send"],
        events: ["message"],
      },
    ]);
  });

  test("gives a machine only the modules declared for its platform", () => {
    expect(machineModulesV1(generation, "linux")).toEqual([]);
  });

  test("knows which artifacts the generation carries", () => {
    expect(generationCarriesModuleV1(generation, "b".repeat(64))).toBe(true);
    expect(generationCarriesModuleV1(generation, "c".repeat(64))).toBe(false);
  });
});
