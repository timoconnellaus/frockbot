/**
 * Enough of JSONC for a wrangler config: `//` and block comments, and trailing
 * commas. A real parser would be a dependency; these files use two extensions
 * and both are removable before `JSON.parse`, which is the whole of it.
 */
export function parseJsoncV1(source: string, what: string): unknown {
  const withoutComments = source.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  try {
    return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1")) as unknown;
  } catch (error) {
    throw new Error(
      `${what} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
