// Bot identity: the title, the name's provenance, and the sidebar-hidden flag.
//
// The first test is the one that matters most: a Bot settings record written
// before any of this existed must still decode, because widening a durable DTO
// with optional fields is the only migration this project permits.
import { describe, expect, test } from "bun:test";
import {
  applyBotProfilePatchV1,
  decodeBotSettingsViewV1,
  decodeConfigurationCommandV1,
  type BotProfile,
} from "./index.js";

function settings(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    botId: "primary",
    revision: 2,
    profile,
    notifications: { enabled: false },
    packageValues: {},
  };
}

describe("Bot identity codecs", () => {
  test("decodes a Bot settings record written before identity was widened", () => {
    const decoded = decodeBotSettingsViewV1(
      settings({ name: "Housework", description: "Keeps things tidy." }),
    );
    expect(decoded.profile).toEqual({
      name: "Housework",
      description: "Keeps things tidy.",
    });
    expect(decoded.profile.title).toBeUndefined();
    expect(decoded.profile.namedBy).toBeUndefined();
    expect(decoded.profile.hiddenFromSidebar).toBeUndefined();
  });

  test("round-trips a title, provenance, and the hidden flag", () => {
    const profile = {
      name: "Housework",
      title: "Chief of staff",
      namedBy: "bot" as const,
      hiddenFromSidebar: true,
    };
    expect(decodeBotSettingsViewV1(settings(profile)).profile).toEqual(profile);
  });

  test("refuses a profile field outside the declared vocabulary", () => {
    expect(() =>
      decodeBotSettingsViewV1(settings({ name: "Housework", nickname: "H" })),
    ).toThrow("profile has invalid fields");
    expect(() =>
      decodeBotSettingsViewV1(
        settings({ name: "Housework", namedBy: "admin" }),
      ),
    ).toThrow("profile.namedBy is invalid");
    expect(() =>
      decodeBotSettingsViewV1(
        settings({ name: "Housework", hiddenFromSidebar: "yes" }),
      ),
    ).toThrow("profile.hiddenFromSidebar must be a boolean");
  });
});

describe("bot/set-profile", () => {
  test("decodes a partial update carrying only the fields it changes", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/set-profile",
        commandId: "command-1",
        botId: "primary",
        expectedRevision: 3,
        namedBy: "bot",
        profile: { name: "Atlas" },
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId: "command-1",
      botId: "primary",
      expectedRevision: 3,
      namedBy: "bot",
      profile: { name: "Atlas" },
    });
  });

  test("carries the Bot writer, and refuses one aimed at another Bot", () => {
    const command = {
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId: "command-1",
      botId: "primary",
      expectedRevision: 3,
      namedBy: "bot",
      profile: { name: "Atlas" },
    } as const;
    const writer = {
      kind: "bot",
      botId: "primary",
      sessionId: "user-1:primary",
      turnId: "turn-4",
    } as const;
    expect(decodeConfigurationCommandV1({ ...command, writer })).toEqual({
      ...command,
      writer,
    });
    // A Bot writes only its own profile, so the writer must name the target.
    expect(() =>
      decodeConfigurationCommandV1({
        ...command,
        writer: { ...writer, botId: "other" },
      }),
    ).toThrow("writer.botId is invalid");
    expect(() =>
      decodeConfigurationCommandV1({
        ...command,
        writer: { ...writer, kind: "user" },
      }),
    ).toThrow("writer.kind is invalid");
    expect(() =>
      decodeConfigurationCommandV1({
        ...command,
        writer: { ...writer, runId: "run-1" },
      }),
    ).toThrow("writer has invalid fields");
  });

  test("refuses an empty patch and an unknown patch field", () => {
    const command = {
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId: "command-1",
      botId: "primary",
      expectedRevision: 3,
    };
    expect(() =>
      decodeConfigurationCommandV1({ ...command, profile: {} }),
    ).toThrow("profile has invalid fields");
    expect(() =>
      decodeConfigurationCommandV1({ ...command, profile: { namedBy: "bot" } }),
    ).toThrow("profile has invalid fields");
  });

  test("changes only the fields the patch carries", () => {
    const current: BotProfile = {
      name: "Housework",
      title: "Chief of staff",
      description: "Keeps things tidy.",
      hiddenFromSidebar: true,
    };
    expect(
      applyBotProfilePatchV1(current, { title: "Night shift" }, "user"),
    ).toEqual({ ...current, title: "Night shift" });
  });

  test("records the writer only when the name actually changes", () => {
    const current: BotProfile = { name: "Housework", namedBy: "user" };
    expect(
      applyBotProfilePatchV1(current, { name: "Atlas" }, "bot").namedBy,
    ).toBe("bot");
    expect(
      applyBotProfilePatchV1(current, { name: "Housework" }, "bot").namedBy,
    ).toBe("user");
    expect(
      applyBotProfilePatchV1(current, { title: "Chief" }, "bot").namedBy,
    ).toBe("user");
  });

  test("clears optional fields with empty values", () => {
    const current: BotProfile = {
      name: "Housework",
      title: "Chief of staff",
      hiddenFromSidebar: true,
    };
    expect(
      applyBotProfilePatchV1(
        current,
        { title: "", hiddenFromSidebar: false },
        "user",
      ),
    ).toEqual({ name: "Housework" });
  });
});
