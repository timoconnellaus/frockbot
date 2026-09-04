import { describe, expect, test } from "bun:test";
import {
  decodeBotIdentityDirectoryViewV1,
  decodeBotIdentityViewV1,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotMembershipViewV1,
  decodeBotRegistrationV1,
  decodeCreateBotCommandV1,
  decodeDirectoryViewV1,
  decodeSheepRecipeV1,
  migrateStoredBotDirectoryV1,
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

  test("strictly decodes archive and restore DTOs", () => {
    const command = {
      schemaVersion: 1 as const,
      type: "bot/archive" as const,
      commandId: "archive-1",
      botId: "alpha",
    };
    expect(decodeBotLifecycleCommandV1(command)).toEqual(command);
    expect(
      decodeBotLifecycleReceiptV1({
        schemaVersion: 1,
        commandId: "archive-1",
        botId: "alpha",
        status: "applied",
        lifecycle: {
          schemaVersion: 1,
          botId: "alpha",
          status: "archived",
          revision: 1,
        },
      }),
    ).toMatchObject({ lifecycle: { status: "archived" } });
    const hidden = { ...command };
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => decodeBotLifecycleCommandV1(hidden)).toThrow(
      "unknown or missing field",
    );
    expect(() =>
      decodeBotLifecycleCommandV1({ ...command, [Symbol("extra")]: true }),
    ).toThrow("unknown or missing field");
  });

  test("rejects retired model seed fields", () => {
    const sheep = randomSheepRecipeV1(() => 0);
    expect(() =>
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
              providerModelId: "model-1",
            },
            sheep,
          },
        ],
      }),
    ).toThrow("unknown or missing field");
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

  test("decodes the live Bot identity directory exactly", () => {
    const identity = {
      schemaVersion: 1 as const,
      botId: "alpha",
      name: "Atlas",
      namedBy: "bot" as const,
      hiddenFromSidebar: true,
      label: "Personal",
      title: "Chief of staff",
    };
    expect(decodeBotIdentityViewV1(structuredClone(identity))).toEqual(
      identity,
    );
    expect(
      decodeBotIdentityDirectoryViewV1({
        schemaVersion: 1,
        identities: [identity],
      }).identities,
    ).toHaveLength(1);
    expect(() =>
      decodeBotIdentityViewV1({ ...identity, namedBy: "admin" }),
    ).toThrow("namedBy is invalid");
    expect(() => decodeBotIdentityViewV1({ ...identity, extra: true })).toThrow(
      "unknown or missing field",
    );
    expect(() =>
      decodeBotIdentityViewV1({ ...identity, avatar: { kind: "image" } }),
    ).toThrow("unknown or missing field");
    expect(() =>
      decodeBotIdentityDirectoryViewV1({
        schemaVersion: 1,
        identities: [identity, identity],
      }),
    ).toThrow("duplicate IDs");
  });

  test("carries the pin instant, and refuses one that is not an instant", () => {
    const identity = {
      schemaVersion: 1 as const,
      botId: "alpha",
      name: "Atlas",
      namedBy: "user" as const,
      hiddenFromSidebar: false,
      pinnedAt: "2026-09-03T10:15:00.000Z",
    };
    expect(decodeBotIdentityViewV1(structuredClone(identity))).toEqual(
      identity,
    );
    // Absent stays absent: every identity written before pinning existed.
    const { pinnedAt: _pinnedAt, ...unpinned } = identity;
    expect(decodeBotIdentityViewV1(structuredClone(unpinned))).toEqual(
      unpinned,
    );
    expect(() =>
      decodeBotIdentityViewV1({ ...identity, pinnedAt: "someday" }),
    ).toThrow("pinnedAt is invalid");
  });
});

describe("stored Bot directory migration", () => {
  const sheep = randomSheepRecipeV1(() => 0);
  const legacyBot = () => ({
    schemaVersion: 1,
    botId: "alpha",
    registeredAt: "2026-08-29T00:00:00.000Z",
    initialName: "Alpha",
    initialModel: { connectionId: "openai", providerModelId: "gpt-5" },
    initialModelBinding: {
      assignment: {
        assignmentId: "assignment-1",
        packageId: "models",
        capabilityId: "chat",
        connectionId: "openai",
        state: "enabled",
      },
      generation: "generation-1",
    },
    initialAssignments: [],
    sheep,
  });

  test("drops the retired model and Assignment seed fields", () => {
    const stored = { schemaVersion: 1, revision: 1, bots: [legacyBot()] };
    // Without migration this is exactly the failure the sidebar reported.
    expect(() => decodeDirectoryViewV1(stored)).toThrow(
      "unknown or missing field",
    );
    const directory = decodeDirectoryViewV1(
      migrateStoredBotDirectoryV1(stored),
    );
    expect(directory.revision).toBe(1);
    const [bot] = directory.bots;
    expect(bot).toMatchObject({ botId: "alpha", initialName: "Alpha" });
    for (const key of [
      "initialModel",
      "initialModelBinding",
      "initialAssignments",
    ])
      expect(Object.hasOwn(bot!, key)).toBe(false);
    // Migration is read-time: the durable record itself is left alone.
    expect(Object.hasOwn(stored.bots[0]!, "initialModel")).toBe(true);
  });

  test("returns a current-shape record untouched", () => {
    const current = {
      schemaVersion: 1,
      revision: 0,
      bots: [
        {
          schemaVersion: 1,
          botId: "alpha",
          registeredAt: "2026-08-29T00:00:00.000Z",
          initialName: "Alpha",
          sheep,
        },
      ],
    };
    expect(migrateStoredBotDirectoryV1(current)).toBe(current);
  });

  test("leaves records it does not recognise for the decoder to reject", () => {
    expect(migrateStoredBotDirectoryV1(undefined)).toBeUndefined();
    expect(migrateStoredBotDirectoryV1("nope")).toBe("nope");
    expect(() =>
      decodeDirectoryViewV1(
        migrateStoredBotDirectoryV1({ schemaVersion: 1, revision: 0 }),
      ),
    ).toThrow("unknown or missing field");
  });
});
