import { describe, expect, test } from "bun:test";
import type {
  ClientPluginContext,
  ClientSlotRegistration,
} from "@frockbot/client-core";
import { auditClientPlugin } from "./index.js";
import { auditStateKey, type AuditClientState } from "./state.js";

const ENTRY = {
  schemaVersion: 1,
  botId: "scout",
  runId: "run-1",
  occurrenceId: "tool:1:1:0",
  turn: 1,
  step: 1,
  ordinal: 0,
  effectId: "tool:1:1:0",
  at: "2026-08-31T00:00:00.000Z",
  kind: "shell",
  target: "computer",
  toolName: "computer_exec",
  argumentDigest: "a".repeat(64),
  preview: "ls -la",
  outcome: "ok",
};

function mount(
  overrides: {
    hostedRequest?: ClientPluginContext["transport"]["hostedRequest"];
  } = {},
): {
  state: { value: AuditClientState };
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
              status: "rebuilt",
              entries: 1,
              bots: 1,
              indexState: "ready",
              unknownOutcomes: 0,
              hostJournalDiscrepancies: 2,
            });
          }
          return Promise.resolve({
            schemaVersion: 1,
            entries: [ENTRY],
            page: path.includes("before=")
              ? { truncated: false }
              : { truncated: true, nextCursor: "p1" },
            total: 2,
            indexState: "ready",
          });
        }),
    },
    inject: () => {
      throw new Error("unexpected client provider");
    },
    provide: (key, value) => {
      if (key === auditStateKey) state = value;
      return () => {};
    },
    slot: (registration) => {
      slots.push(registration);
      return () => slots.splice(slots.indexOf(registration), 1);
    },
  };
  const disposers = auditClientPlugin(context);
  if (!Array.isArray(disposers)) throw new Error("expected registrations");
  return {
    state: state as { value: AuditClientState },
    slots,
    calls,
    dispose: () => {
      for (const dispose of disposers.toReversed()) dispose();
    },
  };
}

describe("Audit client contribution", () => {
  test("mounts into the Bot settings outlet", () => {
    const mounted = mount();
    expect(mounted.slots.map((slot) => slot.slot)).toEqual([
      "frockbot.bot-settings-sections",
    ]);
    mounted.dispose();
  });

  test("loads a Bot's activity and decodes it at the seam", async () => {
    const mounted = mount();
    await mounted.state.value.load("scout");
    expect(mounted.state.value.entries).toHaveLength(1);
    expect(mounted.state.value.total).toBe(2);
    expect(mounted.state.value.botId).toBe("scout");
    expect(mounted.calls[0]).toEqual([
      "/api/audit?botId=scout",
      undefined,
      undefined,
    ]);
    mounted.dispose();
  });

  test("carries a filter chip into the query string", async () => {
    const mounted = mount();
    await mounted.state.value.load("scout", { kind: "mcp" });
    expect(mounted.calls[0]?.[0]).toBe("/api/audit?botId=scout&kind=mcp");
    mounted.dispose();
  });

  test("pages with the cursor the previous answer gave it", async () => {
    const mounted = mount();
    await mounted.state.value.load("scout");
    await mounted.state.value.loadMore("scout");
    expect(mounted.calls[1]?.[0]).toBe("/api/audit?botId=scout&before=p1");
    expect(mounted.state.value.entries).toHaveLength(2);
    expect(mounted.state.value.nextCursor).toBeUndefined();
    // Nothing further to ask for: a second call is a no-op, not a repeat.
    await mounted.state.value.loadMore("scout");
    expect(mounted.calls).toHaveLength(2);
    mounted.dispose();
  });

  test("holds the rebuild receipt, discrepancy count and all", async () => {
    const mounted = mount();
    await mounted.state.value.rebuild("scout");
    expect(mounted.calls[0]).toEqual(["/api/audit/rebuild", "POST", "{}"]);
    expect(mounted.state.value.receipt).toMatchObject({
      status: "rebuilt",
      hostJournalDiscrepancies: 2,
    });
    // And it reloads, so the rows on screen are the rebuilt ones.
    expect(mounted.calls[1]?.[0]).toBe("/api/audit?botId=scout");
    mounted.state.value.dismissReceipt();
    expect(mounted.state.value.receipt).toBeUndefined();
    mounted.dispose();
  });

  test("names a failure rather than showing an empty panel", async () => {
    const mounted = mount({
      hostedRequest: () => Promise.reject(new Error("the gateway is away")),
    });
    await mounted.state.value.load("scout");
    expect(mounted.state.value.error).toBe("the gateway is away");
    expect(mounted.state.value.loaded).toBe(false);
    mounted.dispose();
  });
});
