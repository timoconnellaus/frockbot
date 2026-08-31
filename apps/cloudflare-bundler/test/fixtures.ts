import type { BundleRequestV1 } from "../src/contracts.ts";

/**
 * A Bot-authored tool exercising the TypeScript features the slice needs:
 * `enum`, `satisfies`, generics, interfaces, and top-level `await`.
 */
export const FIXTURE_TOOL_TS = `enum Severity {
  Low = "low",
  High = "high",
}

interface Summary {
  readonly text: string;
  readonly severity: Severity;
}

const seed = await Promise.resolve(41);

function longest<Item extends { length: number }>(items: Item[]): Item | undefined {
  return items.reduce<Item | undefined>(
    (best, item) => (best === undefined || item.length > best.length ? item : best),
    undefined,
  );
}

const defaults = {
  maxSentences: seed + 1,
  severity: Severity.High,
} satisfies { maxSentences: number; severity: Severity };

export function summarise(input: string): Summary {
  const sentences = input.split(/(?<=\\.)\\s+/).slice(0, defaults.maxSentences);
  return {
    text: longest(sentences) ?? "",
    severity: defaults.severity,
  };
}
`;

export function bundleRequest(
  overrides: Partial<BundleRequestV1> = {},
): BundleRequestV1 {
  return {
    schemaVersion: 1,
    effectId: "effect-0001",
    target: "bot-isolate",
    compatibilityDate: "2026-08-27",
    entry: "package.ts",
    sources: [{ path: "package.ts", text: FIXTURE_TOOL_TS }],
    ...overrides,
  };
}
