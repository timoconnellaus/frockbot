import { describe, expect, test } from "bun:test";
import {
  decodePackageBundleArtifactV1,
  decodePackageBundleResultV1,
  PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
} from "./authoring.js";
import { decodeSessionEvent } from "./types.js";

const ARTIFACT = {
  contentHash: "a".repeat(64),
  size: 128,
  mediaType: "application/javascript",
  bundlerVersion: "@cloudflare/worker-bundler@0.2.3",
};

describe("the kernel-declared bundler seam", () => {
  test("bounds Package source at the D7 quota", () => {
    expect(PACKAGE_BUNDLE_MAX_SOURCE_BYTES).toBe(256 * 1024);
  });

  test("decodes a bundled result exactly", () => {
    const result = decodePackageBundleResultV1({
      schemaVersion: 1,
      effectId: "author-1",
      status: "bundled",
      artifact: ARTIFACT,
      module: "export const tools = [];",
      diagnostics: [],
    });
    expect(result.status).toBe("bundled");
    expect(decodePackageBundleArtifactV1(ARTIFACT)).toEqual(ARTIFACT as never);
  });

  test("decodes multi-page UI artifacts exactly", () => {
    const page = (id: string, hash: string) => ({
      id,
      artifact: {
        contentHash: hash.repeat(64),
        size: 32,
        mediaType: "text/html",
        bundlerVersion: "frockbot-inline-html@1",
      },
      html: `<!doctype html><h1>${id}</h1>`,
    });
    const bundled = (uiArtifacts: unknown) => ({
      schemaVersion: 1,
      effectId: "author-1",
      status: "bundled",
      artifact: ARTIFACT,
      module: "export const tools = [];",
      uiArtifacts,
      diagnostics: [],
    });
    const result = decodePackageBundleResultV1(
      bundled([page("main", "b"), page("board", "c")]),
    );
    expect(
      result.status === "bundled"
        ? result.uiArtifacts?.map((entry) => entry.id)
        : undefined,
    ).toEqual(["main", "board"]);
    expect(() => decodePackageBundleResultV1(bundled([]))).toThrow(
      "non-empty bounded array",
    );
    expect(() =>
      decodePackageBundleResultV1(
        bundled([page("main", "b"), page("main", "c")]),
      ),
    ).toThrow("duplicate ids");
    expect(() =>
      decodePackageBundleResultV1(bundled([page("Main", "b")])),
    ).toThrow("id is invalid");
    expect(() =>
      decodePackageBundleResultV1({
        ...bundled([page("main", "b")]),
        uiHtml: "<!doctype html>",
      }),
    ).toThrow("invalid fields");
  });

  test("decodes a failed result exactly", () => {
    expect(
      decodePackageBundleResultV1({
        schemaVersion: 1,
        effectId: "author-1",
        status: "failed",
        failure: "unresolved-import",
        diagnostics: ['still imports "zod"'],
      }).status,
    ).toBe("failed");
  });

  test.each([
    [
      "an unsupported schema version",
      { schemaVersion: 2, effectId: "a", status: "bundled" },
    ],
    [
      "an unknown status",
      { schemaVersion: 1, effectId: "a", status: "queued" },
    ],
    [
      "a non-hex content hash",
      {
        schemaVersion: 1,
        effectId: "a",
        status: "bundled",
        artifact: { ...ARTIFACT, contentHash: "not-a-hash" },
        module: "x",
        diagnostics: [],
      },
    ],
    [
      "an unexpected media type",
      {
        schemaVersion: 1,
        effectId: "a",
        status: "bundled",
        artifact: { ...ARTIFACT, mediaType: "text/html" },
        module: "x",
        diagnostics: [],
      },
    ],
    [
      "an empty module",
      {
        schemaVersion: 1,
        effectId: "a",
        status: "bundled",
        artifact: ARTIFACT,
        module: "",
        diagnostics: [],
      },
    ],
    [
      "an extra field",
      {
        schemaVersion: 1,
        effectId: "a",
        status: "bundled",
        artifact: ARTIFACT,
        module: "x",
        diagnostics: [],
        r2Key: "packages/a.mjs",
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => decodePackageBundleResultV1(input)).toThrow();
  });
});

describe("the authoring session events", () => {
  const intent = {
    type: "package/author-intent",
    seq: 0,
    timestamp: "2026-08-31T00:00:00.000Z",
    turn: 1,
    step: 1,
    effectId: "author-1",
    packageId: "weather-lookup",
    sourceHash: "a".repeat(64),
  };
  const authored = {
    type: "package/authored",
    seq: 1,
    timestamp: "2026-08-31T00:00:00.000Z",
    turn: 1,
    step: 1,
    effectId: "author-1",
    packageId: "weather-lookup",
    version: "0.0.1",
    contentHash: "b".repeat(64),
    generationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  };

  test("decode exactly", () => {
    expect(decodeSessionEvent(intent)).toEqual(intent as never);
    expect(decodeSessionEvent(authored)).toEqual(authored as never);
  });

  test.each([
    ["an intent with no step", { ...intent, step: undefined }],
    ["an intent with an extra field", { ...intent, source: "x" }],
    ["an authored event with no generation", { ...authored, generationId: "" }],
    ["an authored event with no version", { ...authored, version: undefined }],
    ["a turn of zero", { ...intent, turn: 0 }],
  ])("reject %s", (_label, input) => {
    expect(() => decodeSessionEvent(input)).toThrow();
  });
});
