// `computer_doctor` (parity row 27) and the GUI policy at the exec seam (row
// 33).
//
// What is asserted here is what the Package does with the Computer's answer:
// the report is filed through the Workspace so the Bot is recorded as its
// writer, the self-check runs once for the Computer this instance opened, and
// a `chromium …` command is refused with the sentence that names the tool to
// use instead.
import { describe, expect, test } from "bun:test";
import { computerBotPathKeyV1 } from "@frockbot/computer/core";
import { type ComputerDoctorReportV1 } from "@frockbot/computer/core/host";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import { createComputerAgentFeature } from "./agent.js";
import {
  createFakeComputerHostV1,
  FAKE_HOST_CAPABILITIES_V1,
  FAKE_SCRATCH_ROOT,
  type FakeComputerHostV1,
  type FakeWorkspace,
} from "@frockbot/computer/fake";

/**
 * The in-memory host carries its own scratch path and its own GUI policy,
 * neither of which this Package knows: what the tools say and refuse has to
 * come from the host, so the assertions below name the host's constants and
 * never a literal of their own.
 */
const REFUSED_GUI_COMMAND = "xdotool key Return";
const HOST_GUI_REFUSAL =
  FAKE_HOST_CAPABILITIES_V1.refuseGuiCommand!(REFUSED_GUI_COMMAND)!;

const REPORT: ComputerDoctorReportV1 = {
  schemaVersion: 2,
  generation: 3,
  capturedAt: "2026-09-01T00:00:00.000Z",
  checks: [
    { name: "disk-root", status: "pass", detail: "12% full, 90 GiB free" },
    { name: "dns", status: "fail", detail: "api.fly.io does not resolve" },
  ],
  // Parity row 34b: what the browser announced itself as, filed with the rest
  // of the report so the measurement is readable while the Computer sleeps.
  browserIdentity: {
    userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36",
    webdriver: false,
    brands: ["Chromium/141"],
  },
  summary: "2 checks, 1 passed, 1 failed",
};

interface Fixture {
  host: FakeComputerHostV1;
  workspace: FakeWorkspace;
  /** How many times the self-check ran on this host. */
  readonly runs: number;
  /** Every command that reached the Computer, in order. */
  readonly execs: string[];
}

function fixture(): Fixture {
  const host = createFakeComputerHostV1({
    id: "fixture",
    doctor: REPORT,
    execDefault: { stdout: "ran" },
  });
  const computer = host.computerFor({ userId: "user-1" });
  return {
    host,
    workspace: computer.workspace,
    get runs() {
      return host.calls.filter((call) => call.startsWith("doctor:")).length;
    },
    get execs() {
      return computer.execCalls.map((call) => call.command);
    },
  };
}

async function mount(provider: FakeComputerHostV1) {
  const harness = createAgentRuntimeHarness();
  harness.computers.register(provider);
  await harness.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: "fixture",
      writer: { sessionId: "session-1", turnId: "run-9", runId: "run-9" },
    }),
  );
  return harness;
}

function context(effectId = "tool:1:1:0") {
  return {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId,
    signal: new AbortController().signal,
  };
}

async function call(
  harness: AgentRuntimeHarness,
  name: string,
  input: unknown,
  effectId?: string,
) {
  const execution = context(effectId);
  const prepared = await harness.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    execution,
  );
  if (prepared.kind !== "ready") return prepared.result;
  return harness.tools.executePrepared(prepared, execution);
}

describe("computer_doctor", () => {
  test("answers the report and files it with the Bot as its writer", async () => {
    const state = fixture();
    const workspace = state.workspace;
    const harness = await mount(state.host);

    const result = await call(harness, "computer_doctor", {});

    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.content) as Record<string, unknown>;
    expect(answer).toMatchObject({
      schemaVersion: 2,
      generation: 3,
      summary: "2 checks, 1 passed, 1 failed",
      rootId: "doctor",
    });
    const botKey = computerBotPathKeyV1("bot-1");
    expect(answer.path).toBe(`${botKey}/latest.json`);
    expect(answer.checks).toHaveLength(2);

    // Through the Workspace, never left on the Computer: a report that
    // reached object storage by a shell write would arrive `unattributed`,
    // which is data and never provenance.
    const written = workspace.writes.find((write) =>
      write.path.path.endsWith("latest.json"),
    );
    expect(written?.path.root).toMatchObject({
      kind: "package-declared",
      packageId: "computer",
      rootId: "doctor",
    });
    expect(written?.writer).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-9",
      runId: "run-9",
    });
    const filed = JSON.parse(
      new TextDecoder().decode(written!.bytes),
    ) as ComputerDoctorReportV1;
    expect(filed).toEqual(REPORT);
  });

  test("is offered on every turn type, so a Routine can diagnose too", async () => {
    // A Routine that finds a Computer misbehaving has to be able to say what
    // is wrong with it, and a read-only call is admissible wherever a Turn is.
    const state = fixture();
    const harness = await mount(state.host);

    for (const turnType of ["chat", "automation", "subagent"] as const) {
      const names = harness.tools
        .schemas({ turnType })
        .map((schema) => schema.name);
      expect(names, turnType).toContain("computer_doctor");
    }
  });

  test("runs the self-check once for the Computer this instance opened", async () => {
    // "box-doctor runs at startup and on demand". Startup is the first time
    // this Bot reaches its Computer after this Package loaded — the first Turn
    // after a cold provisioning. Repeating it costs a read-only exec and no
    // effect, so the guard is against waste and never against damage.
    const state = fixture();
    const harness = await mount(state.host);

    await call(harness, "computer_exec", { command: "ls" }, "tool:1:1:0");
    await call(harness, "computer_exec", { command: "pwd" }, "tool:1:1:1");

    expect(state.runs).toBe(1);
  });
});

// Which commands drive a GUI, and what to say about one, is the host's own
// policy — it is the thing that also shims those binaries on its PATH. What
// this Package owes is to ask before it runs anything, and to answer in the
// host's words. The policy itself is `computer/fly/runtime.test.ts`.
describe("the GUI is never driven from the shell", () => {
  test("refuses in the host's words, without waking the Computer", async () => {
    const state = fixture();
    const harness = await mount(state.host);

    const result = await call(harness, "computer_exec", {
      command: REFUSED_GUI_COMMAND,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(HOST_GUI_REFUSAL);
    // Refused at the seam: it never reached the Computer at all.
    expect(state.execs).toEqual([]);
  });

  test("lets a command the host does not refuse through", async () => {
    const state = fixture();
    const harness = await mount(state.host);

    const result = await call(harness, "computer_exec", {
      command: "grep -c chromium /home/box/.frockbot/bots/x/chromium.log",
    });

    expect(result.isError).toBe(false);
    expect(state.execs).toHaveLength(1);
  });

  test("says where the host's shared scratch is, and that it is not durable", async () => {
    const state = fixture();
    const harness = await mount(state.host);
    const description = harness.tools
      .schemas({ turnType: "chat" })
      .find((schema) => schema.name === "computer_exec")?.description;

    expect(description).toContain(FAKE_SCRATCH_ROOT);
    expect(description).not.toContain("/workspace");
    expect(description).toContain("not durable");
    expect(description).toContain("never driven from the shell");
  });
});
