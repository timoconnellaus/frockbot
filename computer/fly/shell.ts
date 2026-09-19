/** Quote one value as one POSIX shell word for the Fly Sprite. */
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
