import { describe, expect, test } from "bun:test";
import {
  artifactKey,
  artifactR2KeyV1,
  authorshipArtifactKey,
  authorshipIntentKey,
  classifyAuthoringEffectV1,
  type AuthoringEffectOutcomeV1,
  type AuthorshipIntentV1,
} from "./records.ts";

const INTENT: AuthorshipIntentV1 = {
  schemaVersion: 1,
  effectId: "author-0123456789abcdef",
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  runId: "run-1",
  turnId: "run-1",
  packageId: "weather-lookup",
  version: "0.0.1",
  sourceHash: "a".repeat(64),
  manifestHash: "b".repeat(64),
  sourceBytes: 64,
  recordedAt: "2026-08-31T00:00:00.000Z",
  status: "recorded",
};

const BUNDLED: AuthoringEffectOutcomeV1 = {
  schemaVersion: 1,
  status: "bundled",
  effectId: INTENT.effectId,
  contentHash: "b".repeat(64),
  version: "0.0.1",
};

describe("authoring effect recovery", () => {
  test("no intent means the effect never started", () => {
    expect(
      classifyAuthoringEffectV1({ intent: undefined, outcome: undefined }),
    ).toEqual({ kind: "fresh" });
  });

  test("an intent with no outcome is unknown, never re-bundled", () => {
    const classification = classifyAuthoringEffectV1({
      intent: INTENT,
      outcome: undefined,
    });
    expect(classification.kind).toBe("unknown");
    expect(
      classification.kind === "unknown" ? classification.reason : "",
    ).toContain("will not be bundled again");
  });

  test("a recorded outcome settles the effect on its content address", () => {
    expect(
      classifyAuthoringEffectV1({ intent: INTENT, outcome: BUNDLED }),
    ).toEqual({ kind: "settled", outcome: BUNDLED });
  });

  test("a recorded bundler refusal replays as the same refusal", () => {
    expect(
      classifyAuthoringEffectV1({
        intent: INTENT,
        outcome: {
          schemaVersion: 1,
          status: "failed",
          effectId: INTENT.effectId,
          failureId: "authoring-failure-1",
          reason: "the Package bundler rejected this source: bundle-failed",
        },
      }),
    ).toMatchObject({ kind: "failed", failureId: "authoring-failure-1" });
  });

  test("an outcome with no intent is unknown, not settled", () => {
    expect(
      classifyAuthoringEffectV1({ intent: undefined, outcome: BUNDLED }).kind,
    ).toBe("unknown");
  });

  test("keys are the plan's records", () => {
    expect(authorshipIntentKey("author-a")).toBe("authorship:intent:author-a");
    expect(authorshipArtifactKey("author-a")).toBe(
      "authorship:artifact:author-a",
    );
    expect(artifactKey("b".repeat(64))).toBe(`artifact:${"b".repeat(64)}`);
    expect(artifactR2KeyV1("b".repeat(64))).toBe(
      `packages/${"b".repeat(64)}.mjs`,
    );
  });
});
