// `computer_exec{background:true}` and the three process tools, as a Turn
// drives them.
//
// The rules under test are the ones a later change could quietly break: the
// record is written before anything launches, the outcome is read rather than
// re-run, a moved generation answers `unknown` rather than `running`, and the
// log tail leaves the Computer so a rebuild cannot erase the only evidence a
// job ran.
import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import {
  ComputerRegistry,
  computerBotPathKeyV1,
  type ComputerBackgroundStateV1,
  type ComputerHandle,
  type ComputerProvider,
} from "@frockbot/computer-core";
import { createPluginHarness } from "@frockbot/plugin-testkit";
import { SessionStore } from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin } from "./agent.js";
import type { ComputerProcessStorageV1 } from "./process-store.js";
import { FakeWorkspace } from "./workspace-fixture.js";

/** Storage enough for the store: a map with a prefix listing. */
function storage(): ComputerProcessStorageV1 & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    list: <T>(options: { prefix: string; limit?: number }) => {
      const held = new Map<string, T>();
      for (const [key, value] of map) {
        if (!key.startsWith(options.prefix)) continue;
        if (options.limit !== undefined && held.size >= options.limit) break;
        held.set(key, value as T);
      }
      return Promise.resolve(held);
    },
  };
}

interface Computer {
  provider: ComputerProvider;
  calls: string[];
  generation: number;
  state: ComputerBackgroundStateV1;
  workspace: FakeWorkspace;
}

function fakeComputer(): Computer {
  const calls: string[] = [];
  const workspace = new FakeWorkspace();
  const computer: Computer = {
    calls,
    generation: 1,
    state: { alive: true, logTail: "building…" },
    workspace,
    provider: {
      id: "fixture",
      open: (identity, tenant, assignment): Promise<ComputerHandle> =>
        Promise.resolve({
          assignment,
          identity,
          tenant,
          workspace,
          processes: {
            launch: (request) => {
              calls.push(`launch:${request.processId}:${request.command}`);
              return Promise.resolve({
                pid: 4321,
                logPath: `/processes/${request.processId}/log`,
                generation: computer.generation,
                cwd: "/workspaces/bot-1",
              });
            },
            inspect: (processId) => {
              calls.push(`inspect:${processId}`);
              return Promise.resolve(computer.state);
            },
            stop: (processId) => {
              calls.push(`stop:${processId}`);
              return Promise.resolve(computer.state);
            },
            generation: () => Promise.resolve(computer.generation),
          },
          close: () => Promise.resolve(),
        }),
    },
  };
  return computer;
}

async function mount(computer: Computer, held: ComputerProcessStorageV1) {
  const harness = await createPluginHarness([
    ComputerRegistry,
    ToolRegistry,
    SystemPromptRegistry,
    SessionStore,
  ]);
  harness.root.computers.register(computer.provider);
  await harness.mount(
    createComputerAgentPlugin({
      userId: "user-1",
      defaultProviderId: "fixture",
      writer: { sessionId: "session-1", turnId: "run-9", runId: "run-9" },
      processes: held,
    }),
  );
  return harness;
}

async function call(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
  name: string,
  input: unknown,
  effectId = "tool:1:1:0",
) {
  const context = {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId,
    signal: new AbortController().signal,
  };
  const prepared = await harness.root.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.root.tools.executePrepared(prepared, context);
}

describe("computer_exec with background:true", () => {
  test("records the intent before it launches anything", async () => {
    const computer = fakeComputer();
    const held = storage();
    const harness = await mount(computer, held);

    const result = await call(harness, "computer_exec", {
      command: "npm run build",
      background: true,
    });

    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.content) as { processId: string };
    const record = held.map.get(`computer-process:${answer.processId}`) as
      Record<string, unknown> | undefined;
    expect(record).toMatchObject({
      schemaVersion: 1,
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-9",
      command: "npm run build",
      status: "running",
      generation: 1,
      effectId: "tool:1:1:0",
      pid: 4321,
    });
    // The record names the effect that produced it, so a recovery reads the
    // outcome rather than launching a second process.
    expect(computer.calls).toEqual([
      `launch:${answer.processId}:npm run build`,
    ]);
    // And the answer says out loud that nothing keeps the Computer awake.
    expect(result.content).toContain("hibernates");
    await harness.dispose();
  });

  test("is refused where there is nowhere durable to record it", async () => {
    const computer = fakeComputer();
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    harness.root.computers.register(computer.provider);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
        writer: { sessionId: "session-1", turnId: "run-9", runId: "run-9" },
      }),
    );

    const result = await call(harness, "computer_exec", {
      command: "sleep 60",
      background: true,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("nowhere durable to record it");
    expect(computer.calls).toEqual([]);
    // And the tools that read a process are not offered either.
    expect(
      harness.root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).not.toContain("computer_process_check");
    await harness.dispose();
  });
});

describe("checking a background process", () => {
  test("answers running, then the exit code, and mirrors the log on completion", async () => {
    const computer = fakeComputer();
    const held = storage();
    const harness = await mount(computer, held);
    const launched = JSON.parse(
      (
        await call(harness, "computer_exec", {
          command: "npm run build",
          background: true,
        })
      ).content,
    ) as { processId: string };

    const running = JSON.parse(
      (
        await call(harness, "computer_process_check", {
          processId: launched.processId,
        })
      ).content,
    ) as { status: string };
    expect(running.status).toBe("running");
    // Nothing durable is mirrored while it runs: there is no outcome yet.
    expect(computer.workspace.files.size).toBe(0);

    computer.state = { alive: false, exitCode: 0, logTail: "build ok" };
    const finished = JSON.parse(
      (
        await call(harness, "computer_process_check", {
          processId: launched.processId,
        })
      ).content,
    ) as { status: string; exitCode: number };

    expect(finished).toMatchObject({ status: "exited", exitCode: 0 });
    // Written through the Workspace, so the Bot is recorded as its writer and
    // an image rebuild cannot erase the only evidence the job ran.
    const mirrored = computer.workspace.files.get(
      `${computerBotPathKeyV1("bot-1")}/${launched.processId}.log`,
    );
    expect(mirrored).toBeDefined();
    expect(new TextDecoder().decode(mirrored!.bytes)).toContain("build ok");
    expect(mirrored!.generation.writer).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-9",
      runId: "run-9",
    });
    await harness.dispose();
  });

  test("answers unknown, never running, once the Computer's generation moved", async () => {
    const computer = fakeComputer();
    const held = storage();
    const harness = await mount(computer, held);
    const launched = JSON.parse(
      (
        await call(harness, "computer_exec", {
          command: "sleep 600",
          background: true,
        })
      ).content,
    ) as { processId: string };

    // The Computer was reprovisioned under it. Whatever its pid table says,
    // the process this Bot launched is gone.
    computer.generation = 2;
    computer.state = { alive: true, logTail: "…" };
    const answer = JSON.parse(
      (
        await call(harness, "computer_process_check", {
          processId: launched.processId,
        })
      ).content,
    ) as { status: string; note?: string };

    expect(answer.status).toBe("unknown");
    expect(answer.note).toContain("not running");
    expect(
      (
        held.map.get(`computer-process:${launched.processId}`) as {
          status: string;
        }
      ).status,
    ).toBe("unknown");
    await harness.dispose();
  });

  test("refuses a process this Bot never launched", async () => {
    const computer = fakeComputer();
    const harness = await mount(computer, storage());

    const result = await call(harness, "computer_process_check", {
      processId: "p-someone-else",
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("No background process");
    expect(computer.calls).toEqual([]);
    await harness.dispose();
  });
});

describe("the process tools' admission", () => {
  test("offers check and logs on an automation turn, beside computer_exec", async () => {
    const harness = await mount(fakeComputer(), storage());
    const named = (turnType: "chat" | "automation") =>
      harness.root.tools.schemas({ turnType }).map((tool) => tool.name);

    // A Routine has to be able to collect the outcome of a job a chat Turn
    // started, so these two declare their turn types rather than inheriting
    // whatever the default happens to be.
    expect(named("automation")).toContain("computer_process_check");
    expect(named("automation")).toContain("computer_process_logs");
    // `stop` is admitted wherever `computer_exec` is: ending a process is no
    // narrower than starting one.
    expect(named("automation")).toContain("computer_exec");
    expect(named("automation")).toContain("computer_process_stop");
    expect(named("chat")).toContain("computer_process_stop");
    await harness.dispose();
  });
});

describe("stopping a background process", () => {
  test("ends it and records the outcome once", async () => {
    const computer = fakeComputer();
    const held = storage();
    const harness = await mount(computer, held);
    const launched = JSON.parse(
      (
        await call(harness, "computer_exec", {
          command: "sleep 600",
          background: true,
        })
      ).content,
    ) as { processId: string };
    computer.state = { alive: false, exitCode: 143, logTail: "terminated" };

    const stopped = JSON.parse(
      (
        await call(harness, "computer_process_stop", {
          processId: launched.processId,
        })
      ).content,
    ) as { status: string; exitCode: number };

    expect(stopped).toMatchObject({ status: "exited", exitCode: 143 });
    expect(computer.calls).toEqual([
      `launch:${launched.processId}:sleep 600`,
      `stop:${launched.processId}`,
    ]);
    await harness.dispose();
  });
});
