import { describe, expect, test } from "bun:test";
import { STUDIO_DOCUMENT_V1 } from "@frockbot/core/theme";
import {
  decodeBotIdentityDirectoryViewV1,
  decodeUpdateLookCommandV1,
  decodeUpdateVoiceCommandV1,
  decodeVoiceIdentityViewV1,
  decodeBotIdentityViewV1,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeBotMembershipViewV1,
  decodeBotDirectoryProfileV1,
  decodeBotRegistrationV1,
  decodeCreateBotCommandV1,
  decodeDirectoryViewV1,
  decodeAvatarAppearanceV1,
  lifecycleTargetStatusV1,
  migrateStoredBotDirectoryV1,
  randomAvatarAppearanceV1,
  avatarCatalog,
} from "./shared.js";

describe("Flock v1 contracts", () => {
  test("rejects unknown fields and catalog IDs", () => {
    const avatar = randomAvatarAppearanceV1(() => 0);
    expect(() =>
      decodeAvatarAppearanceV1({ ...avatar, surprise: true }),
    ).toThrow("unknown or missing field");
    expect(() =>
      decodeAvatarAppearanceV1({ ...avatar, characterId: "not-a-character" }),
    ).toThrow("avatar appearance is invalid");
    expect(() =>
      decodeCreateBotCommandV1({
        schemaVersion: 1,
        type: "bot/create",
        commandId: "create-1",
        expectedRevision: 0,
        botId: "alpha",
        name: "Alpha",
        avatar,
        extra: true,
      }),
    ).toThrow("unknown or missing field");
  });

  test("strictly decodes the delete command and its terminal status", () => {
    const command = {
      schemaVersion: 1 as const,
      type: "bot/delete" as const,
      commandId: "delete-1",
      botId: "alpha",
    };
    expect(decodeBotLifecycleCommandV1(command)).toEqual(command);
    expect(lifecycleTargetStatusV1("bot/delete")).toBe("deleted");
    expect(lifecycleTargetStatusV1("bot/archive")).toBe("archived");
    expect(lifecycleTargetStatusV1("bot/restore")).toBe("active");
    expect(
      decodeBotLifecycleReceiptV1({
        schemaVersion: 1,
        commandId: "delete-1",
        botId: "alpha",
        status: "applied",
        lifecycle: {
          schemaVersion: 1,
          botId: "alpha",
          status: "deleted",
          revision: 1,
        },
      }),
    ).toMatchObject({ lifecycle: { status: "deleted" } });
    // A near-miss is still a rejection: the union is exact, not prefixed.
    expect(() =>
      decodeBotLifecycleCommandV1({ ...command, type: "bot/delete-all" }),
    ).toThrow("unsupported Bot lifecycle command");
    // A delete carries the Applet impact its confirmation showed; nothing
    // else may carry one, because nothing else destroys an Applet.
    const fenced = { ...command, appletImpact: "0123456789abcdef" };
    expect(decodeBotLifecycleCommandV1(fenced)).toEqual(fenced);
    expect(() =>
      decodeBotLifecycleCommandV1({ ...fenced, appletImpact: "stale" }),
    ).toThrow("appletImpact is invalid");
    expect(() =>
      decodeBotLifecycleCommandV1({ ...fenced, type: "bot/archive" }),
    ).toThrow("appletImpact is invalid");
    expect(() =>
      decodeBotLifecycleViewV1({
        schemaVersion: 1,
        botId: "alpha",
        status: "removed",
        revision: 1,
      }),
    ).toThrow("Bot lifecycle is invalid");
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
    const avatar = randomAvatarAppearanceV1(() => 0);
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
            avatar,
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
    const avatar = randomAvatarAppearanceV1(() => 0);
    const registration = {
      schemaVersion: 1 as const,
      botId: "alpha",
      registeredAt: new Date(0).toISOString(),
      initialName: "Alpha",
      avatar,
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
    const currentProfile = {
      name: "Atlas",
      description: "Keeps the list",
      sourceRevision: 4,
    };
    expect(
      decodeBotRegistrationV1({ ...registration, currentProfile }),
    ).toEqual({ ...registration, currentProfile });
    expect(decodeBotDirectoryProfileV1(currentProfile)).toEqual(currentProfile);
    expect(() =>
      decodeBotDirectoryProfileV1({ ...currentProfile, sourceRevision: -1 }),
    ).toThrow("revision is invalid");
  });

  test("random appearances are legal and use the approved catalogue", () => {
    for (let index = 0; index < 100; index += 1) {
      const appearance = randomAvatarAppearanceV1(() => index / 100);
      expect(decodeAvatarAppearanceV1(appearance)).toEqual(appearance);
      expect(
        (Object.values(avatarCatalog) as string[]).includes(appearance.primary),
      ).toBe(true);
    }
    expect(Object.keys(avatarCatalog)).toHaveLength(11);
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

  test("carries the sidebar position, and refuses one that is not an integer", () => {
    const identity = {
      schemaVersion: 1 as const,
      botId: "alpha",
      name: "Atlas",
      namedBy: "user" as const,
      hiddenFromSidebar: false,
      label: "Work",
      sidebarOrder: 2000,
    };
    expect(decodeBotIdentityViewV1(structuredClone(identity))).toEqual(
      identity,
    );
    const { sidebarOrder: _order, ...unplaced } = identity;
    expect(decodeBotIdentityViewV1(structuredClone(unplaced))).toEqual(
      unplaced,
    );
    expect(() =>
      decodeBotIdentityViewV1({ ...identity, sidebarOrder: "top" }),
    ).toThrow("sidebarOrder is invalid");
  });
});

describe("stored Bot directory migration", () => {
  const avatar = randomAvatarAppearanceV1(() => 0);
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
    avatar,
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
          avatar,
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

describe("a Bot's voice", () => {
  const voice = {
    schemaVersion: 1 as const,
    voiceName: "Sulafat",
    delivery: { accent: "australian", turnLength: "terse" as const },
  };
  const command = {
    schemaVersion: 1 as const,
    type: "bot/update-voice" as const,
    commandId: "voice-1",
    expectedRevision: 0,
    botId: "alpha",
    voice,
  };

  test("decodes the command and refuses anything beside it", () => {
    expect(decodeUpdateVoiceCommandV1(command)).toEqual(command);
    expect(() =>
      decodeUpdateVoiceCommandV1({ ...command, type: "bot/update-voices" }),
    ).toThrow("unsupported update voice command");
    expect(() =>
      decodeUpdateVoiceCommandV1({ ...command, extra: true }),
    ).toThrow("unknown or missing field");
    // The voice tables decide, and their refusal arrives as a Flock error so
    // every seam in this Package fails the same way.
    expect(() =>
      decodeUpdateVoiceCommandV1({
        ...command,
        voice: { ...voice, voiceName: "Siri" },
      }),
    ).toThrow("voice name is not one the deployment offers");
    expect(() =>
      decodeUpdateVoiceCommandV1({
        ...command,
        voice: { ...voice, delivery: { accent: "klingon" } },
      }),
    ).toThrow("voice accent is invalid");
  });

  test("carries an optional voice on the registration and the create command", () => {
    const avatar = randomAvatarAppearanceV1(() => 0);
    const registration = {
      schemaVersion: 1 as const,
      botId: "alpha",
      registeredAt: "2026-08-29T00:00:00.000Z",
      initialName: "Alpha",
      avatar,
    };
    // Absent is the ordinary case: the Bot sounds like its character.
    expect(decodeBotRegistrationV1(registration).voice).toBeUndefined();
    expect(decodeBotRegistrationV1({ ...registration, voice })).toEqual({
      ...registration,
      voice,
    });
    expect(() =>
      decodeBotRegistrationV1({
        ...registration,
        voice: { ...voice, surprise: true },
      }),
    ).toThrow("voice appearance has an unknown key");
    const create = {
      schemaVersion: 1 as const,
      type: "bot/create" as const,
      commandId: "create-1",
      expectedRevision: 0,
      botId: "alpha",
      name: "Alpha",
      avatar,
      voice,
    };
    expect(decodeCreateBotCommandV1(create)).toMatchObject({ voice });
  });

  test("decodes the identity view, with or without a chosen voice", () => {
    const record = {
      schemaVersion: 1 as const,
      botId: "alpha",
      revision: 2,
    };
    expect(decodeVoiceIdentityViewV1(record)).toEqual(record);
    expect(decodeVoiceIdentityViewV1({ ...record, voice })).toEqual({
      ...record,
      voice,
    });
    expect(() =>
      decodeVoiceIdentityViewV1({ ...record, revision: -1 }),
    ).toThrow("revision is invalid");
  });
});

describe("a Bot's look", () => {
  const command = {
    schemaVersion: 1 as const,
    type: "bot/update-look" as const,
    commandId: "look-1",
    expectedRevision: 0,
    botId: "alpha",
    look: "studio" as const,
  };

  test("decodes the command, with or without a document", () => {
    expect(decodeUpdateLookCommandV1(command)).toEqual(command);
    expect(
      decodeUpdateLookCommandV1({
        ...command,
        look: "custom",
        document: STUDIO_DOCUMENT_V1,
      }),
    ).toEqual({
      ...command,
      look: "custom",
      document: STUDIO_DOCUMENT_V1,
    });
    expect(() =>
      decodeUpdateLookCommandV1({ ...command, extra: true }),
    ).toThrow("unknown or missing field");
    expect(() =>
      decodeUpdateLookCommandV1({
        ...command,
        look: "custom",
        document: { schemaVersion: 1 },
      }),
    ).toThrow("theme document has invalid fields");
  });
});
