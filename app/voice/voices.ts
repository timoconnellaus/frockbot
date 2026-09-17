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
 * These are ElevenLabs' long-standing public premade voices, which every
 * account has access to. They are data, not code: a deployment that wants a
 * different set edits this list, and nothing else changes — the Bot setting
 * validates against whatever is here.
 *
 * They have not been listened to against this account. Before the first
 * release that ships per-Bot voices, play each one and swap anything that
 * does not suit its character; a voice id this account cannot reach would
 * otherwise reach a person as a sentence that never becomes sound.
 */
export const VOICE_CATALOG_V1: readonly VoiceOptionV1[] = [
  {
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    name: "Rachel",
    description: "Calm and even; a steady reading voice.",
  },
  {
    voiceId: "AZnzlk1XvdvUeBnXmlld",
    name: "Domi",
    description: "Bright and quick, with a lift at the end of a sentence.",
  },
  {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    name: "Bella",
    description: "Soft and unhurried.",
  },
  {
    voiceId: "ErXwobaYiN019PkySvjV",
    name: "Antoni",
    description: "Warm and conversational.",
  },
  {
    voiceId: "MF3mGyEYCl7XYWbV9V6O",
    name: "Elli",
    description: "Young and cheerful.",
  },
  {
    voiceId: "TxGEqnHWrfWFTfGW9XjX",
    name: "Josh",
    description: "Energetic and direct.",
  },
  {
    voiceId: "VR6AewLTigWG4xSOukaG",
    name: "Arnold",
    description: "Low and deliberate.",
  },
  {
    voiceId: "pNInz6obpgDQGcFmaJgB",
    name: "Adam",
    description: "Neutral and clear; the least characterful of the set.",
  },
  {
    voiceId: "yoZ06aMxZJJ28mfd3POQ",
    name: "Sam",
    description: "Easy and familiar, like someone thinking aloud.",
  },
  {
    voiceId: "IKne3meq5aSn9XLyUdCD",
    name: "Charlie",
    description: "Casual and light on its feet.",
  },
  {
    voiceId: "ThT5KcBeYPX3keUQqHPh",
    name: "Dorothy",
    description: "Gentle and measured.",
  },
  {
    voiceId: "N2lVS1w4EtoT3dr4eOWO",
    name: "Callum",
    description: "Serious and grounded.",
  },
  {
    voiceId: "XB0fDUnXU5powFXDhCwa",
    name: "Charlotte",
    description: "Cool and precise.",
  },
  {
    voiceId: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda",
    description: "Friendly and a little playful.",
  },
];

/**
 * The voice each character speaks in unless its Bot says otherwise.
 *
 * Keyed by `characterId` from the avatar catalog, so a Bot that has only ever
 * chosen a look already has a voice that matches it — and two Bots wearing
 * different characters sound different without anybody opening settings. A
 * character missing from this map falls back to the deployment's voice.
 */
export const VOICE_BY_CHARACTER_V1: Readonly<Record<string, string>> = {
  pixel: "XrExE9yKIg1WjnnlVkGX", // Matilda — playful, to match the pink
  guardian: "N2lVS1w4EtoT3dr4eOWO", // Callum — serious and grounded
  sunny: "MF3mGyEYCl7XYWbV9V6O", // Elli — bright
  chill: "IKne3meq5aSn9XLyUdCD", // Charlie — easy going
  nudge: "TxGEqnHWrfWFTfGW9XjX", // Josh — energetic, it is the one that prods
  fox: "ErXwobaYiN019PkySvjV", // Antoni — warm
  dog: "yoZ06aMxZJJ28mfd3POQ", // Sam — familiar
  goat: "VR6AewLTigWG4xSOukaG", // Arnold — low and deliberate
  cow: "ThT5KcBeYPX3keUQqHPh", // Dorothy — gentle
  cat: "XB0fDUnXU5powFXDhCwa", // Charlotte — cool and precise
  rabbit: "AZnzlk1XvdvUeBnXmlld", // Domi — quick
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
