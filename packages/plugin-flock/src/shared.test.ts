import { describe, expect, test } from "bun:test";
import {
  decodeBotMembershipViewV1,
  decodeBotRegistrationV1,
  decodeCreateBotCommandV1,
  decodeDirectoryViewV1,
  decodeSheepRecipeV1,
  randomSheepRecipeV1,
  sheepCatalog,
  sheepLayerIds,
} from "./shared.js";

describe("Flock v1 contracts", () => {
  test("rejects unknown fields and catalog IDs", () => {
    const sheep = randomSheepRecipeV1(() => 0);
    expect(() => decodeSheepRecipeV1({ ...sheep, surprise: true })).toThrow(
      "unknown or missing field",
    );
    expect(() => decodeSheepRecipeV1({ ...sheep, upper: "not-a-hat" })).toThrow(
      "unknown catalog item",
    );
    expect(() =>
      decodeCreateBotCommandV1({
        schemaVersion: 1,
        type: "bot/create",
        commandId: "create-1",
        expectedRevision: 0,
        botId: "alpha",
        name: "Alpha",
        sheep,
        extra: true,
      }),
    ).toThrow("unknown or missing field");
  });

  test("round-trips configuration-valid provider model text", () => {
    const sheep = randomSheepRecipeV1(() => 0);
    expect(
      decodeDirectoryViewV1({
        schemaVersion: 1,
        revision: 1,
        bots: [
          {
            schemaVersion: 1,
            botId: "alpha",
            registeredAt: new Date(0).toISOString(),
            initialName: "Alpha",
            initialModel: {
              connectionId: "connection-1",
              providerModelId: "openai/gpt-4o:2024-08-06",
            },
            sheep,
          },
        ],
      }).bots[0]?.initialModel?.providerModelId,
    ).toBe("openai/gpt-4o:2024-08-06");
    expect(() =>
      decodeCreateBotCommandV1({
        schemaVersion: 1,
        type: "bot/create",
        commandId: "create-2",
        expectedRevision: 1,
        botId: "invalid@desktop",
        name: "Invalid",
      }),
    ).toThrow("botId is invalid");
  });

  test("exactly decodes versioned registration and membership DTOs", () => {
    const sheep = randomSheepRecipeV1(() => 0);
    const registration = {
      schemaVersion: 1 as const,
      botId: "alpha",
      registeredAt: new Date(0).toISOString(),
      initialName: "Alpha",
      sheep,
    };
    expect(decodeBotRegistrationV1(registration)).toEqual(registration);
    expect(
      decodeBotMembershipViewV1({
        schemaVersion: 1,
        botId: "alpha",
        registered: true,
      }),
    ).toEqual({ schemaVersion: 1, botId: "alpha", registered: true });
    for (const invalid of [
      { ...registration, schemaVersion: 2 },
      { ...registration, botId: "bad:bot" },
      { ...registration, extra: true },
    ])
      expect(() => decodeBotRegistrationV1(invalid)).toThrow();
    expect(() =>
      decodeBotMembershipViewV1({
        schemaVersion: 1,
        botId: "bad:bot",
        registered: true,
      }),
    ).toThrow("botId is invalid");
  });

  test("random recipes are legal and compose complete ancestor paths", () => {
    for (let index = 0; index < 100; index += 1) {
      const recipe = randomSheepRecipeV1(() => index / 100);
      expect(decodeSheepRecipeV1(recipe)).toEqual(recipe);
      const layers = sheepLayerIds(recipe);
      expect(layers[0]).toBe(`background-${recipe.background}`);
      expect(layers[1]).toBe("canonical");
    }
    expect(sheepCatalog.trees.upper).toHaveLength(24);
    expect(sheepCatalog.trees.middle).toHaveLength(14);
    expect(sheepCatalog.trees.lower).toHaveLength(8);
    expect(sheepCatalog.assets).toHaveLength(50);
  });
});
