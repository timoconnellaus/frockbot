import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { frockBotWebDataKey } from "@frockbot/plugin-shell/shared";
import { ref } from "vue";
import { routinesClientPlugin } from "./index.js";
import { routinesStateKey, type RoutinesClientState } from "./state.js";

const ROUTINE = {
  schemaVersion: 1,
  routineId: "brief",
  name: "Morning brief",
  prompt: "Summarize overnight email.",
  schedule: "0 7 * * *",
  timezone: "Australia/Sydney",
  enabled: true,
  createdBy: { kind: "user" },
  updatedBy: { kind: "user" },
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

function mount(
  overrides: {
    hostedRequest?: ClientPluginContext["transport"]["hostedRequest"];
  } = {},
): {
  state: { value: RoutinesClientState };
  slots: ClientSlotRegistration[];
  calls: Array<[string, string | undefined, string | undefined]>;
  dispose(): void;
} {
  const slots: ClientSlotRegistration[] = [];
  const calls: Array<[string, string | undefined, string | undefined]> = [];
  let state: unknown;
  const context: ClientPluginContext = {
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      hostedRequest:
        overrides.hostedRequest ??
        ((path, method, body) => {
          calls.push([path, method, body]);
          if (method === "POST") {
            return Promise.resolve({
              schemaVersion: 1,
              commandId: (JSON.parse(body ?? "{}") as { commandId: string })
                .commandId,
              status: "applied",
              routine: ROUTINE,
            });
          }
          if (path.endsWith("/runs")) {
            return Promise.resolve({
              schemaVersion: 1,
              botId: "scout",
              routineId: "brief",
              entries: [],
            });
          }
          return Promise.resolve({
            schemaVersion: 1,
            botId: "scout",
            routines: [ROUTINE],
          });
        }),
    },
    inject: () => {
      throw new Error("unexpected client provider");
    },
    provide: (key, value) => {
      if (key === routinesStateKey) state = value;
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration);
      return () => slots.splice(slots.indexOf(registration), 1);
    },
  };
  const disposers = routinesClientPlugin(context);
  if (!Array.isArray(disposers)) throw new Error("expected registrations");
  return {
    state: state as { value: RoutinesClientState },
    slots,
    calls,
    dispose: () => {
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

describe("Routines client contribution", () => {
  test("mounts into the settings outlet, the header and the Bot panel", () => {
    const mounted = mount();
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.bot-settings-sections",
      "frockbot.header-actions",
      "frockbot.bot-panel-sections",
    ]);
    mounted.dispose();
  });

  test("loads a Bot's Routines and decodes them at the seam", async () => {
    const mounted = mount();
    await mounted.state.value.load("scout");
    expect(mounted.state.value.routines).toHaveLength(1);
    expect(mounted.state.value.botId).toBe("scout");
    expect(mounted.calls[0]).toEqual([
      "/api/bots/scout/routines",
      undefined,
      undefined,
    ]);
    mounted.dispose();
  });

  test("submits one versioned command per action, each with its own key", async () => {
    const mounted = mount();
    await mounted.state.value.save("scout", {
      name: "Morning brief",
      prompt: "Summarize overnight email.",
      schedule: "0 7 * * *",
      timezone: "Australia/Sydney",
    });
    await mounted.state.value.setEnabled("scout", "brief", false);
    await mounted.state.value.remove("scout", "brief");
    const posts = mounted.calls
      .filter(([, method]) => method === "POST")
      .map(
        ([, , body]) =>
          JSON.parse(body ?? "{}") as { type: string; commandId: string },
      );
    expect(posts.map((post) => post.type)).toEqual([
      "routine/create",
      "routine/pause",
      "routine/delete",
    ]);
    expect(new Set(posts.map((post) => post.commandId)).size).toBe(3);
    mounted.dispose();
  });

  test("surfaces a refusal instead of throwing away the reason", async () => {
    const mounted = mount({
      hostedRequest: () =>
        Promise.reject(new Error("cron expression must have five fields")),
    });
    await mounted.state.value.load("scout");
    expect(mounted.state.value.error).toBe(
      "cron expression must have five fields",
    );
    mounted.dispose();
  });

  test("loads a run log on demand", async () => {
    const mounted = mount();
    await mounted.state.value.loadRuns("scout", "brief");
    expect(mounted.state.value.runs.brief).toEqual([]);
    mounted.dispose();
  });

  test("run now posts routine/run and reloads the Routine and its log", async () => {
    const mounted = mount({
      hostedRequest: (path, method, body) => {
        if (method === "POST") {
          return Promise.resolve({
            schemaVersion: 1,
            commandId: (JSON.parse(body ?? "{}") as { commandId: string })
              .commandId,
            status: "fired",
            routineId: "brief",
            fireId: "rf-brief-manual-cmd",
          });
        }
        if (path.endsWith("/runs")) {
          return Promise.resolve({
            schemaVersion: 1,
            botId: "scout",
            routineId: "brief",
            entries: [
              {
                schemaVersion: 1,
                entryId: "rf-brief-manual-cmd-entry",
                runId: "rf-brief-manual-cmd",
                trigger: "manual",
                status: "running",
                startedAt: "2026-08-31T00:00:00.000Z",
              },
            ],
          });
        }
        return Promise.resolve({
          schemaVersion: 1,
          botId: "scout",
          routines: [{ ...ROUTINE, nextRunAt: "2026-09-01T21:00:00.000Z" }],
        });
      },
    });

    await mounted.state.value.runNow("scout", "brief");
    expect(mounted.state.value.error).toBeUndefined();
    // The Routine came back with the moment the scheduler armed on.
    expect(mounted.state.value.routines[0]?.nextRunAt).toBe(
      "2026-09-01T21:00:00.000Z",
    );
    expect(mounted.state.value.runs.brief?.[0]).toMatchObject({
      trigger: "manual",
      status: "running",
    });
    mounted.dispose();
  });
});

describe("the completion badge and the state channel", () => {
  /**
   * A Routine that finishes cannot speak in the transcript, so the badge is
   * the only place a completion becomes visible — and it used to read the
   * inbox only on a Bot switch and on opening the drawer. A firing that
   * completed while the app sat open left the count stale until something else
   * happened to reload it, which for a `@every 1m` Routine is most of the day.
   */
  test("reads the inbox again when the Bot's runs change", async () => {
    const inboxReads: string[] = [];
    let invalidate:
      ((topic: "computer" | "runs" | undefined) => Promise<void>) | undefined;
    let stopped = 0;
    const shell = ref({ activeBotId: "scout" });
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        hostedRequest: (path) => {
          if (path.endsWith("/inbox")) {
            inboxReads.push(path);
            return Promise.resolve({
              schemaVersion: 1,
              botId: "scout",
              entries: [],
              unacknowledged: inboxReads.length,
            });
          }
          return Promise.resolve({
            schemaVersion: 1,
            botId: "scout",
            routines: [],
          });
        },
        watchBotState: (_botId, listener) => {
          invalidate = listener.invalidate;
          return () => {
            stopped += 1;
          };
        },
      },
      inject: (key) => {
        if (key === frockBotWebDataKey) return shell as never;
        throw new Error("unexpected client provider");
      },
      provide: () => () => {},
      slot: () => () => {},
    };
    const disposers = routinesClientPlugin(context);
    if (!Array.isArray(disposers)) throw new Error("expected registrations");

    expect(invalidate).toBeDefined();
    // A Turn settling on this Bot — an automation Turn is one — refreshes it.
    await invalidate!("runs");
    // A resynchronise carries no topic and must not be filtered out.
    await invalidate!(undefined);
    // Another subsystem's news is not the badge's business.
    await invalidate!("computer");
    expect(inboxReads).toHaveLength(2);

    shell.value = { activeBotId: "other" };
    await Promise.resolve();
    expect(stopped).toBe(1);
    for (const dispose of disposers.toReversed()) dispose();
  });

  test("does not reach for the shell when the client has no state channel", () => {
    // The Cordis local host has no channel. Injecting the shell there would
    // throw on mount and take the whole Contribution with it.
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        hostedRequest: () =>
          Promise.resolve({ schemaVersion: 1, botId: "scout", routines: [] }),
      },
      inject: () => {
        throw new Error("unexpected client provider");
      },
      provide: () => () => {},
      slot: () => () => {},
    };
    expect(() => routinesClientPlugin(context)).not.toThrow();
  });
});
