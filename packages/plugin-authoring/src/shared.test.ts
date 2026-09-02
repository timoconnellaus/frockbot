import { describe, expect, test } from "bun:test";
import {
  authoredManifestV1,
  authoredVersionV1,
  authoringEffectIdV1,
  decodeAuthorPackageInputV1,
  sha256HexV1,
} from "./shared.ts";

const VALID = {
  packageId: "weather-lookup",
  displayName: "Weather lookup",
  tools: [
    {
      name: "weather_lookup",
      description: "Looks up the weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
  ],
  source: "export const tools = [];\nexport async function execute() {}\n",
};

describe("decodeAuthorPackageInputV1", () => {
  test("accepts the exact plural shape and canonicalizes the legacy singular shape", () => {
    expect(decodeAuthorPackageInputV1(VALID)).toEqual(VALID);
    const { tools: _tools, ...rest } = VALID;
    expect(
      decodeAuthorPackageInputV1({ ...rest, tool: VALID.tools[0] }),
    ).toEqual(VALID);
  });

  test.each([
    ["a non-object", 7],
    ["an unknown field", { ...VALID, activate: true }],
    ["a missing field", { ...VALID, source: undefined }],
    ["an upper-case package id", { ...VALID, packageId: "Weather" }],
    ["a one-character package id", { ...VALID, packageId: "a" }],
    [
      "a tool name with a dash",
      { ...VALID, tools: [{ ...VALID.tools[0]!, name: "a-b" }] },
    ],
    ["an empty source", { ...VALID, source: "" }],
    [
      "a non-object input schema",
      { ...VALID, tools: [{ ...VALID.tools[0]!, inputSchema: "object" }] },
    ],
    ["a removed model declaration", { ...VALID, model: { providerId: "x" } }],
    [
      "duplicate tool names",
      { ...VALID, tools: [VALID.tools[0], VALID.tools[0]] },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => decodeAuthorPackageInputV1(input)).toThrow();
  });

  test("rejects source beyond the 256 KB per-Package quota", () => {
    expect(() =>
      decodeAuthorPackageInputV1({
        ...VALID,
        source: "a".repeat(256 * 1024 + 1),
      }),
    ).toThrow();
  });
});

describe("authoring identity", () => {
  test("the effect id is deterministic in the run and the exact source", async () => {
    const sourceHash = await sha256HexV1(VALID.source);
    const first = await authoringEffectIdV1({
      runId: "run-1",
      packageId: VALID.packageId,
      sourceHash,
    });
    const second = await authoringEffectIdV1({
      runId: "run-1",
      packageId: VALID.packageId,
      sourceHash,
    });
    const otherRun = await authoringEffectIdV1({
      runId: "run-2",
      packageId: VALID.packageId,
      sourceHash,
    });
    const otherSource = await authoringEffectIdV1({
      runId: "run-1",
      packageId: VALID.packageId,
      sourceHash: await sha256HexV1(`${VALID.source}//`),
    });

    expect(first).toBe(second);
    expect(first).not.toBe(otherRun);
    expect(first).not.toBe(otherSource);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  test("versions are appended, never overwritten", () => {
    expect(authoredVersionV1(1)).toBe("0.0.1");
    expect(authoredVersionV1(2)).toBe("0.0.2");
    expect(() => authoredVersionV1(0)).toThrow();
  });

  test("the synthesized manifest declares only the isolate host and its tools", () => {
    const manifest = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tools: VALID.tools,
    });
    const contributions = manifest.contributions as Record<
      string,
      { host?: string; binding?: string }
    >;
    expect(Object.keys(contributions)).toEqual(["runtime"]);
    expect(contributions.runtime?.host).toBe("bot-isolate");
    expect(manifest.tools).toEqual(VALID.tools);
    expect(manifest.permissions).toEqual([]);
  });

  test("the manifest moves when its declared tool set moves", () => {
    const base = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tools: VALID.tools,
    });
    const withModel = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tools: [
        ...VALID.tools,
        { name: "forecast", description: "Forecasts", inputSchema: {} },
      ],
    });
    expect(JSON.stringify(base)).not.toBe(JSON.stringify(withModel));
  });
});
