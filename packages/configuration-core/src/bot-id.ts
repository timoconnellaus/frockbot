export const BOT_ID_PATTERN_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isBotIdV1(value: unknown): value is string {
  return typeof value === "string" && BOT_ID_PATTERN_V1.test(value);
}
