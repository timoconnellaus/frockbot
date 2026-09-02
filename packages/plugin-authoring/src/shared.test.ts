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

  test("accepts only declared public waterfall hooks", () => {
    expect(
      decodeAuthorPackageInputV1({
        ...VALID,
        hooks: ["agent/tool-exposure", "tools/post-execute"],
      }).hooks,
    ).toEqual(["agent/tool-exposure", "tools/post-execute"]);
    expect(() =>
      decodeAuthorPackageInputV1({ ...VALID, hooks: ["agent/request"] }),
    ).toThrow(/hooks\[0\] is invalid/);
    expect(() =>
      decodeAuthorPackageInputV1({
        ...VALID,
        hooks: ["agent/tool-exposure", "agent/tool-exposure"],
      }),
    ).toThrow(/duplicate events/);
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

  test("accepts one inline iframe page and refuses external resources or an oversized page", () => {
    const ui = {
      html: "<!doctype html><style>body{color:red}</style><script>window.frockbot.resize()</script>",
      mounts: [
        { slot: "frockbot.tool-result:weather_lookup", order: 10 },
        { slot: "frockbot.bot-settings-sections" },
      ],
    };
    expect(
      decodeAuthorPackageInputV1({
        ...VALID,
        hooks: ["agent/tool-exposure"],
        ui,
      }),
    ).toMatchObject({ hooks: ["agent/tool-exposure"], ui });
    expect(() =>
      decodeAuthorPackageInputV1({
        ...VALID,
        ui: { ...ui, html: '<script src="https://example.com/x.js"></script>' },
      }),
    ).toThrow("inline resources only");
    expect(() =>
      decodeAuthorPackageInputV1({
        ...VALID,
        ui: { ...ui, html: "a".repeat(256 * 1024 + 1) },
      }),
    ).toThrow();
  });
});

describe("authoring identity", () => {
  test("the effect id is deterministic in the run, source, UI, and hooks", async () => {
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
    const otherUi = await authoringEffectIdV1({
      runId: "run-1",
      packageId: VALID.packageId,
      sourceHash,
      uiHtmlHash: await sha256HexV1("<!doctype html><h1>Weather</h1>"),
    });
    const otherHooks = await authoringEffectIdV1({
      runId: "run-1",
      packageId: VALID.packageId,
      sourceHash,
      hooks: ["agent/tool-exposure"],
    });

    expect(first).toBe(second);
    expect(first).not.toBe(otherRun);
    expect(first).not.toBe(otherSource);
    expect(first).not.toBe(otherUi);
    expect(first).not.toBe(otherHooks);
    expect(otherUi).not.toBe(otherHooks);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  test("versions are appended, never overwritten", () => {
    expect(authoredVersionV1(1)).toBe("0.0.1");
    expect(authoredVersionV1(2)).toBe("0.0.2");
    expect(() => authoredVersionV1(0)).toThrow();
  });

  test("the synthesized manifest declares only the isolate host, tools and hooks", () => {
    const manifest = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tools: VALID.tools,
      hooks: ["agent/tool-exposure"],
    });
    const contributions = manifest.contributions as Record<
      string,
      { host?: string; binding?: string }
    >;
    expect(Object.keys(contributions)).toEqual(["runtime"]);
    expect(contributions.runtime?.host).toBe("bot-isolate");
    expect(manifest.tools).toEqual(VALID.tools);
    expect(manifest.hooks).toEqual(["agent/tool-exposure"]);
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

  test("extends the same manifest with a content-addressed iframe contribution", () => {
    const artifact = {
      contentHash: "a".repeat(64),
      size: 42,
      mediaType: "text/html" as const,
      bundlerVersion: "frockbot-inline-html@1",
    };
    const manifest = authoredManifestV1({
      packageId: VALID.packageId,
      displayName: VALID.displayName,
      version: "0.0.1",
      tools: VALID.tools,
      ui: {
        artifact,
        mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
      },
    });
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      contributions: {
        runtime: { host: "bot-isolate" },
        client: {
          kind: "iframe",
          artifact,
          mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        },
      },
    });
  });
});
