// How a Bot sounds (ADR 0031): the tables, the prose the renderer builds from
// them, and the decoder that stands between a stored voice and a prompt.
//
// What is proved here is that every slug the decoder accepts renders, and that
// nothing else gets in: the delivery record is read into a system instruction
// on every call, so an unvalidated string would be an instruction the person
// never wrote.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GEMINI_VOICE_V1,
  GEMINI_VOICE_BY_CHARACTER_V1,
  GEMINI_VOICES_V1,
  VOICE_ACCENTS_V1,
  VOICE_ATTITUDES_V1,
  VOICE_CUSTOM_MAX_CHARS_V1,
  decodeBotVoiceAppearanceV1,
  defaultGeminiVoiceForCharacterV1,
  isGeminiVoiceNameV1,
  renderVoiceInstructionV1,
  resolveBotVoiceV1,
  type BotVoiceAppearanceV1,
  type VoiceDeliveryV1,
} from "./appearance.ts";

const VOICE = GEMINI_VOICES_V1[0]!.voiceName;

function appearance(delivery: VoiceDeliveryV1): BotVoiceAppearanceV1 {
  return { schemaVersion: 1, voiceName: VOICE, delivery };
}

describe("the voice tables", () => {
  test("offers thirty prebuilt voices, each named once", () => {
    expect(GEMINI_VOICES_V1).toHaveLength(30);
    expect(new Set(GEMINI_VOICES_V1.map((voice) => voice.voiceName)).size).toBe(
      30,
    );
    expect(isGeminiVoiceNameV1("Schedar")).toBe(true);
    expect(isGeminiVoiceNameV1("schedar")).toBe(false);
    expect(isGeminiVoiceNameV1("Siri")).toBe(false);
  });

  test("names a distinct, offered voice for every character", () => {
    const defaults = Object.values(GEMINI_VOICE_BY_CHARACTER_V1);
    for (const voiceName of defaults) {
      expect(isGeminiVoiceNameV1(voiceName)).toBe(true);
    }
    // The point of the per-character defaults is that two Bots sound different
    // before either has been named aloud, so a duplicate would defeat them.
    expect(new Set(defaults).size).toBe(defaults.length);
    expect(isGeminiVoiceNameV1(DEFAULT_GEMINI_VOICE_V1)).toBe(true);
  });

  test("keeps every preset slug unique", () => {
    expect(new Set(VOICE_ACCENTS_V1.map((accent) => accent.slug)).size).toBe(
      VOICE_ACCENTS_V1.length,
    );
    expect(
      new Set(VOICE_ATTITUDES_V1.map((attitude) => attitude.slug)).size,
    ).toBe(VOICE_ATTITUDES_V1.length);
  });
});

describe("renderVoiceInstructionV1", () => {
  test("says nothing when nothing is set", () => {
    expect(renderVoiceInstructionV1({})).toBe("");
    // A custom line of only whitespace is nothing, not a blank bullet.
    expect(renderVoiceInstructionV1({ custom: "   " })).toBe("");
  });

  test("pins the language beside every accent it renders", () => {
    for (const accent of VOICE_ACCENTS_V1) {
      const rendered = renderVoiceInstructionV1({ accent: accent.slug });
      expect(rendered).toContain(accent.prose);
      // Native audio rejects `languageCode`, so the tag has to be in the prose.
      expect(rendered).toContain(`RESPOND IN ${accent.language} ENGLISH`);
      expect(rendered.startsWith("How you sound:\n- ")).toBe(true);
    }
  });

  test("renders every attitude as its own line", () => {
    for (const attitude of VOICE_ATTITUDES_V1) {
      expect(renderVoiceInstructionV1({ attitude: attitude.slug })).toBe(
        `How you sound:\n- ${attitude.prose}`,
      );
    }
  });

  test("renders each dial that has something to say, and skips the ones that do not", () => {
    // "natural" and "neutral" are the model's own behaviour: saying so would
    // spend instruction on a no-op.
    expect(
      renderVoiceInstructionV1({
        pace: "natural",
        turnLength: "natural",
        formality: "neutral",
      }),
    ).toBe("");
    expect(renderVoiceInstructionV1({ pace: "slower" })).toContain("slower");
    expect(renderVoiceInstructionV1({ pace: "faster" })).toContain("faster");
    expect(renderVoiceInstructionV1({ turnLength: "terse" })).toContain(
      "Keep every reply short",
    );
    expect(renderVoiceInstructionV1({ turnLength: "chatty" })).toContain(
      "a few sentences",
    );
    expect(renderVoiceInstructionV1({ humour: "none" })).toContain("No jokes.");
    expect(renderVoiceInstructionV1({ humour: "dry" })).toContain("Dry humour");
    expect(renderVoiceInstructionV1({ humour: "playful" })).toContain(
      "Playful humour",
    );
    expect(renderVoiceInstructionV1({ disfluency: "clean" })).toContain(
      "without filler words",
    );
    expect(renderVoiceInstructionV1({ disfluency: "natural" })).toContain(
      "Sound natural",
    );
    expect(renderVoiceInstructionV1({ formality: "casual" })).toContain(
      "Casual register",
    );
    expect(renderVoiceInstructionV1({ formality: "formal" })).toBe(
      "How you sound:\n- Formal register.",
    );
  });

  test("orders the block accent, attitude, dials, then the person's own words", () => {
    const rendered = renderVoiceInstructionV1({
      custom: "Call me boss.",
      formality: "formal",
      pace: "slower",
      attitude: "dry-deadpan",
      accent: "australian",
    });
    const lines = rendered.split("\n");
    expect(lines[0]).toBe("How you sound:");
    expect(lines[1]).toContain("Australian accent");
    expect(lines[2]).toContain("dry and deadpan");
    expect(lines[3]).toContain("slower");
    expect(lines[4]).toContain("Formal register");
    // Last, so it wins a tie against anything a preset said.
    expect(lines.at(-1)).toBe("- Call me boss.");
  });

  test("ignores a slug that is not in the tables", () => {
    // The renderer never validates; the decoder is what refuses. A slug that
    // somehow reaches it is dropped rather than pasted into the instruction.
    expect(renderVoiceInstructionV1({ accent: "klingon" })).toBe("");
    expect(renderVoiceInstructionV1({ attitude: "menacing" })).toBe("");
  });
});

describe("decodeBotVoiceAppearanceV1", () => {
  test("accepts every accent and attitude the tables hold", () => {
    for (const accent of VOICE_ACCENTS_V1) {
      expect(
        decodeBotVoiceAppearanceV1(appearance({ accent: accent.slug })),
      ).toEqual(appearance({ accent: accent.slug }));
    }
    for (const attitude of VOICE_ATTITUDES_V1) {
      expect(
        decodeBotVoiceAppearanceV1(appearance({ attitude: attitude.slug })),
      ).toEqual(appearance({ attitude: attitude.slug }));
    }
  });

  test("accepts every prebuilt voice and every dial value", () => {
    for (const voice of GEMINI_VOICES_V1) {
      expect(
        decodeBotVoiceAppearanceV1({
          schemaVersion: 1,
          voiceName: voice.voiceName,
          delivery: {},
        }).voiceName,
      ).toBe(voice.voiceName);
    }
    const full: VoiceDeliveryV1 = {
      accent: "australian",
      attitude: "blunt-direct",
      pace: "faster",
      turnLength: "terse",
      humour: "dry",
      disfluency: "clean",
      formality: "casual",
      custom: "Never say 'certainly'.",
    };
    expect(decodeBotVoiceAppearanceV1(appearance(full))).toEqual(
      appearance(full),
    );
  });

  test("treats an absent delivery as an empty one", () => {
    expect(
      decodeBotVoiceAppearanceV1({ schemaVersion: 1, voiceName: VOICE }),
    ).toEqual(appearance({}));
  });

  test("refuses an unknown key, at either level", () => {
    expect(() =>
      decodeBotVoiceAppearanceV1({ ...appearance({}), speed: 2 }),
    ).toThrow("voice appearance has an unknown key");
    expect(() =>
      decodeBotVoiceAppearanceV1({
        schemaVersion: 1,
        voiceName: VOICE,
        delivery: { accent: "australian", volume: "loud" },
      }),
    ).toThrow("voice delivery has an unknown key");
  });

  test("refuses an unknown slug or dial value", () => {
    expect(() =>
      decodeBotVoiceAppearanceV1(appearance({ accent: "klingon" })),
    ).toThrow("voice accent is invalid");
    expect(() =>
      decodeBotVoiceAppearanceV1(appearance({ attitude: "menacing" })),
    ).toThrow("voice attitude is invalid");
    expect(() =>
      decodeBotVoiceAppearanceV1(
        appearance({ pace: "breakneck" as VoiceDeliveryV1["pace"] }),
      ),
    ).toThrow("voice pace is invalid");
    expect(() =>
      decodeBotVoiceAppearanceV1(
        appearance({ humour: "wry" as VoiceDeliveryV1["humour"] }),
      ),
    ).toThrow("voice humour is invalid");
    expect(() =>
      decodeBotVoiceAppearanceV1({
        schemaVersion: 1,
        voiceName: "Siri",
        delivery: {},
      }),
    ).toThrow("voice name is not one the deployment offers");
    expect(() =>
      decodeBotVoiceAppearanceV1({ ...appearance({}), schemaVersion: 2 }),
    ).toThrow("voice appearance schema version is invalid");
    expect(() => decodeBotVoiceAppearanceV1("Schedar")).toThrow(
      "voice appearance must be an object",
    );
    expect(() =>
      decodeBotVoiceAppearanceV1({
        schemaVersion: 1,
        voiceName: VOICE,
        delivery: [],
      }),
    ).toThrow("voice delivery must be an object");
  });

  test("bounds the person's own words, and keeps them verbatim up to the bound", () => {
    const longest = "x".repeat(VOICE_CUSTOM_MAX_CHARS_V1);
    expect(
      decodeBotVoiceAppearanceV1(appearance({ custom: longest })).delivery
        .custom,
    ).toBe(longest);
    expect(() =>
      decodeBotVoiceAppearanceV1(appearance({ custom: `${longest}x` })),
    ).toThrow("voice custom instruction is invalid");
    expect(() =>
      decodeBotVoiceAppearanceV1(
        appearance({ custom: 12 as unknown as string }),
      ),
    ).toThrow("voice custom instruction is invalid");
  });
});

describe("resolveBotVoiceV1", () => {
  test("answers the Bot's own voice when it has one", () => {
    const chosen = appearance({ accent: "irish" });
    expect(resolveBotVoiceV1({ chosen, characterId: "cat" })).toEqual(chosen);
  });

  test("falls back to the character's default, with no delivery", () => {
    for (const [characterId, voiceName] of Object.entries(
      GEMINI_VOICE_BY_CHARACTER_V1,
    )) {
      expect(resolveBotVoiceV1({ characterId })).toEqual({
        schemaVersion: 1,
        voiceName,
        delivery: {},
      });
      expect(defaultGeminiVoiceForCharacterV1(characterId)).toBe(voiceName);
    }
  });

  test("falls back to the deployment default for an unknown or absent character", () => {
    expect(resolveBotVoiceV1({})).toEqual({
      schemaVersion: 1,
      voiceName: DEFAULT_GEMINI_VOICE_V1,
      delivery: {},
    });
    expect(resolveBotVoiceV1({ characterId: "wombat" }).voiceName).toBe(
      DEFAULT_GEMINI_VOICE_V1,
    );
    expect(defaultGeminiVoiceForCharacterV1(undefined)).toBe(
      DEFAULT_GEMINI_VOICE_V1,
    );
  });

  test("always resolves to something the decoder accepts", () => {
    for (const characterId of Object.keys(GEMINI_VOICE_BY_CHARACTER_V1)) {
      const resolved = resolveBotVoiceV1({ characterId });
      expect(decodeBotVoiceAppearanceV1(resolved)).toEqual(resolved);
      expect(renderVoiceInstructionV1(resolved.delivery)).toBe("");
    }
  });
});
