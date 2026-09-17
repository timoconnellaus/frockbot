// The voices a Bot may speak in (ADR 0029, decision 4).
//
// A call wears one Bot, and what tells the person who answered — before any
// name is said — is the voice. So a Bot carries a voice the way it carries an
// avatar: chosen from a curated list, defaulted from its character so two
// Bots never sound the same without anyone choosing, and falling back to the
// deployment's own voice when neither says.
//
// The list is curated rather than free text on purpose. A Bot setting that
// took any ElevenLabs voice id would be a way to bill the account for a voice
// nobody vetted, and a typo would be a call that cannot speak at all.

/** One voice a Bot may be given, as the settings picker shows it. */
export interface VoiceOptionV1 {
  /** The provider's voice id, sent to ElevenLabs. */
  voiceId: string;
  /** What the picker calls it. */
  name: string;
  /** One line about how it sounds, so a choice can be made without playing it. */
  description: string;
}

/**
 * The deployment's curated voices.
 *
 * Every id here was read back from this deployment's own ElevenLabs account
 * on 2026-09-17, because a voice id the account cannot reach does not fail
 * loudly — it reaches a person as a sentence that never becomes sound. The
 * provider's well-known "premade" ids are NOT all reachable: most of them are
 * absent from this account, so a plausible-looking list copied from the
 * provider's documentation is exactly the thing that breaks.
 *
 * They have been verified to exist, not auditioned. The names and the
 * one-liners come from the account's own labels; before a Bot's voice is
 * something a person picks in settings, play each one and swap anything that
 * does not suit its character.
 *
 * They are data, not code: a deployment that wants a different set edits this
 * list, and nothing else changes — the Bot setting validates against whatever
 * is here. Re-verify after editing.
 */
export const VOICE_CATALOG_V1: readonly VoiceOptionV1[] = [
  {
    voiceId: "cjVigY5qzO86Huf0OWal",
    name: "Eric",
    description: "American, smooth and even; a steady middle of the road.",
  },
  {
    voiceId: "hpp4J3VqNfWAUOO0d1Us",
    name: "Bella",
    description: "American, warm and bright, with a polished edge.",
  },
  {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    description: "American, reassuring and confident.",
  },
  {
    voiceId: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda",
    description: "American, upbeat, a pleasing alto.",
  },
  {
    voiceId: "FGY2WhTYpPnrIDTdsKH5",
    name: "Laura",
    description: "American, young; sunny enthusiasm with a quirky attitude.",
  },
  {
    voiceId: "cgSgspJ2msm6clMCkdW9",
    name: "Jessica",
    description: "American, young, playful and quick.",
  },
  {
    voiceId: "SAz9YHcvj6GT2YYXdXww",
    name: "River",
    description: "American, gender-neutral, relaxed and unhurried.",
  },
  {
    voiceId: "bIHbv24MWmeRgasZH58o",
    name: "Will",
    description: "American, young, conversational and laid back.",
  },
  {
    voiceId: "iP95p4xoKVk53GoZ742B",
    name: "Chris",
    description: "American, down to earth and natural.",
  },
  {
    voiceId: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    description: "American, deep and resonant; comforting.",
  },
  {
    voiceId: "N2lVS1w4EtoT3dr4eOWO",
    name: "Callum",
    description: "Gravelly, with a sly edge.",
  },
  {
    voiceId: "pqHfZKP75CvOlQylNhV4",
    name: "Bill",
    description: "American, older; wise and unhurried.",
  },
  {
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    name: "George",
    description: "British, warm and resonant; a storyteller.",
  },
  {
    voiceId: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel",
    description: "British, formal and steady; a broadcaster.",
  },
  {
    voiceId: "Xb7hH8MSUJpSbSDYk0k2",
    name: "Alice",
    description: "British, clear and friendly.",
  },
  {
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
    name: "Lily",
    description: "British, velvety, warm and clear.",
  },
  {
    voiceId: "bnr31VMIPcsgqWJQh7Fs",
    name: "Bec",
    description: "Australian, smooth mid-range and professional.",
  },
  {
    voiceId: "DYkrAHD8iwork3YSUBbs",
    name: "Tom",
    description: "Australian, easygoing yet clear; low in pitch.",
  },
  {
    voiceId: "mkrzc6Zmz8alRK0wX5dd",
    name: "Jason",
    description: "Australian, friendly and educated.",
  },
  {
    voiceId: "IKne3meq5aSn9XLyUdCD",
    name: "Charlie",
    description: "Australian, young, confident and energetic.",
  },
];

/**
 * The voice each character speaks in unless its Bot says otherwise.
 *
 * Keyed by `characterId` from the avatar catalog, so a Bot that has only ever
 * chosen a look already has a voice that matches it — and two Bots wearing
 * different characters sound different without anybody opening settings. A
 * character missing from this map falls back to the deployment's voice.
 *
 * The spread across gender, accent and age is deliberate: what tells the
 * person who answered, before a name is said, is how different two voices are
 * from each other, not how apt either one is on its own.
 */
export const VOICE_BY_CHARACTER_V1: Readonly<Record<string, string>> = {
  pixel: "SAz9YHcvj6GT2YYXdXww", // River — neutral and calm, to suit the one that is not an animal
  guardian: "onwK4e9ZLuTAKqWW03F9", // Daniel — steady and formal
  sunny: "FGY2WhTYpPnrIDTdsKH5", // Laura — sunny, which is the whole character
  chill: "bIHbv24MWmeRgasZH58o", // Will — laid back
  nudge: "mkrzc6Zmz8alRK0wX5dd", // Jason — friendly, for the one that prods
  fox: "N2lVS1w4EtoT3dr4eOWO", // Callum — sly
  dog: "DYkrAHD8iwork3YSUBbs", // Tom — easygoing and familiar
  goat: "pqHfZKP75CvOlQylNhV4", // Bill — old and deliberate
  cow: "bnr31VMIPcsgqWJQh7Fs", // Bec — smooth and gentle
  cat: "pFZP5JQG7iQjIQuC4Bku", // Lily — velvety and cool
  rabbit: "cgSgspJ2msm6clMCkdW9", // Jessica — young and quick
};

/** Whether this is a voice the deployment offers. */
export function isVoiceIdV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    VOICE_CATALOG_V1.some((voice) => voice.voiceId === value)
  );
}

/**
 * The voice a Bot speaks in: its own choice, else its character's, else the
 * deployment's own. Returns nothing when there is no deployment voice either,
 * which is the case the caller answers by not speaking at all.
 */
export function resolveVoiceIdV1(input: {
  /** The Bot's chosen voice, if it has one. */
  chosen?: string;
  /** The Bot's character, from its avatar. */
  characterId?: string;
  /** `ELEVENLABS_VOICE_ID`, the deployment's fallback. */
  fallback?: string;
}): string | undefined {
  if (isVoiceIdV1(input.chosen)) return input.chosen;
  const byCharacter = input.characterId
    ? VOICE_BY_CHARACTER_V1[input.characterId]
    : undefined;
  if (byCharacter) return byCharacter;
  const fallback = input.fallback?.trim();
  return fallback ? fallback : undefined;
}
