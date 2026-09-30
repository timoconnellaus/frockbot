/** Quote one value as one POSIX shell word on the Computer. */
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
