// What a Plugin's failure tells the person, when more than one thing of that
// Plugin failed in one Turn.
import { describe, expect, test } from "bun:test";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { notePluginFailureV1 } from "./health-bot.js";

const TURN = { runId: "run-1", generationId: "gen-1" };

function harness() {
  const values = new Map<string, unknown>();
  const notices: { notificationId: string; title: string; body: string }[] = [];
  const storage = {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(values.delete(key)),
    list: ({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values.entries()].filter(([key]) => key.startsWith(prefix)),
        ),
      ),
  };
  const state = {
    ctx: { storage },
    authority: {
      recordNotification: (notification: {
        notificationId: string;
        title: string;
        body: string;
      }) => {
        notices.push(notification);
        return Promise.resolve();
      },
    },
  } as unknown as ShellBotStateV1;
  return { state, notices };
}

describe("a Plugin failing more than once in one Turn", () => {
  // A card draw is charged under the Turn's own runId and the hook phase, so
  // without the card discriminator the second notice would be deduped onto
  // the first and the person would read one event's wording for both.
  test("a skipped hook and a failed draw each say what they were", async () => {
    const { state, notices } = harness();
    await notePluginFailureV1(state, TURN, {
      pluginId: "email",
      phase: "hook",
      message: "beforeModel threw",
    });
    await notePluginFailureV1(state, TURN, {
      pluginId: "email",
      phase: "hook",
      message: "render threw",
      card: "draw",
    });
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((notice) => notice.notificationId)).size).toBe(
      2,
    );
    expect(notices[0]?.body).toContain("was skipped for this Turn");
    expect(notices[1]?.body).toContain("could not draw a card");
  });

  test("the same thing failing twice in one Turn is one notice", async () => {
    const { state, notices } = harness();
    for (const message of ["render threw", "render threw again"]) {
      await notePluginFailureV1(state, TURN, {
        pluginId: "email",
        phase: "hook",
        message,
        card: "draw",
      });
    }
    expect(notices[0]?.notificationId).toBe(notices[1]?.notificationId!);
  });
});
