import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
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
  test("mounts into the Bot settings outlet", () => {
    const mounted = mount();
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.bot-settings-sections",
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
});
