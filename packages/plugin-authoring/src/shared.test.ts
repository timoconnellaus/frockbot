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
  tool: {
    name: "weather_lookup",
    description: "Looks up the weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  },
  source: "export const tools = [];\nexport async function execute() {}\n",
};

describe("decodeAuthorPackageInputV1", () => {
  test("accepts the exact v1 shape and the optional model Contribution", () => {
    expect(decodeAuthorPackageInputV1(VALID)).toEqual(VALID);
    expect(
      decodeAuthorPackageInputV1({
        ...VALID,
        model: { providerId: "ollama-cloud", modelId: "qwen3-coder:480b" },
      }).model,
    ).toEqual({ providerId: "ollama-cloud", modelId: "qwen3-coder:480b" });
  });

  test.each([
    ["a non-object", 7],
    ["an unknown field", { ...VALID, activate: true }],
    ["a missing field", { ...VALID, source: undefined }],
    ["an upper-case package id", { ...VALID, packageId: "Weather" }],
    ["a one-character package id", { ...VALID, packageId: "a" }],
    [
      "a tool name with a dash",
      { ...VALID, tool: { ...VALID.tool, name: "a-b" } },
    ],
    ["an empty source", { ...VALID, source: "" }],
    [
      "a non-object input schema",
      { ...VALID, tool: { ...VALID.tool, inputSchema: "object" } },
    ],
    [
      "a partial model Contribution",
      { ...VALID, model: { providerId: "ollama-cloud" } },
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

  test("the synthesized manifest declares only the isolate host", () => {
    const manifest = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tool: VALID.tool,
      model: { providerId: "ollama-cloud", modelId: "qwen3-coder:480b" },
    });
    const contributions = manifest.contributions as Record<
      string,
      { host?: string; binding?: string }
    >;
    expect(Object.keys(contributions).toSorted()).toEqual(["model", "runtime"]);
    expect(contributions.runtime?.host).toBe("bot-isolate");
    expect(contributions.model?.host).toBe("bot-isolate");
    // A Bot-authored model adapter is a translation layer over a kernel
    // binding, never a network client.
    expect(contributions.model?.binding).toBe("capabilities.invokeModel");
    expect(manifest.permissions).toEqual([]);
  });

  test("the manifest hash moves when the declared model Contribution moves", () => {
    const base = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tool: VALID.tool,
    });
    const withModel = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tool: VALID.tool,
      model: { providerId: "ollama-cloud", modelId: "qwen3-coder:480b" },
    });
    expect(JSON.stringify(base)).not.toBe(JSON.stringify(withModel));
  });
});
