// The machine tools: what they admit, what they refuse, and the one thing they
// never do — run anything.
import { describe, expect, test } from "bun:test";
import {
  SessionStore,
  type Session,
  type ToolCall,
  type ToolExecutionContext,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import type {
  MachineCommandResultV1,
  MachineListEntryV1,
  MachineListViewV1,
} from "@frockbot/machine-protocol";
import {
  createMachineRuntimePlugin,
  machineAdmissionCeilingV1,
  MACHINE_COMMAND_CHECK_TOOL_V1,
  MACHINE_CONTROL_CAPABILITY_V1,
  MACHINE_COPY_FROM_COMPUTER_TOOL_V1,
  MACHINE_COPY_TO_COMPUTER_TOOL_V1,
  MACHINE_EXEC_TOOL_V1,
  MACHINE_LIST_TOOL_V1,
  MACHINE_READ_TOOL_V1,
  MACHINE_REGISTRY_CAPABILITY_V1,
  type MachineRuntimeHostV1,
} from "./agent.js";
import {
  decodeMachineIntentRecordV1,
  machineIntentKeyV1,
  type MachineIntentRecordV1,
} from "./intent.js";
import type { MachineTargetViewV1 } from "./target.js";

const SESSION_ID = "user-1:bot-1";
const NOW = "2026-09-01T00:00:00.000Z";
const EFFECT_ID = "tool:4:2:0";
/** The approval id that effect maps to; a card id may carry no colon. */
const APPROVAL_ID = "tool.4.2.0";

function entry(
  overrides: Partial<MachineListEntryV1> = {},
): MachineListEntryV1 {
  return {
    machineId: "mac-1",
    label: "Tims-M5-MacBook-Pro.local",
    platform: "macos",
    capabilities: ["exec", "files"],
    connected: true,
    lastSeenAt: NOW,
    registeredAt: NOW,
    ...overrides,
  };
}

interface Harness {
  root: Context;
  session: Session;
  storage: Map<string, unknown>;
  target: MachineTargetViewV1;
  result?: MachineCommandResultV1;
  dispose(): Promise<void>;
}

async function mount(
  options: {
    target?: Partial<MachineTargetViewV1>;
    machines?: MachineListEntryV1[];
    result?: MachineCommandResultV1;
    writer?: boolean;
  } = {},
): Promise<Harness> {
  const root = new Context();
  await root.plugin(SessionStore);
  await root.plugin(ToolRegistry);
  const session = root.sessions.create(SESSION_ID);
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  const store = new Map<string, unknown>();
  const target: MachineTargetViewV1 = {
    schemaVersion: 1,
    machineId: "mac-1",
    entry: entry(),
    queuedCommands: 0,
    commandsToday: 0,
    serverTime: NOW,
    ...options.target,
  };
  const view: MachineListViewV1 = {
    schemaVersion: 1,
    machines: options.machines ?? [entry()],
    serverTime: NOW,
  };
  const host: MachineRuntimeHostV1 = {
    botId: "bot-1",
    ...(options.writer === false
      ? {}
      : {
          writer: {
            sessionId: SESSION_ID,
            turnId: "turn-4",
            runId: "run-1",
          },
        }),
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    list: async () => view,
    describeTarget: async () => target,
    readResult: async () => options.result,
  };
  await root.plugin(createMachineRuntimePlugin(host));
  return {
    root,
    session,
    storage: store,
    target,
    ...(options.result === undefined ? {} : { result: options.result }),
    dispose: () => root.fiber.dispose(),
  };
}

function contextFor(turnType: TurnTypeV1): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: SESSION_ID,
    compositionGenerationId: "2026-09-01T00:00:00.000Z:0123456789abcdef",
    turnType,
    effectId: EFFECT_ID,
    signal: new AbortController().signal,
  };
}

async function invoke(
  harness: Harness,
  name: string,
  input: unknown,
  turnType: TurnTypeV1 = "chat",
) {
  const call: ToolCall = { id: "call-1", name, input };
  const context = contextFor(turnType);
  const preparation = await harness.root.tools.prepare(call, context);
  if (preparation.kind === "denied") return preparation.result;
  return harness.root.tools.executePrepared(preparation, context);
}

const CONTROL_TOOLS = [
  MACHINE_EXEC_TOOL_V1,
  MACHINE_READ_TOOL_V1,
  MACHINE_COPY_TO_COMPUTER_TOOL_V1,
  MACHINE_COPY_FROM_COMPUTER_TOOL_V1,
];

describe("machine tool admission", () => {
  test("the registry tools are on every turn type and control is chat only", async () => {
    const harness = await mount();
    try {
      const names = (turnType: TurnTypeV1) =>
        harness.root.tools.schemas({ turnType }).map((tool) => tool.name);
      for (const turnType of ["chat", "automation", "subagent"] as const) {
        expect(names(turnType)).toContain(MACHINE_LIST_TOOL_V1);
        expect(names(turnType)).toContain(MACHINE_COMMAND_CHECK_TOOL_V1);
      }
      for (const tool of CONTROL_TOOLS) {
        expect(names("chat")).toContain(tool);
        // Row 49 ships `partial`: an automation Turn has no voice to ask an
        // approval with, so it does not get a tool that needs one.
        expect(names("automation")).not.toContain(tool);
        expect(names("subagent")).not.toContain(tool);
      }
    } finally {
      await harness.dispose();
    }
  });

  test("the ceiling is read out of the manifest, not restated", () => {
    expect(machineAdmissionCeilingV1(MACHINE_REGISTRY_CAPABILITY_V1)).toEqual([
      "chat",
      "automation",
      "subagent",
    ]);
    expect(machineAdmissionCeilingV1(MACHINE_CONTROL_CAPABILITY_V1)).toEqual([
      "chat",
    ]);
    expect(machineAdmissionCeilingV1("no-such-capability")).toBeUndefined();
  });

  test("a Turn with no writer gets the registry and nothing that reaches a laptop", async () => {
    const harness = await mount({ writer: false });
    try {
      const names = harness.root.tools
        .schemas({ turnType: "chat" })
        .map((tool) => tool.name);
      expect(names).toEqual([
        MACHINE_LIST_TOOL_V1,
        MACHINE_COMMAND_CHECK_TOOL_V1,
        "get_dynamic_tools",
        "call_dynamic_tool",
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

describe("machine_list", () => {
  test("projects the registry and says so when there is nothing to project", async () => {
    const listed = await mount();
    try {
      const result = await invoke(listed, MACHINE_LIST_TOOL_V1, {});
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual({
        machines: [
          {
            machineId: "mac-1",
            label: "Tims-M5-MacBook-Pro.local",
            platform: "macos",
            capabilities: ["exec", "files"],
            connected: true,
            lastSeenAt: NOW,
          },
        ],
      });
    } finally {
      await listed.dispose();
    }
    const empty = await mount({ machines: [] });
    try {
      const result = await invoke(empty, MACHINE_LIST_TOOL_V1, {});
      expect(result.content).toContain("No machines are registered");
      expect(result.isError).toBe(false);
    } finally {
      await empty.dispose();
    }
  });
});

describe("a control tool's approval", () => {
  test("records intent, asks, ends the Turn, and runs nothing", async () => {
    const harness = await mount();
    try {
      const result = await invoke(harness, MACHINE_EXEC_TOOL_V1, {
        machineId: "mac-1",
        command: "git status",
      });
      expect(result.isError).toBe(false);
      expect(result.endsTurn).toBe(true);
      expect(result.content).toContain("Nothing has been sent to the machine");

      // The intent is durable, and it is what the settlement will read back
      // from an approvalId that carries nothing but a decision.
      const intent = decodeMachineIntentRecordV1(
        harness.storage.get(machineIntentKeyV1(APPROVAL_ID)),
      );
      expect(intent).toMatchObject({
        approvalId: APPROVAL_ID,
        commandId: APPROVAL_ID,
        machineId: "mac-1",
        botId: "bot-1",
        runId: "run-1",
        turn: 4,
      });
      expect(intent.op).toEqual({
        kind: "exec",
        command: "git status",
        timeoutMs: 60_000,
        maxOutputBytes: 1_024 * 1_024,
      });
      expect(intent.decision).toBeUndefined();

      // The card is on the durable log, at the open step, as an approval.
      const sends = harness.session.events.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(1);
      const send = sends[0] as unknown as {
        turn: number;
        step: number;
        occurrenceId: string;
        payload: {
          type: string;
          approvalId: string;
          risk: string;
          action: string;
        };
      };
      expect(send.turn).toBe(4);
      expect(send.step).toBe(2);
      expect(send.occurrenceId).toBe(EFFECT_ID);
      expect(send.payload.type).toBe("approval");
      expect(send.payload.approvalId).toBe(APPROVAL_ID);
      expect(send.payload.risk).toBe("high");
      expect(send.payload.action).toContain("git status");
    } finally {
      await harness.dispose();
    }
  });

  test("each control tool builds its own op and each is one card", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        MACHINE_READ_TOOL_V1,
        { machineId: "mac-1", path: "/etc/hosts" },
        "read",
      ],
      [
        MACHINE_COPY_TO_COMPUTER_TOOL_V1,
        { machineId: "mac-1", path: "/a", workspacePath: "b" },
        "copy-to-computer",
      ],
      [
        MACHINE_COPY_FROM_COMPUTER_TOOL_V1,
        { machineId: "mac-1", path: "/a", workspacePath: "b" },
        "copy-from-computer",
      ],
    ];
    for (const [name, input, kind] of cases) {
      const harness = await mount();
      try {
        const result = await invoke(harness, name, input);
        expect(result.isError).toBe(false);
        expect(result.endsTurn).toBe(true);
        const intent = decodeMachineIntentRecordV1(
          harness.storage.get(machineIntentKeyV1(APPROVAL_ID)),
        );
        expect(intent.op.kind).toBe(kind as never);
      } finally {
        await harness.dispose();
      }
    }
  });
});

describe("a control tool's visible refusals", () => {
  const asked = { machineId: "mac-1", command: "git status" };

  async function refusalFor(
    options: Parameters<typeof mount>[0],
    input: Record<string, unknown> = asked,
  ): Promise<string> {
    const harness = await mount(options);
    try {
      const result = await invoke(harness, MACHINE_EXEC_TOOL_V1, input);
      expect(result.isError).toBe(true);
      expect(result.endsTurn).toBeUndefined();
      // Nothing was recorded and nobody was asked.
      expect(harness.storage.size).toBe(0);
      expect(
        harness.session.events.filter((event) => event.type === "send/to-user"),
      ).toHaveLength(0);
      return result.content;
    } finally {
      await harness.dispose();
    }
  }

  test("an unknown machine", async () => {
    expect(
      await refusalFor({ target: { entry: undefined } as never }),
    ).toContain('no machine "mac-1" is registered');
  });

  test("a revoked machine", async () => {
    expect(
      await refusalFor({ target: { entry: entry({ revokedAt: NOW }) } }),
    ).toContain("was revoked");
  });

  test("a machine that is not connected", async () => {
    expect(
      await refusalFor({ target: { entry: entry({ connected: false }) } }),
    ).toContain("is not connected");
  });

  test("a machine that does not report the capability the op needs", async () => {
    expect(
      await refusalFor({
        target: { entry: entry({ capabilities: ["files"] }) },
      }),
    ).toContain("does not report the exec capability");
  });

  test("a queue that is already full, and a day that is already spent", async () => {
    // Quotas refuse visibly, and the leading "Refused:" is what makes
    // `plugin-audit` classify the row `refused` rather than an effect that ran.
    const depth = await refusalFor({ target: { queuedCommands: 16 } });
    expect(depth).toStartWith("Refused:");
    expect(depth).toContain("commands waiting");
    const day = await refusalFor({ target: { commandsToday: 500 } });
    expect(day).toStartWith("Refused:");
    expect(day).toContain("machine commands today");
  });

  test("an input the protocol will not decode", async () => {
    expect(await refusalFor({}, { machineId: "mac-1" })).toContain("command");
    expect(await refusalFor({}, { command: "ls" })).toContain(
      "machineId must be a non-empty string",
    );
  });
});

describe("machine_command_check", () => {
  test("reads the whole result once there is one", async () => {
    const harness = await mount({
      result: {
        schemaVersion: 1,
        commandId: APPROVAL_ID,
        finishedAt: NOW,
        outcome: "ok",
        truncated: false,
        exitCode: 0,
        stdout: "nothing to commit\n",
      },
    });
    try {
      const result = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: APPROVAL_ID,
      });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("outcome: ok");
      expect(result.content).toContain("exitCode: 0");
      expect(result.content).toContain("nothing to commit");
    } finally {
      await harness.dispose();
    }
  });

  test("says where a command stands when it has no result yet", async () => {
    const harness = await mount();
    try {
      // Nothing asked for at all.
      const unknown = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: "cmd-none",
      });
      expect(unknown.content).toContain("was asked for by this bot");

      await invoke(harness, MACHINE_EXEC_TOOL_V1, {
        machineId: "mac-1",
        command: "git status",
      });
      const pending = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: APPROVAL_ID,
      });
      expect(pending.content).toContain("waiting on the user's approval");

      const key = machineIntentKeyV1(APPROVAL_ID);
      const intent = decodeMachineIntentRecordV1(harness.storage.get(key));
      const settled: MachineIntentRecordV1 = {
        ...intent,
        decision: "denied",
        decidedAt: NOW,
        outcome: "denied",
      };
      harness.storage.set(key, settled);
      const denied = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: APPROVAL_ID,
      });
      expect(denied.content).toContain("was denied by the user");

      harness.storage.set(key, {
        ...intent,
        decision: "approved",
        decidedAt: NOW,
        dispatchedAt: NOW,
        outcome: "dispatched",
      });
      const queued = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: APPROVAL_ID,
      });
      expect(queued.content).toContain("has not answered yet");

      // An approval-exempt read (row 57g's six Messages reads) is dispatched by
      // its own tool and carries no decision, so it must not read as "waiting
      // on the user" — nobody was asked.
      harness.storage.set(key, {
        ...intent,
        dispatchedAt: NOW,
        outcome: "dispatched",
      });
      const exempt = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: APPROVAL_ID,
      });
      expect(exempt.content).not.toContain("approval");
      expect(exempt.content).toContain("has not answered yet");
    } finally {
      await harness.dispose();
    }
  });

  test("refuses a commandId that is not one", async () => {
    const harness = await mount();
    try {
      const result = await invoke(harness, MACHINE_COMMAND_CHECK_TOOL_V1, {
        commandId: "",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith("Refused:");
    } finally {
      await harness.dispose();
    }
  });
});
