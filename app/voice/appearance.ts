// How a Bot sounds (ADR 0031).
//
// Gemini Live has exactly one typed voice field — the prebuilt voice name —
// and everything else about delivery is prose in the system instruction. A
// Bot's voice mirrors that split: a `voiceName` from the fixed list, and a
// `delivery` record of preset slugs that this module renders into prose at
// call start. Slugs, never rendered text, are what the Bot stores, so the
// wording of "dry and deadpan" can improve for every Bot at once.
//
// Language is derived, never stored: an accent slug resolves to both the
// BCP-47 tag and the sentence, because native-audio models reject
// `languageCode` outright and auto-detect — the pin has to be prose.

/** One of Gemini's prebuilt voices, as the settings picker shows it. */
export interface GeminiVoiceOptionV1 {
  /** Sent as `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. */
  voiceName: string;
  /** Google's one-word character for the voice. */
  character: string;
}

/**
 * The thirty prebuilt voices native-audio models accept, with Google's own
 * one-word characterisation of each. Data, not code: the settings picker
 * validates against this list and the renderer never reads it.
 */
export const GEMINI_VOICES_V1: readonly GeminiVoiceOptionV1[] = [
  { voiceName: "Zephyr", character: "Bright" },
  { voiceName: "Puck", character: "Upbeat" },
  { voiceName: "Charon", character: "Informative" },
  { voiceName: "Kore", character: "Firm" },
  { voiceName: "Fenrir", character: "Excitable" },
  { voiceName: "Leda", character: "Youthful" },
  { voiceName: "Orus", character: "Firm" },
  { voiceName: "Aoede", character: "Breezy" },
  { voiceName: "Callirrhoe", character: "Easy-going" },
  { voiceName: "Autonoe", character: "Bright" },
  { voiceName: "Enceladus", character: "Breathy" },
  { voiceName: "Iapetus", character: "Clear" },
  { voiceName: "Umbriel", character: "Easy-going" },
  { voiceName: "Algieba", character: "Smooth" },
  { voiceName: "Despina", character: "Smooth" },
  { voiceName: "Erinome", character: "Clear" },
  { voiceName: "Algenib", character: "Gravelly" },
  { voiceName: "Rasalgethi", character: "Informative" },
  { voiceName: "Laomedeia", character: "Upbeat" },
  { voiceName: "Achernar", character: "Soft" },
  { voiceName: "Alnilam", character: "Firm" },
  { voiceName: "Schedar", character: "Even" },
  { voiceName: "Gacrux", character: "Mature" },
  { voiceName: "Pulcherrima", character: "Forward" },
  { voiceName: "Achird", character: "Friendly" },
  { voiceName: "Zubenelgenubi", character: "Casual" },
  { voiceName: "Vindemiatrix", character: "Gentle" },
  { voiceName: "Sadachbia", character: "Lively" },
  { voiceName: "Sadaltager", character: "Knowledgeable" },
  { voiceName: "Sulafat", character: "Warm" },
];

export function isGeminiVoiceNameV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    GEMINI_VOICES_V1.some((voice) => voice.voiceName === value)
  );
}

/** The voice used when nothing — not the Bot, not its character — says. */
export const DEFAULT_GEMINI_VOICE_V1 = "Schedar";

/**
 * A default voice per character, so two Bots never sound the same without
 * anyone opening settings. The spread across the list is deliberate: what
 * tells the person who answered, before a name is said, is how different two
 * voices are from each other.
 */
export const GEMINI_VOICE_BY_CHARACTER_V1: Readonly<Record<string, string>> = {
  pixel: "Schedar", // even and calm, for the one that is not an animal
  guardian: "Orus", // firm and steady
  sunny: "Puck", // upbeat, which is the whole character
  chill: "Callirrhoe", // easy-going
  nudge: "Achird", // friendly, for the one that prods
  fox: "Zubenelgenubi", // casual, a little sly
  dog: "Sulafat", // warm and familiar
  goat: "Gacrux", // mature and deliberate
  cow: "Vindemiatrix", // gentle
  cat: "Despina", // smooth and cool
  rabbit: "Leda", // youthful and quick
};

export function defaultGeminiVoiceForCharacterV1(
  characterId: string | undefined,
): string {
  return (
    (characterId ? GEMINI_VOICE_BY_CHARACTER_V1[characterId] : undefined) ??
    DEFAULT_GEMINI_VOICE_V1
  );
}

// -- presets ------------------------------------------------------------------

/** An accent preset: the pin the prose needs, and the sentence itself. */
export interface VoiceAccentPresetV1 {
  slug: string;
  label: string;
  /** BCP-47, stated in the prose because native audio rejects `languageCode`. */
  language: string;
  prose: string;
}

export const VOICE_ACCENTS_V1: readonly VoiceAccentPresetV1[] = [
  {
    slug: "australian",
    label: "Australian",
    language: "en-AU",
    prose: "Speak English with an Australian accent.",
  },
  {
    slug: "british",
    label: "British",
    language: "en-GB",
    prose: "Speak English with a British accent, received pronunciation.",
  },
  {
    slug: "northern-english",
    label: "Northern English",
    language: "en-GB",
    prose: "Speak English with a Northern English accent.",
  },
  {
    slug: "scottish",
    label: "Scottish",
    language: "en-GB",
    prose: "Speak English with a Scottish accent.",
  },
  {
    slug: "irish",
    label: "Irish",
    language: "en-IE",
    prose: "Speak English with an Irish accent.",
  },
  {
    slug: "american",
    label: "American",
    language: "en-US",
    prose: "Speak English with a general American accent.",
  },
  {
    slug: "southern-us",
    label: "Southern US",
    language: "en-US",
    prose: "Speak English with a Southern US accent.",
  },
  {
    slug: "canadian",
    label: "Canadian",
    language: "en-CA",
    prose: "Speak English with a Canadian accent.",
  },
  {
    slug: "new-zealand",
    label: "New Zealand",
    language: "en-NZ",
    prose: "Speak English with a New Zealand accent.",
  },
  {
    slug: "south-african",
    label: "South African",
    language: "en-ZA",
    prose: "Speak English with a South African accent.",
  },
  {
    slug: "indian",
    label: "Indian",
    language: "en-IN",
    prose: "Speak English with an Indian English accent.",
  },
];

/** An attitude: a personality, so exactly one is chosen. */
export interface VoiceAttitudePresetV1 {
  slug: string;
  label: string;
  prose: string;
}

export const VOICE_ATTITUDES_V1: readonly VoiceAttitudePresetV1[] = [
  {
    slug: "warm-friendly",
    label: "Warm & friendly",
    prose:
      "You are warm and friendly: open, easy, a little lift in your voice.",
  },
  {
    slug: "calm-reassuring",
    label: "Calm & reassuring",
    prose:
      "You are calm and reassuring: steady, unhurried, you lower the temperature.",
  },
  {
    slug: "brisk-efficient",
    label: "Brisk & efficient",
    prose:
      "You are brisk and efficient: you get to the point with no ceremony.",
  },
  {
    slug: "upbeat-energetic",
    label: "Upbeat & energetic",
    prose: "You are upbeat and energetic: bright, enthusiastic, fully engaged.",
  },
  {
    slug: "dry-deadpan",
    label: "Dry & deadpan",
    prose:
      "You are dry and deadpan: flat affect, understated, humour without ever signalling it.",
  },
  {
    slug: "playful-teasing",
    label: "Playful & teasing",
    prose:
      "You are playful and teasing: light, a little mischievous, you banter back.",
  },
  {
    slug: "professional-neutral",
    label: "Professional & neutral",
    prose: "You are professional and neutral: polished, with no strong colour.",
  },
  {
    slug: "blunt-direct",
    label: "Blunt & direct",
    prose: "You are blunt and direct: you say the thing, with no cushioning.",
  },
  {
    slug: "thoughtful-measured",
    label: "Thoughtful & measured",
    prose:
      "You are thoughtful and measured: you pause, consider, and think out loud.",
  },
  {
    slug: "gentle-patient",
    label: "Gentle & patient",
    prose:
      "You are gentle and patient: soft, never rushing, careful with anything sensitive.",
  },
  {
    slug: "nerdy-enthusiastic",
    label: "Nerdy & enthusiastic",
    prose: "You are nerdy and enthusiastic: genuinely delighted by detail.",
  },
  {
    slug: "low-key-conspiratorial",
    label: "Low-key & conspiratorial",
    prose:
      "You are low-key and conspiratorial: quieter, as if it is just between the two of you.",
  },
];

export type VoicePaceV1 = "slower" | "natural" | "faster";
export type VoiceTurnLengthV1 = "terse" | "natural" | "chatty";
export type VoiceHumourV1 = "none" | "dry" | "playful";
export type VoiceDisfluencyV1 = "clean" | "natural";
export type VoiceFormalityV1 = "casual" | "neutral" | "formal";

/** The dials: independent of each other and of the attitude. */
export interface VoiceDeliveryV1 {
  accent?: string;
  attitude?: string;
  pace?: VoicePaceV1;
  turnLength?: VoiceTurnLengthV1;
  humour?: VoiceHumourV1;
  disfluency?: VoiceDisfluencyV1;
  formality?: VoiceFormalityV1;
  /** The person's own words, appended last so they win a tie. */
  custom?: string;
}

/** What a Bot stores. Mirrors Gemini's split: one typed field, then prose. */
export interface BotVoiceAppearanceV1 {
  schemaVersion: 1;
  voiceName: string;
  delivery: VoiceDeliveryV1;
}

export const VOICE_CUSTOM_MAX_CHARS_V1 = 500;

const PACE_PROSE: Readonly<Record<VoicePaceV1, string | undefined>> = {
  slower: "Speak a little slower than usual.",
  natural: undefined,
  faster: "Speak a little faster than usual, still clearly.",
};
const TURN_LENGTH_PROSE: Readonly<
  Record<VoiceTurnLengthV1, string | undefined>
> = {
  terse: "Keep every reply short: one or two sentences unless asked for more.",
  natural: undefined,
  chatty: "You may take a few sentences when there is something worth saying.",
};
const HUMOUR_PROSE: Readonly<Record<VoiceHumourV1, string | undefined>> = {
  none: "No jokes.",
  dry: "Dry humour, used sparingly and never explained.",
  playful: "Playful humour is welcome.",
};
const DISFLUENCY_PROSE: Readonly<
  Record<VoiceDisfluencyV1, string | undefined>
> = {
  clean: "Speak cleanly, without filler words.",
  natural: "Sound natural: the occasional 'so', 'well' or 'hmm' is fine.",
};
const FORMALITY_PROSE: Readonly<Record<VoiceFormalityV1, string | undefined>> =
  {
    casual: "Casual register, like a friend.",
    neutral: undefined,
    formal: "Formal register.",
  };

const PACES: readonly VoicePaceV1[] = ["slower", "natural", "faster"];
const TURN_LENGTHS: readonly VoiceTurnLengthV1[] = [
  "terse",
  "natural",
  "chatty",
];
const HUMOURS: readonly VoiceHumourV1[] = ["none", "dry", "playful"];
const DISFLUENCIES: readonly VoiceDisfluencyV1[] = ["clean", "natural"];
const FORMALITIES: readonly VoiceFormalityV1[] = [
  "casual",
  "neutral",
  "formal",
];

export function findVoiceAccentV1(slug: string | undefined) {
  return slug
    ? VOICE_ACCENTS_V1.find((accent) => accent.slug === slug)
    : undefined;
}
export function findVoiceAttitudeV1(slug: string | undefined) {
  return slug
    ? VOICE_ATTITUDES_V1.find((attitude) => attitude.slug === slug)
    : undefined;
}

/**
 * The delivery block of the system instruction: how this Bot sounds.
 *
 * Google's Live guidance orders a system instruction persona → rules →
 * guardrails; this block belongs in the persona and the caller places it
 * there, after the Bot's name and description. The order inside is fixed:
 * accent with its language pin first (the one Google says must travel
 * together), then attitude, then the dials, then the person's own words.
 * Returns an empty string when nothing is set, so a caller can skip it.
 */
export function renderVoiceInstructionV1(delivery: VoiceDeliveryV1): string {
  const lines: string[] = [];
  const accent = findVoiceAccentV1(delivery.accent);
  if (accent) {
    lines.push(
      `${accent.prose} RESPOND IN ${accent.language} ENGLISH. YOU MUST RESPOND UNMISTAKABLY IN ENGLISH.`,
    );
  }
  const attitude = findVoiceAttitudeV1(delivery.attitude);
  if (attitude) lines.push(attitude.prose);
  for (const line of [
    delivery.pace ? PACE_PROSE[delivery.pace] : undefined,
    delivery.turnLength ? TURN_LENGTH_PROSE[delivery.turnLength] : undefined,
    delivery.humour ? HUMOUR_PROSE[delivery.humour] : undefined,
    delivery.disfluency ? DISFLUENCY_PROSE[delivery.disfluency] : undefined,
    delivery.formality ? FORMALITY_PROSE[delivery.formality] : undefined,
  ]) {
    if (line) lines.push(line);
  }
  const custom = delivery.custom?.trim();
  if (custom) lines.push(custom);
  if (lines.length === 0) return "";
  return `How you sound:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

// -- decoding -----------------------------------------------------------------

export class VoiceAppearanceDecodeError extends Error {
  override readonly name = "VoiceAppearanceDecodeError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new VoiceAppearanceDecodeError(`voice ${label} is invalid`);
  }
  return value as T;
}

/**
 * Strict: an unknown key, an unknown slug or an over-long custom line is
 * refused, because what is stored here is read into a prompt on every call.
 */
export function decodeBotVoiceAppearanceV1(
  input: unknown,
): BotVoiceAppearanceV1 {
  if (!isRecord(input)) {
    throw new VoiceAppearanceDecodeError("voice appearance must be an object");
  }
  const keys = Reflect.ownKeys(input).filter(
    (key) => key !== Symbol.dispose && key !== Symbol.asyncDispose,
  );
  for (const key of keys) {
    if (key !== "schemaVersion" && key !== "voiceName" && key !== "delivery") {
      throw new VoiceAppearanceDecodeError(
        "voice appearance has an unknown key",
      );
    }
  }
  if (input.schemaVersion !== 1) {
    throw new VoiceAppearanceDecodeError(
      "voice appearance schema version is invalid",
    );
  }
  if (!isGeminiVoiceNameV1(input.voiceName)) {
    throw new VoiceAppearanceDecodeError(
      "voice name is not one the deployment offers",
    );
  }
  const delivery = input.delivery ?? {};
  if (!isRecord(delivery)) {
    throw new VoiceAppearanceDecodeError("voice delivery must be an object");
  }
  const deliveryKeys = Reflect.ownKeys(delivery).filter(
    (key) => key !== Symbol.dispose && key !== Symbol.asyncDispose,
  );
  const allowed = new Set([
    "accent",
    "attitude",
    "pace",
    "turnLength",
    "humour",
    "disfluency",
    "formality",
    "custom",
  ]);
  for (const key of deliveryKeys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new VoiceAppearanceDecodeError("voice delivery has an unknown key");
    }
  }
  const accent = delivery.accent;
  if (accent !== undefined && !findVoiceAccentV1(accent as string)) {
    throw new VoiceAppearanceDecodeError("voice accent is invalid");
  }
  const attitude = delivery.attitude;
  if (attitude !== undefined && !findVoiceAttitudeV1(attitude as string)) {
    throw new VoiceAppearanceDecodeError("voice attitude is invalid");
  }
  const custom = delivery.custom;
  if (
    custom !== undefined &&
    (typeof custom !== "string" || custom.length > VOICE_CUSTOM_MAX_CHARS_V1)
  ) {
    throw new VoiceAppearanceDecodeError("voice custom instruction is invalid");
  }
  const out: VoiceDeliveryV1 = {};
  if (accent !== undefined) out.accent = accent as string;
  if (attitude !== undefined) out.attitude = attitude as string;
  const pace = oneOf(delivery.pace, PACES, "pace");
  if (pace) out.pace = pace;
  const turnLength = oneOf(delivery.turnLength, TURN_LENGTHS, "turn length");
  if (turnLength) out.turnLength = turnLength;
  const humour = oneOf(delivery.humour, HUMOURS, "humour");
  if (humour) out.humour = humour;
  const disfluency = oneOf(delivery.disfluency, DISFLUENCIES, "disfluency");
  if (disfluency) out.disfluency = disfluency;
  const formality = oneOf(delivery.formality, FORMALITIES, "formality");
  if (formality) out.formality = formality;
  if (custom !== undefined) out.custom = custom as string;
  return { schemaVersion: 1, voiceName: input.voiceName, delivery: out };
}

/**
 * The voice a Bot speaks in: its own, else its character's default with no
 * delivery presets. Never undefined — Gemini always has a voice to give.
 */
export function resolveBotVoiceV1(input: {
  chosen?: BotVoiceAppearanceV1;
  characterId?: string;
}): BotVoiceAppearanceV1 {
  if (input.chosen) return input.chosen;
  return {
    schemaVersion: 1,
    voiceName: defaultGeminiVoiceForCharacterV1(input.characterId),
    delivery: {},
  };
}
