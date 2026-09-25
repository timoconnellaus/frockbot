import { describe, expect, test } from "bun:test";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import { samePublishedPluginV1 } from "./authoring-bot.js";

const published = (
  overrides: Partial<CompositionMemberV1> & { runId?: string } = {},
): CompositionMemberV1 => {
  const { runId = "run-1", ...rest } = overrides;
  return {
    packageId: "guitar-tuner",
    version: "1.0.0",
    provenance: {
      kind: "bot",
      packageId: "guitar-tuner",
      version: "1.0.0",
      botId: "bob",
      sessionId: "user-1:bob",
      turnId: runId,
      runId,
      authoredAt: "2026-09-25T01:01:00.000Z",
    },
    artifact: {
      contentHash: "a".repeat(64),
      size: 586,
      mediaType: "application/javascript",
      bundlerVersion: "applet-build/plugin@1",
    },
    descriptor: {
      id: "guitar-tuner",
      displayName: "Guitar Tuner",
      version: "1.0.0",
      contractVersion: 7,
      tools: [],
      hooks: [],
      grants: ["device"],
      contextKeys: ["user", "bot", "session"],
      views: [
        { slot: "conversation.panel", surfaceId: "tuner", page: "tuner.html" },
      ],
    },
    pages: [{ path: "tuner.html", contentHash: "b".repeat(64), size: 15_502 }],
    ...rest,
  } as unknown as CompositionMemberV1;
};

describe("an approved publish of a Plugin the Composition already holds", () => {
  test("is the same Plugin when only who published it differs, so a retry makes no second generation", () => {
    expect(
      samePublishedPluginV1(
        published(),
        published({ runId: "run-2" } as Partial<CompositionMemberV1>),
      ),
    ).toBe(true);
  });

  test("is a new Plugin when only its page changed, as a newer bridge or an HTML edit does", () => {
    expect(
      samePublishedPluginV1(
        published(),
        published({
          pages: [
            { path: "tuner.html", contentHash: "c".repeat(64), size: 15_900 },
          ],
        } as Partial<CompositionMemberV1>),
      ),
    ).toBe(false);
  });

  test("is a new Plugin when only its declaration changed", () => {
    const held = published();
    expect(
      samePublishedPluginV1(
        held,
        published({
          descriptor: { ...held.descriptor, grants: [] },
        } as Partial<CompositionMemberV1>),
      ),
    ).toBe(false);
  });
});
