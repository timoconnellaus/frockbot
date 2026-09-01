// `computer_doctor` (parity row 27) and the GUI policy at the exec seam (row
// 33).
//
// What is asserted here is what the Package does with the Computer's answer:
// the report is filed through the Workspace so the Bot is recorded as its
// writer, the self-check runs once for the Computer this instance opened, and
// a `chromium …` command is refused with the sentence that names the tool to
// use instead.
import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import {
  ComputerRegistry,
  computerBotPathKeyV1,
  type ComputerDoctorReportV1,
  type ComputerHandle,
  type ComputerProvider,
} from "@frockbot/computer-core";
import { createPluginHarness } from "@frockbot/plugin-testkit";
import { SessionStore } from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin } from "./agent.js";
import { FakeWorkspace } from "./workspace-fixture.js";

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
  provider: ComputerProvider;
  runs: number;
  execs: string[];
}

function fixture(workspace: FakeWorkspace): Fixture {
  const state: Fixture = {
    runs: 0,
    execs: [],
    provider: {
      id: "fixture",
      open: (identity, tenant, assignment): Promise<ComputerHandle> =>
        Promise.resolve({
          assignment,
          identity,
          tenant,
          workspace,
          doctor: {
            run: () => {
              state.runs += 1;
              return Promise.resolve(REPORT);
            },
          },
          exec: {
            execute: (request) => {
              state.execs.push(request.args?.at(-1) ?? "");
              return Promise.resolve({
                exitCode: 0,
                stdout: new TextEncoder().encode("ran"),
                stderr: new Uint8Array(),
                outputTruncated: false,
              });
            },
          },
          close: () => Promise.resolve(),
        }),
    },
  };
  return state;
}

async function mount(provider: ComputerProvider) {
  const harness = await createPluginHarness([
    ComputerRegistry,
    ToolRegistry,
    SystemPromptRegistry,
    SessionStore,
  ]);
  harness.root.computers.register(provider);
  await harness.mount(
    createComputerAgentPlugin({
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
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
  name: string,
  input: unknown,
  effectId?: string,
) {
  const execution = context(effectId);
  const prepared = await harness.root.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    execution,
  );
  if (prepared.kind !== "ready") return prepared.result;
  return harness.root.tools.executePrepared(prepared, execution);
}

describe("computer_doctor", () => {
  test("answers the report and files it with the Bot as its writer", async () => {
    const workspace = new FakeWorkspace();
    const state = fixture(workspace);
    const harness = await mount(state.provider);

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
    const state = fixture(new FakeWorkspace());
    const harness = await mount(state.provider);

    for (const turnType of ["chat", "automation", "subagent"] as const) {
      const names = harness.root.tools
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
    const state = fixture(new FakeWorkspace());
    const harness = await mount(state.provider);

    await call(harness, "computer_exec", { command: "ls" }, "tool:1:1:0");
    await call(harness, "computer_exec", { command: "pwd" }, "tool:1:1:1");

    expect(state.runs).toBe(1);
  });
});

describe("the GUI is never driven from the shell", () => {
  test("refuses a command that reaches for the browser or the X tools", async () => {
    const state = fixture(new FakeWorkspace());
    const harness = await mount(state.provider);

    for (const command of [
      "chromium --headless https://example.com",
      "cd /tmp && scrot shot.png",
      "xdotool key Return",
      "sudo x11vnc -display :1",
    ]) {
      const result = await call(harness, "computer_exec", { command });
      expect(result.isError, command).toBe(true);
      expect(result.content).toContain("never driven from the shell");
      expect(result.content).toContain("computer_browser");
      expect(result.content).toContain("computer_screenshot");
      expect(result.content).toContain("frockbot-chrome");
    }
    // Refused at the seam: none of them reached the Computer at all.
    expect(state.execs).toEqual([]);
  });

  test("lets a command that merely mentions one through", async () => {
    const state = fixture(new FakeWorkspace());
    const harness = await mount(state.provider);

    const result = await call(harness, "computer_exec", {
      command: "grep -c chromium /home/box/.frockbot/bots/x/chromium.log",
    });

    expect(result.isError).toBe(false);
    expect(state.execs).toHaveLength(1);
  });

  test("says where the shared scratch is, and that it is not durable", async () => {
    const state = fixture(new FakeWorkspace());
    const harness = await mount(state.provider);
    const description = harness.root.tools
      .schemas({ turnType: "chat" })
      .find((schema) => schema.name === "computer_exec")?.description;

    expect(description).toContain("/workspace");
    expect(description).toContain("not durable");
    expect(description).toContain("never driven from the shell");
  });
});
