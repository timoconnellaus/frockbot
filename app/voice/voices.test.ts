import { describe, expect, test } from "bun:test";
import { avatarCatalog } from "@frockbot/app/flock/shared";
import {
  isVoiceIdV1,
  resolveVoiceIdV1,
  VOICE_BY_CHARACTER_V1,
  VOICE_CATALOG_V1,
} from "./voices.js";

describe("the voice catalog", () => {
  test("offers each voice once, with an id, a name and a description", () => {
    const ids = VOICE_CATALOG_V1.map((voice) => voice.voiceId);
    expect(new Set(ids).size).toBe(ids.length);
    const names = VOICE_CATALOG_V1.map((voice) => voice.name);
    expect(new Set(names).size).toBe(names.length);
    for (const voice of VOICE_CATALOG_V1) {
      expect(voice.voiceId.trim()).not.toBe("");
      expect(voice.name.trim()).not.toBe("");
      expect(voice.description.trim()).not.toBe("");
    }
  });

  // The point of defaulting from the character is that a person who has only
  // ever picked a look still hears different Bots as different people. That
  // only holds if every character has a voice and no two share one.
  test("gives every character its own voice, and none is off the list", () => {
    for (const characterId of Object.keys(avatarCatalog)) {
      const voiceId = VOICE_BY_CHARACTER_V1[characterId];
      expect(voiceId, `${characterId} has no default voice`).toBeDefined();
      expect(isVoiceIdV1(voiceId)).toBe(true);
    }
    const assigned = Object.values(VOICE_BY_CHARACTER_V1);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  test("a voice the deployment does not offer is not a voice", () => {
    expect(isVoiceIdV1("not-a-voice")).toBe(false);
    expect(isVoiceIdV1(undefined)).toBe(false);
    expect(isVoiceIdV1(VOICE_CATALOG_V1[0]!.voiceId)).toBe(true);
  });
});

describe("resolving a Bot's voice", () => {
  const chosen = VOICE_CATALOG_V1[3]!.voiceId;

  test("prefers the Bot's own choice", () => {
    expect(
      resolveVoiceIdV1({ chosen, characterId: "sunny", fallback: "deploy" }),
    ).toBe(chosen);
  });

  test("falls back to the character when the Bot has not chosen", () => {
    expect(resolveVoiceIdV1({ characterId: "sunny", fallback: "deploy" })).toBe(
      VOICE_BY_CHARACTER_V1.sunny,
    );
  });

  // A stored voice that is no longer offered — the deployment curated it away
  // — must not reach the provider: it would be a call that cannot speak.
  test("ignores a chosen voice that is no longer offered", () => {
    expect(
      resolveVoiceIdV1({
        chosen: "retired-voice",
        characterId: "sunny",
        fallback: "deploy",
      }),
    ).toBe(VOICE_BY_CHARACTER_V1.sunny);
  });

  test("falls back to the deployment's voice, then to nothing", () => {
    expect(
      resolveVoiceIdV1({ characterId: "not-a-character", fallback: "deploy" }),
    ).toBe("deploy");
    expect(resolveVoiceIdV1({})).toBeUndefined();
    expect(resolveVoiceIdV1({ fallback: "   " })).toBeUndefined();
  });
});
