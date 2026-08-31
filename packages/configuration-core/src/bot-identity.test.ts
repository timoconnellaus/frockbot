// Slice B, Bot identity: the title, the name's provenance, the uploaded
// avatar, and the sidebar-hidden flag.
//
// The first test is the one that matters most: a Bot settings record written
// before any of this existed must still decode, because widening a durable DTO
// with optional fields is the only migration this project permits.
import { describe, expect, test } from "bun:test";
import {
  applyBotProfilePatchV1,
  BOT_AVATAR_MAX_BYTES,
  botAvatarObjectKeyV1,
  decodeBotAvatarUploadReceiptV1,
  decodeBotAvatarV1,
  decodeBotSettingsViewV1,
  decodeConfigurationCommandV1,
  decodeUploadBotAvatarCommandV1,
  type BotProfile,
} from "./index.js";

const digest = "a".repeat(64);

function settings(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    botId: "primary",
    revision: 2,
    profile,
    notifications: { enabled: false },
    assignments: [],
    assignmentOperations: [],
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
    expect(decoded.profile.avatar).toBeUndefined();
    expect(decoded.profile.hiddenFromSidebar).toBeUndefined();
  });

  test("round-trips a title, a provenance, an avatar, and the hidden flag", () => {
    const profile = {
      name: "Housework",
      title: "Chief of staff",
      namedBy: "bot" as const,
      hiddenFromSidebar: true,
      avatar: {
        kind: "image" as const,
        digest,
        contentType: "image/png" as const,
        size: 1_024,
      },
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

  test("refuses an avatar whose content type is not a supported image", () => {
    expect(() =>
      decodeBotAvatarV1({
        kind: "image",
        digest,
        contentType: "application/pdf",
        size: 10,
      }),
    ).toThrow("avatar.contentType is invalid");
  });

  test("refuses an avatar larger than the durable limit, or empty", () => {
    for (const size of [0, -1, BOT_AVATAR_MAX_BYTES + 1]) {
      expect(() =>
        decodeBotAvatarV1({
          kind: "image",
          digest,
          contentType: "image/webp",
          size,
        }),
      ).toThrow("avatar.size is invalid");
    }
  });

  test("refuses an avatar digest that is not a SHA-256 hex string", () => {
    for (const value of ["", "z".repeat(64), digest.slice(1)]) {
      expect(() =>
        decodeBotAvatarV1({
          kind: "image",
          digest: value,
          contentType: "image/gif",
          size: 4,
        }),
      ).toThrow("avatar.digest is invalid");
    }
  });

  test("accepts the sheep avatar as an explicit clear", () => {
    expect(decodeBotAvatarV1({ kind: "sheep" })).toEqual({ kind: "sheep" });
    expect(() => decodeBotAvatarV1({ kind: "sheep", digest })).toThrow(
      "avatar has invalid fields",
    );
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
      avatar: {
        kind: "image",
        digest,
        contentType: "image/png",
        size: 1_024,
      },
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

  test("clears an optional field with the empty string and an avatar with the sheep", () => {
    const current: BotProfile = {
      name: "Housework",
      title: "Chief of staff",
      hiddenFromSidebar: true,
      avatar: {
        kind: "image",
        digest,
        contentType: "image/png",
        size: 1_024,
      },
    };
    expect(
      applyBotProfilePatchV1(
        current,
        { title: "", avatar: { kind: "sheep" }, hiddenFromSidebar: false },
        "user",
      ),
    ).toEqual({ name: "Housework" });
  });
});

describe("avatar upload", () => {
  test("decodes an upload command and its receipt", () => {
    const command = decodeUploadBotAvatarCommandV1({
      schemaVersion: 1,
      type: "bot/upload-avatar",
      botId: "primary",
      contentType: "image/png",
      bytes: "AAEC",
    });
    expect(command.contentType).toBe("image/png");
    expect(
      decodeBotAvatarUploadReceiptV1({
        schemaVersion: 1,
        botId: "primary",
        avatar: {
          kind: "image",
          digest,
          contentType: "image/png",
          size: 3,
        },
      }).avatar.digest,
    ).toBe(digest);
  });

  test("refuses an unsupported content type and a non-base64 body", () => {
    const command = {
      schemaVersion: 1,
      type: "bot/upload-avatar",
      botId: "primary",
    };
    expect(() =>
      decodeUploadBotAvatarCommandV1({
        ...command,
        contentType: "text/html",
        bytes: "AAEC",
      }),
    ).toThrow("avatar contentType is not a supported image");
    expect(() =>
      decodeUploadBotAvatarCommandV1({
        ...command,
        contentType: "image/png",
        bytes: "not base64!",
      }),
    ).toThrow("avatar bytes are not base64");
    expect(() =>
      decodeUploadBotAvatarCommandV1({
        ...command,
        contentType: "image/png",
        bytes: "",
      }),
    ).toThrow("avatar bytes are empty");
  });

  test("refuses an upload larger than the limit without decoding it", () => {
    // Four base64 characters carry three bytes, so this is one byte too many.
    const bytes = "A".repeat(Math.ceil((BOT_AVATAR_MAX_BYTES + 1) / 3) * 4);
    expect(() =>
      decodeUploadBotAvatarCommandV1({
        schemaVersion: 1,
        type: "bot/upload-avatar",
        botId: "primary",
        contentType: "image/png",
        bytes,
      }),
    ).toThrow(`avatar exceeds ${BOT_AVATAR_MAX_BYTES} bytes`);
  });

  test("keys avatar bytes by digest inside the owning User's namespace", () => {
    expect(botAvatarObjectKeyV1("user/one", digest)).toBe(
      `bot-avatars/user%2Fone/${digest}`,
    );
    expect(() => botAvatarObjectKeyV1("user-1", "nope")).toThrow(
      "avatar digest is invalid",
    );
  });
});
