// The closed ThemeDocument the client paints from and `theme/assemble` replaces.
//
// Named looks are compiled here. A Plugin may wrap the result; the kernel
// re-validates every replacement, including the contrast floor, and a failing
// document is skipped so the last good one stays.

export type HexColorV1 = string;

export type AccountLookV1 = "ink" | "paper" | "system";
/** Named Bot picks. More built-ins join this list; Custom is a stored document. */
export type BuiltInBotLookV1 = "inherit" | "studio";
export type BotLookV1 = BuiltInBotLookV1 | "custom";
export type NamedLookV1 = "ink" | "paper" | "studio";
export type ThemeTypefaceV1 = "manrope" | "inter";
export type BotBubbleV1 = "plain" | "raised";
export type MeBubbleV1 = "accent" | "tint";

export const ACCOUNT_LOOKS_V1 = ["ink", "paper", "system"] as const;
export const BUILT_IN_BOT_LOOKS_V1 = ["inherit", "studio"] as const;
export const BOT_LOOKS_V1 = ["inherit", "studio", "custom"] as const;
export const NAMED_LOOKS_V1 = ["ink", "paper", "studio"] as const;
export const THEME_TYPEFACES_V1 = ["manrope", "inter"] as const;
export const BOT_BUBBLES_V1 = ["plain", "raised"] as const;
export const ME_BUBBLES_V1 = ["accent", "tint"] as const;

/** Keys a ThemeDocument may never carry. Trust chrome is not a theme. */
export const THEME_FORBIDDEN_KEYS_V1 = [
  "approval",
  "billing",
  "Stop",
  "grants",
] as const;

const HEX_COLOR_V1 = /^#[0-9A-Fa-f]{6}$/;
const PHASE_AFTER_V1 = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PHASES_V1 = 24;
const TEXT_CONTRAST_FLOOR_V1 = 4.5;
const MUTED_CONTRAST_FLOOR_V1 = 3;

export class ThemeDocumentDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThemeDocumentDecodeError";
  }
}

export interface ThemeSurfacesV1 {
  window: string;
  surface: string;
  raised: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  onAccent: string;
}

export interface ThemeTokensV1 {
  surfaces: ThemeSurfacesV1;
  type: ThemeTypefaceV1;
  bubbles: { bot: BotBubbleV1; me: MeBubbleV1 };
}

export interface ThemePhaseV1 {
  after: string;
  tokens: ThemeTokensV1;
}

export interface ThemeDocumentV1 {
  schemaVersion: 1;
  look: NamedLookV1;
  tokens: ThemeTokensV1;
  phases?: ThemePhaseV1[];
}

export interface AccountAppearanceV1 {
  look: AccountLookV1;
}

const SURFACE_KEYS = [
  "window",
  "surface",
  "raised",
  "text",
  "muted",
  "line",
  "accent",
  "onAccent",
] as const;

export const INK_TOKENS_V1: ThemeTokensV1 = {
  surfaces: {
    window: "#121214",
    surface: "#0c0c0e",
    raised: "#1e1e22",
    text: "#f6f2ee",
    muted: "#a8a3a6",
    line: "#2c2c32",
    accent: "#c44580",
    onAccent: "#ffffff",
  },
  type: "manrope",
  bubbles: { bot: "raised", me: "tint" },
};

export const PAPER_TOKENS_V1: ThemeTokensV1 = {
  surfaces: {
    window: "#faf7f2",
    surface: "#ffffff",
    raised: "#f2ece4",
    text: "#1e1d27",
    muted: "#6d6974",
    line: "#e7e0d9",
    accent: "#c23d7b",
    onAccent: "#ffffff",
  },
  type: "manrope",
  bubbles: { bot: "raised", me: "accent" },
};

/** Paper tokens for the thread: this Bot's room, sitting in the app's ink. */
export const STUDIO_TOKENS_V1: ThemeTokensV1 = {
  surfaces: {
    window: "#faf7f2",
    surface: "#ffffff",
    raised: "#f2ece4",
    text: "#1e1d27",
    muted: "#6d6974",
    line: "#e7e0d9",
    accent: "#c23d7b",
    onAccent: "#ffffff",
  },
  type: "manrope",
  bubbles: { bot: "plain", me: "accent" },
};

export const INK_DOCUMENT_V1: ThemeDocumentV1 = {
  schemaVersion: 1,
  look: "ink",
  tokens: INK_TOKENS_V1,
};

export const PAPER_DOCUMENT_V1: ThemeDocumentV1 = {
  schemaVersion: 1,
  look: "paper",
  tokens: PAPER_TOKENS_V1,
};

export const STUDIO_DOCUMENT_V1: ThemeDocumentV1 = {
  schemaVersion: 1,
  look: "studio",
  tokens: STUDIO_TOKENS_V1,
};

export function namedLookDocumentV1(look: NamedLookV1): ThemeDocumentV1 {
  switch (look) {
    case "ink":
      return structuredClone(INK_DOCUMENT_V1);
    case "paper":
      return structuredClone(PAPER_DOCUMENT_V1);
    case "studio":
      return structuredClone(STUDIO_DOCUMENT_V1);
  }
}

/** Resolve System against the OS, Ink/Paper as themselves. */
export function resolveAccountLookV1(
  look: AccountLookV1,
  osDark: boolean,
): "ink" | "paper" {
  if (look === "system") return osDark ? "ink" : "paper";
  return look;
}

/** Compile the tokens a Bot paints when its directory row has no document. */
export function compileBotLookV1(
  look: BotLookV1,
  account: AccountLookV1,
  osDark: boolean,
): ThemeDocumentV1 {
  if (look === "studio") return namedLookDocumentV1("studio");
  return namedLookDocumentV1(resolveAccountLookV1(account, osDark));
}

/** Tokens and phases, not the seed name — a Plugin patch keeps the seed look. */
export function themeDocumentsMatchV1(
  left: ThemeDocumentV1 | undefined,
  right: ThemeDocumentV1 | undefined,
): boolean {
  return (
    JSON.stringify(left?.tokens) === JSON.stringify(right?.tokens) &&
    JSON.stringify(left?.phases ?? []) === JSON.stringify(right?.phases ?? [])
  );
}

/**
 * Studio, or any stored document (Custom, or a Plugin patch), is this Bot's
 * own look. Inherit with no document is the account Theme as-is.
 */
export function botHasOwnLookV1(
  look: BotLookV1,
  document?: ThemeDocumentV1,
): boolean {
  return look === "studio" || document !== undefined;
}

export function defaultAccountAppearanceV1(): AccountAppearanceV1 {
  return { look: "ink" };
}

export function defaultBotLookV1(): BotLookV1 {
  return "inherit";
}

export function isAccountLookV1(value: unknown): value is AccountLookV1 {
  return ACCOUNT_LOOKS_V1.some((look) => look === value);
}

export function isBotLookV1(value: unknown): value is BotLookV1 {
  return BOT_LOOKS_V1.some((look) => look === value);
}

export function isNamedLookV1(value: unknown): value is NamedLookV1 {
  return NAMED_LOOKS_V1.some((look) => look === value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ThemeDocumentDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new ThemeDocumentDecodeError(`${label} has invalid fields`);
  }
}

function assertNoForbiddenKeys(value: unknown, label: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoForbiddenKeys(item, `${label}[${index}]`),
    );
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if ((THEME_FORBIDDEN_KEYS_V1 as readonly string[]).includes(key)) {
      throw new ThemeDocumentDecodeError(`${label} must not carry "${key}"`);
    }
    assertNoForbiddenKeys(
      (value as Record<string, unknown>)[key],
      `${label}.${key}`,
    );
  }
}

function hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_COLOR_V1.test(value)) {
    throw new ThemeDocumentDecodeError(`${label} must be a #RRGGBB colour`);
  }
  return value.toLowerCase();
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.some((item) => item === value)) {
    throw new ThemeDocumentDecodeError(`${label} is invalid`);
  }
  return value as T;
}

function decodeSurfacesV1(input: unknown, label: string): ThemeSurfacesV1 {
  const value = record(input, label);
  exact(value, SURFACE_KEYS, [], label);
  return {
    window: hex(value.window, `${label}.window`),
    surface: hex(value.surface, `${label}.surface`),
    raised: hex(value.raised, `${label}.raised`),
    text: hex(value.text, `${label}.text`),
    muted: hex(value.muted, `${label}.muted`),
    line: hex(value.line, `${label}.line`),
    accent: hex(value.accent, `${label}.accent`),
    onAccent: hex(value.onAccent, `${label}.onAccent`),
  };
}

function decodeTokensV1(input: unknown, label: string): ThemeTokensV1 {
  const value = record(input, label);
  exact(value, ["surfaces", "type", "bubbles"], [], label);
  const bubbles = record(value.bubbles, `${label}.bubbles`);
  exact(bubbles, ["bot", "me"], [], `${label}.bubbles`);
  return {
    surfaces: decodeSurfacesV1(value.surfaces, `${label}.surfaces`),
    type: oneOf(value.type, THEME_TYPEFACES_V1, `${label}.type`),
    bubbles: {
      bot: oneOf(bubbles.bot, BOT_BUBBLES_V1, `${label}.bubbles.bot`),
      me: oneOf(bubbles.me, ME_BUBBLES_V1, `${label}.bubbles.me`),
    },
  };
}

function decodePhaseV1(input: unknown, label: string): ThemePhaseV1 {
  const value = record(input, label);
  exact(value, ["after", "tokens"], [], label);
  if (typeof value.after !== "string" || !PHASE_AFTER_V1.test(value.after)) {
    throw new ThemeDocumentDecodeError(`${label}.after must be HH:MM`);
  }
  return {
    after: value.after,
    tokens: decodeTokensV1(value.tokens, `${label}.tokens`),
  };
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function relativeLuminanceV1(color: string): number {
  const raw = color.startsWith("#") ? color.slice(1) : color;
  const channel = (start: number): number => {
    const value = Number.parseInt(raw.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatioV1(
  foreground: string,
  background: string,
): number {
  const left = relativeLuminanceV1(foreground);
  const right = relativeLuminanceV1(background);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

export function tokensMeetContrastFloorV1(tokens: ThemeTokensV1): boolean {
  const { window, surface, text, muted, accent, onAccent } = tokens.surfaces;
  return (
    contrastRatioV1(text, window) >= TEXT_CONTRAST_FLOOR_V1 &&
    contrastRatioV1(text, surface) >= TEXT_CONTRAST_FLOOR_V1 &&
    contrastRatioV1(muted, window) >= MUTED_CONTRAST_FLOOR_V1 &&
    contrastRatioV1(onAccent, accent) >= TEXT_CONTRAST_FLOOR_V1
  );
}

function assertContrast(tokens: ThemeTokensV1, label: string): void {
  if (!tokensMeetContrastFloorV1(tokens)) {
    throw new ThemeDocumentDecodeError(`${label} fails the contrast floor`);
  }
}

export function decodeThemeDocumentV1(input: unknown): ThemeDocumentV1 {
  assertNoForbiddenKeys(input, "theme document");
  const value = record(input, "theme document");
  exact(
    value,
    ["schemaVersion", "look", "tokens"],
    ["phases"],
    "theme document",
  );
  if (value.schemaVersion !== 1) {
    throw new ThemeDocumentDecodeError("unsupported theme document");
  }
  const tokens = decodeTokensV1(value.tokens, "theme document.tokens");
  assertContrast(tokens, "theme document.tokens");
  const phases =
    value.phases === undefined
      ? undefined
      : (() => {
          if (
            !Array.isArray(value.phases) ||
            value.phases.length > MAX_PHASES_V1
          ) {
            throw new ThemeDocumentDecodeError(
              "theme document.phases must be a bounded array",
            );
          }
          return value.phases.map((phase, index) => {
            const decoded = decodePhaseV1(
              phase,
              `theme document.phases[${index}]`,
            );
            assertContrast(
              decoded.tokens,
              `theme document.phases[${index}].tokens`,
            );
            return decoded;
          });
        })();
  return {
    schemaVersion: 1,
    look: oneOf(value.look, NAMED_LOOKS_V1, "theme document.look"),
    tokens,
    ...(phases === undefined ? {} : { phases }),
  };
}

export function decodeAccountAppearanceV1(input: unknown): AccountAppearanceV1 {
  const value = record(input, "account appearance");
  exact(value, ["look"], [], "account appearance");
  return {
    look: oneOf(value.look, ACCOUNT_LOOKS_V1, "account appearance.look"),
  };
}

export function decodeBotLookV1(input: unknown): BotLookV1 {
  return oneOf(input, BOT_LOOKS_V1, "bot look");
}

function minutesAfterMidnightV1(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function clockInZoneV1(now: Date, timezone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const match = formatted.match(/(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : "00:00";
  } catch {
    return "00:00";
  }
}

/**
 * The tokens to paint right now. Clock-only phases are chosen from the
 * account timezone; nothing here waits on a Plugin or the network.
 */
export function resolveThemeTokensV1(
  document: ThemeDocumentV1,
  now: Date,
  timezone: string,
): ThemeTokensV1 {
  const phases = document.phases;
  if (!phases || phases.length === 0) return document.tokens;
  const current = minutesAfterMidnightV1(clockInZoneV1(now, timezone));
  const ranked = [...phases].sort(
    (left, right) =>
      minutesAfterMidnightV1(left.after) - minutesAfterMidnightV1(right.after),
  );
  let chosen = ranked[ranked.length - 1]!;
  for (const phase of ranked) {
    if (minutesAfterMidnightV1(phase.after) <= current) chosen = phase;
  }
  return chosen.tokens;
}

/** Next hour boundary. The app owns the clock; a Plugin only answers. */
export function nextHourBoundaryV1(now: Date, _timezone: string): number {
  const ms = now.getTime();
  return ms - (ms % 3_600_000) + 3_600_000;
}
