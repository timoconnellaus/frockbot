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
    // And the title says the same thing the body does: a card that could not
    // be drawn is not a Turn the Bot went without the Plugin for.
    expect(notices[0]?.title).toBe("A plugin was skipped");
    expect(notices[1]?.title).toBe("A plugin could not draw a card");
  });

  test("a failed press is not titled as a lost Turn", async () => {
    const { state, notices } = harness();
    await notePluginFailureV1(state, TURN, {
      pluginId: "email",
      phase: "hook",
      message: "the handler threw",
      card: "press",
    });
    expect(notices[0]?.title).toBe("A plugin could not answer a card press");
    expect(notices[0]?.body).toContain("could not answer a card press");
  });

  // A press is counted the same way a Turn is, but it is not one: the body's
  // last sentence must not read back a run of failing Turns that never ran.
  test("a failed press's body counts failures, a hook's counts Turns", async () => {
    const { state, notices } = harness();
    await notePluginFailureV1(state, TURN, {
      pluginId: "email",
      phase: "hook",
      message: "the handler threw",
      card: "press",
    });
    expect(notices[0]?.body).toBe(
      'The plugin "email" could not answer a card press: the handler threw. The card press did not go through, and this Bot carried on. 1 of 3 failures in a row before it is turned off.',
    );
    await notePluginFailureV1(
      state,
      { runId: "run-2", generationId: "gen-1" },
      { pluginId: "email", phase: "hook", message: "beforeModel threw" },
    );
    expect(notices[1]?.body).toBe(
      'The plugin "email" was skipped for this Turn: beforeModel threw. This Bot carried on without it. 2 of 3 failing Turns in a row before it is turned off.',
    );
  });

  // The threshold notice is the last thing the person reads about the run
  // that turned the Plugin off, and a run of presses is not a run of Turns.
  test("the threshold notice counts presses as presses and Turns as Turns", async () => {
    const { state: pressed, notices: pressNotices } = harness();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      await notePluginFailureV1(
        pressed,
        { runId, generationId: "gen-1" },
        {
          pluginId: "email",
          phase: "hook",
          message: "the handler threw",
          card: "press",
        },
      );
    }
    const pressQuarantine = pressNotices.at(-1);
    expect(pressQuarantine?.title).toBe("A plugin was turned off");
    expect(pressQuarantine?.body).toBe(
      'The plugin "email" failed 3 times in a row and is now off for this Bot. Turn it on again under Plugins to try it once more.',
    );

    const { state: hooked, notices: hookNotices } = harness();
    for (const runId of ["run-1", "run-2", "run-3"]) {
      await notePluginFailureV1(
        hooked,
        { runId, generationId: "gen-1" },
        { pluginId: "email", phase: "hook", message: "beforeModel threw" },
      );
    }
    expect(hookNotices.at(-1)?.body).toBe(
      'The plugin "email" failed on 3 Turns in a row and is now off for this Bot. Turn it on again under Plugins to try it once more.',
    );
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
