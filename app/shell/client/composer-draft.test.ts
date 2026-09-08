import { describe, expect, test } from "bun:test";
import { ComposerDraftStore } from "./composer-draft.js";

describe("composer draft restoration", () => {
  test("retains a rejected submission in its originating Bot draft", () => {
    const drafts = new ComposerDraftStore();
    const submission = drafts.begin("bot-a", "message for A");
    drafts.setDraft("bot-b", "message for B");

    expect(drafts.reject(submission)).toBe("message for A");
    expect(drafts.draftFor("bot-a")).toBe("message for A");
    expect(drafts.draftFor("bot-b")).toBe("message for B");
  });

  test("does not restore an older submission over a newer one for the same Bot", () => {
    const drafts = new ComposerDraftStore();
    const stale = drafts.begin("bot-a", "older");
    const current = drafts.begin("bot-a", "newer");

    expect(drafts.reject(stale)).toBeUndefined();
    expect(drafts.reject(current)).toBe("newer");
  });

  test("preserves text typed after submission alongside rejected text", () => {
    const drafts = new ComposerDraftStore();
    const submission = drafts.begin("bot-a", "rejected");
    drafts.setDraft("bot-a", "new draft");

    expect(drafts.reject(submission)).toBe("rejected\n\nnew draft");
  });
});
