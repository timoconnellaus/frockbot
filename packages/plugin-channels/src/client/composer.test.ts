import { describe, expect, test } from "bun:test";
import { ChannelComposerStore } from "./composer.js";

function store(): ChannelComposerStore {
  let next = 0;
  return new ChannelComposerStore({
    newCommandId: () => `command-${(next += 1)}`,
  });
}

describe("Channel composer state", () => {
  test("keeps a draft per room", () => {
    const composer = store();
    composer.setDraft("room-a", "for A");
    composer.setDraft("room-b", "for B");

    expect(composer.draftFor("room-a")).toBe("for A");
    expect(composer.draftFor("room-b")).toBe("for B");
  });

  test("clears the draft on submission and mints one idempotency key", () => {
    const composer = store();
    composer.setDraft("room-a", "hello");
    const submission = composer.begin("room-a", "hello");

    expect(submission?.commandId).toBe("command-1");
    expect(submission?.text).toBe("hello");
    expect(composer.draftFor("room-a")).toBe("");
    expect(composer.busy("room-a")).toBe(true);
  });

  test("refuses a second submission while one is in flight", () => {
    const composer = store();
    expect(composer.begin("room-a", "first")).toBeDefined();
    expect(composer.begin("room-a", "second")).toBeUndefined();
  });

  test("refuses an empty submission and trims what it takes", () => {
    const composer = store();
    expect(composer.begin("room-a", "   ")).toBeUndefined();
    expect(composer.begin("room-a", "  hello  ")?.text).toBe("hello");
  });

  test("a refusal restores the text into its own room, with the reason", () => {
    const composer = store();
    const submission = composer.begin("room-a", "for A")!;
    composer.setDraft("room-b", "for B");

    expect(composer.reject(submission, "quota")).toBe("for A");
    expect(composer.draftFor("room-a")).toBe("for A");
    expect(composer.draftFor("room-b")).toBe("for B");
    expect(composer.failureFor("room-a")).toBe("quota");
    expect(composer.busy("room-a")).toBe(false);
  });

  test("keeps text typed after submission alongside the restored text", () => {
    const composer = store();
    const submission = composer.begin("room-a", "refused")!;
    composer.setDraft("room-a", "new draft");

    expect(composer.reject(submission, "hop")).toBe("refused\n\nnew draft");
  });

  test("does not restore an older submission over a newer one", () => {
    const composer = store();
    const stale = composer.begin("room-a", "older")!;
    composer.settle(stale);
    const current = composer.begin("room-a", "newer")!;

    expect(composer.reject(stale, "quota")).toBeUndefined();
    expect(composer.reject(current, "quota")).toBe("newer");
  });

  test("typing answers a refusal: the message goes with the next keystroke", () => {
    const composer = store();
    const submission = composer.begin("room-a", "refused")!;
    composer.reject(submission, "quota");

    composer.setDraft("room-a", "another try");
    expect(composer.failureFor("room-a")).toBeUndefined();
  });

  test("a settled submission leaves nothing behind", () => {
    const composer = store();
    const submission = composer.begin("room-a", "hello")!;
    composer.settle(submission);

    expect(composer.busy("room-a")).toBe(false);
    expect(composer.draftFor("room-a")).toBe("");
    expect(composer.failureFor("room-a")).toBeUndefined();
  });
});
