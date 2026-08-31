// When the Computer Package runs the durable-root sync (ADR 0013), and when it
// refuses to.
//
// The provider here records every call the provider-neutral Computer interface
// receives, in order, so the claims are about ordering and about absence:
// the pull lands before the Bot's first Computer tool call, the push lands
// after the Turn, a Turn that never touches the Computer syncs nothing at all,
// and a sync that cannot run is a recorded outcome rather than a failed Turn.
import { describe, expect, test } from "bun:test";
import {
  ComputerRegistry,
  computerSyncSummaryV1,
  type ComputerProvider,
  type ComputerSyncSummaryV1,
} from "@frockbot/computer-core";
import { AgentRegistry } from "@frockbot/kernel-agent-loop/agent";
import { AgentLoop } from "@frockbot/kernel-agent-loop";
import {
  SessionStore,
  type LlmProvider,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context, type Plugin } from "cordis";
import { createComputerAgentPlugin } from "./agent.js";

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

interface SyncFixture {
  calls: string[];
  provider: ComputerProvider;
  /** The change signal the on-Computer watcher reports; move it to force a sync. */
  signal: { value: string | undefined };
  /** What every `reconcile` answers. */
  answer: (reason: string) => ComputerSyncSummaryV1 | Promise<never>;
}

function fixture(
  answer: SyncFixture["answer"] = () => computerSyncSummaryV1("ok"),
): SyncFixture {
  const calls: string[] = [];
  const signal = { value: "signal-1" as string | undefined };
  const provider: ComputerProvider = {
    id: "recording",
    open: (identity, tenant, assignment) => {
      calls.push(`open:${tenant.botId}`);
      return Promise.resolve({
        assignment,
        identity,
        tenant,
        sync: {
          reconcile: async (reason) => {
            calls.push(`sync:${reason}`);
            return await answer(reason);
          },
          signal: () => {
            calls.push("signal");
            return Promise.resolve(signal.value);
          },
        },
        exec: {
          execute: () => {
            calls.push("exec");
            return Promise.resolve({
              exitCode: 0,
              stdout: new TextEncoder().encode("done"),
              stderr: new Uint8Array(),
              outputTruncated: false,
            });
          },
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return { calls, provider, signal, answer };
}

/**
 * A model that runs the Computer tool once per listed command and then stops.
 * `[]` is a Turn that never touches the Computer.
 */
function modelRunning(
  commands: readonly string[],
  beforeStep?: (step: number) => void,
): LlmProvider {
  let issued = 0;
  let step = 0;
  return {
    id: "scripted",
    async *stream() {
      step += 1;
      beforeStep?.(step);
      const command = commands[issued];
      if (command !== undefined) {
        issued += 1;
        yield {
          type: "tool-call",
          call: {
            id: `call-${issued}`,
            name: "computer_exec",
            input: { command },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "completed" };
    },
  };
}

async function runTurn(
  provider: ComputerProvider,
  model: LlmProvider,
): Promise<SessionEvent[]> {
  const root = new Context();
  await root.plugin(SessionStore, {});
  await root.plugin(SystemPromptRegistry);
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(ComputerRegistry);
  await root.plugin(AgentRegistry);
  const providerPlugin: Plugin.Function = (ctx) => {
    const disposeModel = ctx.llm.register(model);
    const disposeComputer = ctx.computers.register(provider);
    return () => {
      disposeComputer();
      disposeModel();
    };
  };
  providerPlugin.inject = ["llm", "computers"];
  await root.plugin(providerPlugin);
  await root.plugin(
    createComputerAgentPlugin({
      userId: "user-1",
      defaultProviderId: "recording",
    }),
  );
  await root.plugin(AgentLoop, { maxSteps: 4, composition: COMPOSITION });

  const handle = await root.agents.create({
    botId: "bot-1",
    sessionId: "session-1",
    provider: model.id,
    model: "test-model",
    admitEffect: () => Promise.resolve(true),
  });
  handle.agent.send("use the Computer");
  await handle.agent.whenIdle();
  const events = [...handle.agent.session.events];
  await root.fiber.dispose();
  return events;
}

function syncEvents(events: readonly SessionEvent[]) {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "computer/sync" }> =>
      event.type === "computer/sync",
  );
}

describe("the Computer Package as the sync's caller", () => {
  test("pulls before the Turn's first Computer tool call and pushes after the Turn", async () => {
    const { calls, provider } = fixture();

    const events = await runTurn(provider, modelRunning(["pwd"]));

    // The pull is between opening the Computer and the Bot's first look at it,
    // so the Workspace the command sees is the one object storage holds.
    expect(calls.slice(0, 4)).toEqual([
      "open:bot-1",
      "sync:open",
      // The baseline the watcher's signal is compared against next time.
      "signal",
      "exec",
    ]);
    expect(calls.at(-1)).toBe("sync:turn-end");
    // Both runs are visible in durable state, on the Turn that caused them.
    expect(
      syncEvents(events).map((event) => [
        event.turn,
        event.reason,
        event.status,
      ]),
    ).toEqual([
      [1, "open", "ok"],
      [1, "turn-end", "ok"],
    ]);
  });

  test("a Turn that never uses the Computer never syncs, so nothing wakes", async () => {
    const { calls, provider } = fixture();

    const events = await runTurn(provider, modelRunning([]));

    expect(calls).toEqual([]);
    expect(syncEvents(events)).toEqual([]);
  });

  test("syncs again inside a Turn only when the watcher's change signal moved", async () => {
    const { calls, provider, signal } = fixture();
    // The watcher reports a change before the third step's tool call, and
    // reports nothing new before the second: only one extra sync may follow.
    const model = modelRunning(["first", "second", "third"], (step) => {
      if (step === 3) signal.value = "signal-2";
    });

    const events = await runTurn(provider, model);

    expect(calls.filter((call) => call.startsWith("sync:"))).toEqual([
      "sync:open",
      "sync:signal",
      "sync:turn-end",
    ]);
    expect(syncEvents(events).map((event) => event.reason)).toEqual([
      "open",
      "signal",
      "turn-end",
    ]);
  });

  test("an unavailable sync is recorded on the Turn and never fails it", async () => {
    const { provider } = fixture((reason) => {
      if (reason === "open") {
        return Promise.reject(
          new Error("the Computer is paused"),
        ) as Promise<never>;
      }
      return computerSyncSummaryV1("unavailable", "the Computer is paused");
    });

    const events = await runTurn(provider, modelRunning(["pwd"]));

    // The Turn completed: the tool ran and the Turn closed normally.
    expect(
      events.some(
        (event) => event.type === "turn/end" && event.outcome === "completed",
      ),
    ).toBe(true);
    expect(
      syncEvents(events).map((event) => [event.reason, event.status]),
    ).toEqual([
      ["open", "unavailable"],
      ["turn-end", "unavailable"],
    ]);
    expect(syncEvents(events)[0]?.detail).toContain("paused");
  });
});
