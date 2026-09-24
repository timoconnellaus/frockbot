import { describe, expect, test } from "bun:test";
import {
  compositionArtifactSetHashV1,
  decodeCompositionMemberV1,
  type CompositionMemberV1,
} from "./generation.js";

const HASH = "a".repeat(64);
const PAGE_HASH = "b".repeat(64);

function member(
  views: unknown[] | undefined,
  pages?: unknown,
): Record<string, unknown> {
  return {
    packageId: "tuner",
    version: "1.0.0",
    provenance: {
      kind: "bot",
      packageId: "tuner",
      version: "1.0.0",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      authoredAt: "2026-09-24T00:00:00.000Z",
    },
    artifact: {
      contentHash: HASH,
      size: 10,
      mediaType: "application/javascript",
      bundlerVersion: "esbuild-1",
    },
    descriptor: {
      id: "tuner",
      displayName: "Tuner",
      version: "1.0.0",
      contractVersion: 7,
      tools: [],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
      ...(views === undefined ? {} : { views }),
    },
    ...(pages === undefined ? {} : { pages }),
  };
}

const PANEL = {
  slot: "conversation.panel",
  surfaceId: "tuner",
  page: "tuner.html",
};

describe("a member's pages", () => {
  test("carry one stored page for each page a view names", () => {
    const decoded = decodeCompositionMemberV1(
      member(
        [PANEL],
        [{ path: "tuner.html", contentHash: PAGE_HASH, size: 42 }],
      ),
      "member",
    );
    expect(decoded.pages).toEqual([
      { path: "tuner.html", contentHash: PAGE_HASH, size: 42 },
    ]);
  });

  test("stay absent on a member whose views name no page", () => {
    expect(
      decodeCompositionMemberV1(
        member([{ slot: "conversation.panel", surfaceId: "board" }]),
        "member",
      ),
    ).not.toHaveProperty("pages");
    expect(
      decodeCompositionMemberV1(member(undefined), "member"),
    ).not.toHaveProperty("pages");
  });

  test("refuse a missing, extra, repeated or malformed page", () => {
    const stored = { path: "tuner.html", contentHash: PAGE_HASH, size: 42 };
    for (const [views, pages] of [
      [[PANEL], undefined],
      [[PANEL], []],
      [[{ slot: "conversation.panel", surfaceId: "board" }], [stored]],
      [[PANEL], [stored, { ...stored, path: "other.html" }]],
      [[PANEL], [stored, stored]],
      [[PANEL], [{ ...stored, contentHash: "not-a-hash" }]],
      [[PANEL], [{ ...stored, size: -1 }]],
      [[PANEL], [{ ...stored, extra: true }]],
      [[PANEL], [{ ...stored, path: "../tuner.html" }]],
    ] as const) {
      expect(() =>
        decodeCompositionMemberV1(member([...views], pages), "member"),
      ).toThrow();
    }
  });

  test("are covered by the generation's hash, so a revert restores them", async () => {
    const withPage = decodeCompositionMemberV1(
      member(
        [PANEL],
        [{ path: "tuner.html", contentHash: PAGE_HASH, size: 42 }],
      ),
      "member",
    );
    const changed: CompositionMemberV1 = {
      ...withPage,
      pages: [{ path: "tuner.html", contentHash: "c".repeat(64), size: 42 }],
    };
    expect(await compositionArtifactSetHashV1([withPage])).not.toBe(
      await compositionArtifactSetHashV1([changed]),
    );
  });
});
