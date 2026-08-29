import { describe, expect, test } from "bun:test";
import { ComposerDraftFence } from "./composer-draft.js";

describe("composer draft restoration", () => {
  test("restores a rejected submission only in its unchanged Bot context", () => {
    const fence = new ComposerDraftFence();
    const botA = { botId: "a" };
    const submission = fence.begin(botA);

    expect(fence.canRestore(submission, botA, "")).toBe(true);
    expect(fence.canRestore(submission, { botId: "b" }, "")).toBe(false);
    expect(fence.canRestore(submission, botA, "new text")).toBe(false);
  });

  test("does not restore an earlier submission after rapid Bot switching", () => {
    const fence = new ComposerDraftFence();
    const botA = { botId: "a" };
    const botB = { botId: "b" };
    const staleA = fence.begin(botA);
    const currentB = fence.begin(botB);

    expect(fence.canRestore(staleA, botA, "")).toBe(false);
    expect(fence.canRestore(currentB, botB, "")).toBe(true);
  });
});
