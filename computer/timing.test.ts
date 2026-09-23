// `computer/timing`: where one Computer call spent its time.
//
// The provider here advances a fake clock by a fixed amount inside each thing
// it does, so every phase the event reports is a number the test chose. The
// claims are about attribution (each phase holds exactly its own work),
// absence (a phase that did not run is not reported as zero) and durability
// (the Turn-end line reaches storage without waiting for another Turn).
import { describe, expect, test } from "bun:test";
import {
  type ComputerDoctorReportV1,
  type ComputerHostCapabilitiesV1,
  type ComputerHostV1,
  computerSyncSummaryV1,
} from "@frockbot/computer/core/host";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type {
  ComputerCaptureTimingV1,
  LlmProvider,
  SessionEvent,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { FakeWorkspace } from "@frockbot/computer/fake";
import { createComputerAgentFeature } from "./agent.js";
import {
  fileComputerScreenshotV1,
  pruneComputerScreenshotsV1,
} from "./capture.js";
import { COMPUTER_SCREENSHOT_RETENTION } from "./roots.js";
import { computerFrameSinkV1 } from "./frame.js";

const TEST_HOST_CAPABILITIES: ComputerHostCapabilitiesV1 = {
  viewerFrameOrigins: [],
};

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

const REPORT: ComputerDoctorReportV1 = {
  schemaVersion: 2,
  generation: 1,
  capturedAt: "2026-09-23T00:00:00.000Z",
  checks: [],
  summary: "0 checks",
};

/** What each operation costs on the fake clock, in milliseconds. */
const COST = {
  open: 5,
  reconcile: 400,
  signal: 20,
  doctor: 30,
  exec: 700,
  screenshot: 100,
  write: 200,
  list: 10,
  delete: 3,
  frame: 2,
} as const;

class Clock {
  ms = 0;
  readonly now = () => this.ms;
  spend(cost: number): void {
    this.ms += cost;
  }
}

/** The in-memory Workspace, with each call spending its cost first. */
class TimedWorkspace extends FakeWorkspace {
  constructor(private readonly clock: Clock) {
    super();
  }

  override write(request: {
    path: WorkspacePathV1;
    bytes: Uint8Array;
    writer: WorkspaceWriterV1;
  }) {
    this.clock.spend(COST.write);
    return super.write(request);
  }

  override list(request: { root: WorkspaceRootV1; prefix?: string }) {
    this.clock.spend(COST.list);
    return super.list(request);
  }

  override delete(request: { path: WorkspacePathV1 }) {
    this.clock.spend(COST.delete);
    return super.delete(request);
  }
}

/** The Bot Durable Object storage the card's frame goes to, timed. */
class TimedFrames {
  readonly values = new Map<string, unknown>();
  constructor(private readonly clock: Clock) {}
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.clock.spend(COST.frame);
    this.values.set(key, value);
    return Promise.resolve();
  }
}

interface ProviderOptions {
  sync?: boolean;
  screenshot?: boolean;
  doctor?: boolean;
  execFails?: boolean;
}

function provider(clock: Clock, options: ProviderOptions = {}): ComputerHostV1 {
  const workspace = new TimedWorkspace(clock);
  return {
    id: "timed",
    capabilities: TEST_HOST_CAPABILITIES,
    open: (identity, tenant, assignment) => {
      clock.spend(COST.open);
      return Promise.resolve({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        workspace,
        ...(options.sync === false
          ? {}
          : {
              sync: {
                reconcile: () => {
                  clock.spend(COST.reconcile);
                  return Promise.resolve(computerSyncSummaryV1("ok"));
                },
                signal: () => {
                  clock.spend(COST.signal);
                  return Promise.resolve("signal-1");
                },
              },
            }),
        ...(options.doctor === false
          ? {}
          : {
              doctor: {
                run: () => {
                  clock.spend(COST.doctor);
                  return Promise.resolve(REPORT);
                },
              },
            }),
        ...(options.screenshot === false
          ? {}
          : {
              screenshot: {
                capture: () => {
                  clock.spend(COST.screenshot);
                  return Promise.resolve({
                    bytes: new Uint8Array([137, 80, 78, 71]),
                    mediaType: "image/png" as const,
                    display: ":100",
                    capturedAt: "2026-09-23T00:00:00.000Z",
                  });
                },
              },
            }),
        exec: {
          execute: () => {
            clock.spend(COST.exec);
            if (options.execFails) {
              return Promise.reject(new Error("the Computer went away"));
            }
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
}

/** One Computer tool call the scripted model makes. */
interface ScriptedCall {
  toolName: string;
  arguments: Record<string, unknown>;
}

/** `computer_exec` for a command, the call most of these Turns make. */
function exec(command: string): ScriptedCall {
  return { toolName: "computer_exec", arguments: { command } };
}

/** A model that makes each listed call in its own step, then stops. */
function modelRunning(calls: readonly ScriptedCall[]): LlmProvider {
  let issued = 0;
  return {
    id: "scripted",
    async *stream() {
      const next = calls[issued];
      if (next !== undefined) {
        issued += 1;
        yield {
          type: "tool-call",
          call: {
            id: `call-${issued}`,
            name: "call_dynamic_tool",
            input: { namespace: "frockbot", ...next },
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

interface TurnResult {
  /** The in-memory log, in append order. */
  events: SessionEvent[];
  /** What reached storage by the time the Turn went idle. */
  persisted: SessionEvent[];
}

async function runTurn(
  clock: Clock,
  calls: readonly ScriptedCall[],
  options: ProviderOptions = {},
): Promise<TurnResult> {
  const persisted: SessionEvent[] = [];
  const runtime = createAgentRuntimeHarness({
    sessions: {
      persistEvents: (_sessionId, events) => {
        persisted.push(...events);
        return Promise.resolve();
      },
    },
  });
  const model = modelRunning(calls);
  runtime.llm.register(model);
  runtime.computers.register(provider(clock, options));
  await runtime.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: "timed",
      writer: { sessionId: "session-1", turnId: "run-1", runId: "run-1" },
      frames: computerFrameSinkV1(new TimedFrames(clock)),
      now: clock.now,
    }),
  );
  const loop = createAgentLoop(runtime, {
    maxSteps: 6,
    composition: COMPOSITION,
  });
  const handle = await loop.create({
    botId: "bot-1",
    sessionId: "session-1",
    provider: model.id,
    model: "test-model",
    admitEffect: () => Promise.resolve(true),
  });
  handle.agent.send("use the Computer");
  await handle.agent.whenIdle();
  const events = [...handle.agent.session.activeRunJournal];
  await loop.dispose();
  await runtime.dispose();
  return { events, persisted };
}

type TimingEvent = Extract<SessionEvent, { type: "computer/timing" }>;

function timings(events: readonly SessionEvent[]): TimingEvent[] {
  return events.filter(
    (event): event is TimingEvent => event.type === "computer/timing",
  );
}

/** `computer_screenshot`'s filing: the capture and its durable write. */
const CAPTURE = {
  screenshot: COST.screenshot,
  write: COST.write,
  total: COST.screenshot + COST.write,
};

/** The Turn end's frame: the capture and one write to the Bot's storage. */
const FRAME = {
  screenshot: COST.screenshot,
  write: COST.frame,
  total: COST.screenshot + COST.frame,
};

describe("computer/timing", () => {
  test("a Turn's first Computer call reports every phase it ran, each holding only its own work", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [exec("pwd")]);

    const [call, turnEnd] = timings(events);
    // The self-check files its report through the Workspace, so its write is
    // its own and never the capture's.
    const selfCheck = COST.doctor + COST.write;
    const sync = COST.reconcile + COST.signal;
    expect(call).toMatchObject({
      turn: 1,
      scope: "tool",
      tool: "computer_exec",
      ms: {
        attach: COST.open,
        sync,
        selfCheck,
        operation: COST.exec,
        total: COST.open + sync + selfCheck + COST.exec,
      },
    });
    // A Computer action photographs nothing.
    expect(call?.ms).not.toHaveProperty("capture");
    expect(turnEnd).toMatchObject({
      turn: 1,
      scope: "turn-end",
      ms: {
        attach: COST.open,
        capture: FRAME,
        sync: COST.reconcile,
        total: COST.open + FRAME.total + COST.reconcile,
      },
    });
    expect(turnEnd).not.toHaveProperty("tool");
    // No preview tab was opened, so the Turn end ran no operation.
    expect(turnEnd?.ms).not.toHaveProperty("operation");
  });

  test("a later call in the same Turn omits the self-check it did not repeat", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [exec("pwd"), exec("ls")]);

    const calls = timings(events).filter((event) => event.scope === "tool");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.ms).toHaveProperty("selfCheck");
    // The watcher's signal did not move, so the sync phase is the signal
    // check alone.
    expect(calls[1]?.ms).toEqual({
      attach: COST.open,
      sync: COST.signal,
      operation: COST.exec,
      total: COST.open + COST.signal + COST.exec,
    });
  });

  test("a Computer with no sync, no self-check and no screen reports none of them", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [exec("pwd")], {
      sync: false,
      doctor: false,
      screenshot: false,
    });

    expect(timings(events).map((event) => event.ms)).toEqual([
      {
        attach: COST.open,
        operation: COST.exec,
        total: COST.open + COST.exec,
      },
      { attach: COST.open, total: COST.open },
    ]);
  });

  test("a call that failed still says where its time went", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [exec("pwd")], { execFails: true });

    const [call] = timings(events);
    expect(call?.ms).toMatchObject({
      attach: COST.open,
      operation: COST.exec,
    });
    // The failed exec was never photographed.
    expect(call?.ms).not.toHaveProperty("capture");
    const result = events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: true });
  });

  test("a call's line precedes its result, and the Turn-end line is durable when the Turn goes idle", async () => {
    const clock = new Clock();

    const { events, persisted } = await runTurn(clock, [exec("pwd")]);

    const types = events.map((event) => event.type);
    const callTiming = types.indexOf("computer/timing");
    expect(callTiming).toBeGreaterThan(-1);
    expect(callTiming).toBeLessThan(types.indexOf("tool/result"));
    // The Turn-end line follows the Turn's own close and its push.
    expect(types.lastIndexOf("computer/timing")).toBeGreaterThan(
      types.lastIndexOf("computer/sync"),
    );
    expect(timings(persisted).map((event) => event.scope)).toEqual([
      "tool",
      "turn-end",
    ]);
  });

  test("computer_screenshot reports its own filing as the capture it is", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [
      { toolName: "computer_screenshot", arguments: {} },
    ]);

    const [call, turnEnd] = timings(events);
    expect(call?.tool).toBe("computer_screenshot");
    expect(call?.ms.capture).toEqual(CAPTURE);
    // The capture is the whole action; nothing else is claimed for it.
    expect(call?.ms).not.toHaveProperty("operation");
    // Retention runs at the Turn end, and only because a capture was filed.
    // One capture is within it, so nothing is pruned.
    expect(turnEnd?.ms.capture).toEqual({
      ...FRAME,
      list: COST.list,
      total: FRAME.total + COST.list,
    });
  });

  test("a call refused before it reached the Computer records no timing", async () => {
    const clock = new Clock();

    const { events } = await runTurn(clock, [
      { toolName: "computer_exec", arguments: {} },
    ]);

    expect(events.find((event) => event.type === "tool/result")).toMatchObject({
      isError: true,
    });
    // The Turn never used the Computer, so there is no Turn end to time.
    expect(timings(events)).toEqual([]);
  });

  test("a filing never lists or prunes, and the Turn end's prune reports its own steps", async () => {
    const clock = new Clock();
    const workspace = new TimedWorkspace(clock);
    const root: WorkspaceRootV1 = {
      kind: "package-declared",
      userId: "user-1",
      packageId: "computer",
      rootId: "screenshots",
    };
    const writer: WorkspaceWriterV1 = {
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-1",
      runId: "run-1",
    };
    for (let index = 0; index < COMPUTER_SCREENSHOT_RETENTION; index += 1) {
      await workspace.write({
        path: { root, path: `bot/old-${index}.png` },
        bytes: new Uint8Array(),
        writer,
      });
    }
    const filing: ComputerCaptureTimingV1 = { total: 0 };
    clock.ms = 0;

    await fileComputerScreenshotV1({
      computer: await provider(clock).open(
        { userId: "user-1" },
        { botId: "bot-1" },
        { providerId: "timed", generation: 1 },
      ),
      workspace,
      path: { root, path: "bot/new.png" },
      writer,
      effectId: "effect-1",
      timing: filing,
      now: clock.now,
    });

    expect(filing).toEqual({
      screenshot: COST.screenshot,
      write: COST.write,
      total: 0,
    });

    const retention: ComputerCaptureTimingV1 = { total: 0 };
    await pruneComputerScreenshotsV1({
      workspace,
      root,
      botKey: "bot",
      writer,
      timing: retention,
      now: clock.now,
    });

    expect(retention).toEqual({
      list: COST.list,
      prune: COST.delete,
      total: 0,
    });
    expect(workspace.files.size).toBe(COMPUTER_SCREENSHOT_RETENTION);
  });
});
