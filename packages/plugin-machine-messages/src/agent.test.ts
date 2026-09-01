// The seven Messages tools: what they refuse, what they queue, and the one of
// them that asks a person first.
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
  MachineCommandV1,
  MachineListEntryV1,
  MachineListViewV1,
  MachineMessagesPermissionsV1,
} from "@frockbot/machine-protocol";
import type { MachineRuntimeHostV1 } from "@frockbot/plugin-user-machine/agent";
import {
  decodeMachineIntentRecordV1,
  machineIntentKeyV1,
} from "@frockbot/plugin-user-machine/intent";
import type { MachineTargetViewV1 } from "@frockbot/plugin-user-machine/target";
import {
  MACHINE_MESSAGES_TOOL_NAMES_V1,
  MESSAGES_ACTIVITY_TOOL_V1,
  MESSAGES_CHECK_PERMISSIONS_TOOL_V1,
  MESSAGES_FIND_CHATS_TOOL_V1,
  MESSAGES_SEND_TOOL_V1,
  createMachineMessagesRuntimePlugin,
  machineMessagesAdmissionCeilingV1,
  machineMessagesTurnOfV1,
  type MachineMessagesRuntimeHostV1,
} from "./agent.js";

const SESSION_ID = "user-1:bot-1";
const NOW = "2026-09-01T00:00:00.000Z";
const EFFECT_ID = "tool:4:2:0";
const COMMAND_ID = "tool.4.2.0";

const granted: MachineMessagesPermissionsV1 = {
  schemaVersion: 1,
  fullDiskAccess: true,
  automation: true,
  checkedAt: NOW,
};

function entry(
  overrides: Partial<MachineListEntryV1> = {},
): MachineListEntryV1 {
  return {
    machineId: "mac-1",
    label: "Tims-M5-MacBook-Pro.local",
    platform: "macos",
    capabilities: ["exec", "files", "messages"],
    connected: true,
    lastSeenAt: NOW,
    registeredAt: NOW,
    messagesPermissions: granted,
    ...overrides,
  };
}

interface Harness {
  root: Context;
  session: Session;
  storage: Map<string, unknown>;
  dispatched: MachineCommandV1[];
  dispose(): Promise<void>;
}

async function mount(
  options: { entry?: MachineListEntryV1 | undefined; refuse?: string } = {},
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
  const resolved = "entry" in options ? options.entry : entry();
  const target: MachineTargetViewV1 = {
    schemaVersion: 1,
    machineId: "mac-1",
    ...(resolved === undefined ? {} : { entry: resolved }),
    queuedCommands: 0,
    commandsToday: 0,
    serverTime: NOW,
  };
  const view: MachineListViewV1 = {
    schemaVersion: 1,
    machines: resolved ? [resolved] : [],
    serverTime: NOW,
  };
  const machines: MachineRuntimeHostV1 & {
    writer: { sessionId: string; turnId: string; runId: string };
  } = {
    botId: "bot-1",
    writer: { sessionId: SESSION_ID, turnId: "turn-4", runId: "run-1" },
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    list: async () => view,
    describeTarget: async () => target,
    readResult: async () => undefined,
  };
  const dispatched: MachineCommandV1[] = [];
  const host: MachineMessagesRuntimeHostV1 = {
    machines,
    now: () => NOW,
    dispatch: async (command) => {
      if (options.refuse) {
        return { status: "refused", reason: options.refuse };
      }
      dispatched.push(command);
      return { status: "queued", command };
    },
  };
  await root.plugin(createMachineMessagesRuntimePlugin(host));
  return {
    root,
    session,
    storage: store,
    dispatched,
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

describe("admission", () => {
  test("all seven tools are chat-only, and the ceiling is the manifest's", async () => {
    const harness = await mount();
    try {
      const names = (turnType: TurnTypeV1) =>
        harness.root.tools.schemas({ turnType }).map((tool) => tool.name);
      for (const tool of MACHINE_MESSAGES_TOOL_NAMES_V1) {
        expect(names("chat")).toContain(tool);
        for (const turnType of ["automation", "subagent", "channel"] as const) {
          expect(names(turnType)).not.toContain(tool);
        }
      }
      expect(machineMessagesAdmissionCeilingV1()).toEqual(["chat"]);
    } finally {
      await harness.dispose();
    }
  });

  test("the Turn an effect belongs to is read off its own id", () => {
    expect(machineMessagesTurnOfV1("tool:4:2:0")).toBe(4);
    expect(machineMessagesTurnOfV1("nonsense")).toBe(0);
  });
});

describe("the permission gate", () => {
  test("a machine that never reported permissions refuses every read but the check", async () => {
    const harness = await mount({
      entry: entry({ messagesPermissions: undefined }),
    });
    try {
      const refused = await invoke(harness, MESSAGES_ACTIVITY_TOOL_V1, {
        machineId: "mac-1",
      });
      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("Refused:");
      expect(String(refused.content)).toContain(
        MESSAGES_CHECK_PERMISSIONS_TOOL_V1,
      );
      // Nothing was queued: the refusal happens before the effect, not after.
      expect(harness.dispatched).toEqual([]);
      // The check itself is how a machine stops being unknown, so it runs.
      const checked = await invoke(
        harness,
        MESSAGES_CHECK_PERMISSIONS_TOOL_V1,
        { machineId: "mac-1" },
      );
      expect(checked.isError).toBe(false);
      expect(harness.dispatched).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  test("denied Full Disk Access refuses with the remediation, and queues nothing", async () => {
    const harness = await mount({
      entry: entry({
        messagesPermissions: { ...granted, fullDiskAccess: false },
      }),
    });
    try {
      const result = await invoke(harness, MESSAGES_FIND_CHATS_TOOL_V1, {
        machineId: "mac-1",
      });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("Full Disk Access");
      expect(String(result.content)).toContain("System Settings");
      expect(harness.dispatched).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test("a read runs without Automation; only the send needs it", async () => {
    const harness = await mount({
      entry: entry({ messagesPermissions: { ...granted, automation: false } }),
    });
    try {
      expect(
        (
          await invoke(harness, MESSAGES_ACTIVITY_TOOL_V1, {
            machineId: "mac-1",
          })
        ).isError,
      ).toBe(false);
      const send = await invoke(harness, MESSAGES_SEND_TOOL_V1, {
        machineId: "mac-1",
        to: "+61400000000",
        text: "hi",
      });
      expect(send.isError).toBe(true);
      expect(String(send.content)).toContain("Automation");
    } finally {
      await harness.dispose();
    }
  });
});

describe("the machine gate, at the tool boundary", () => {
  test("unknown, offline and capability-less machines refuse visibly", async () => {
    for (const [options, expected] of [
      [{ entry: undefined }, "no machine"],
      [{ entry: entry({ connected: false }) }, "not connected"],
      [
        { entry: entry({ capabilities: ["exec", "files"] }) },
        "does not report the messages capability",
      ],
      [{ entry: entry({ revokedAt: NOW }) }, "was revoked"],
    ] as const) {
      const harness = await mount(options as { entry?: MachineListEntryV1 });
      try {
        const result = await invoke(harness, MESSAGES_ACTIVITY_TOOL_V1, {
          machineId: "mac-1",
        });
        expect(result.isError).toBe(true);
        expect(String(result.content)).toContain(expected);
        expect(harness.dispatched).toEqual([]);
      } finally {
        await harness.dispose();
      }
    }
  });
});

describe("a read", () => {
  test("records intent, queues one messages command, and ends no Turn", async () => {
    const harness = await mount();
    try {
      const result = await invoke(harness, MESSAGES_FIND_CHATS_TOOL_V1, {
        machineId: "mac-1",
        query: "mum",
        limit: 5,
      });
      expect(result.isError).toBe(false);
      // A read is exempt from the card, so it must not end the Turn: the model
      // says what it asked for and carries on.
      expect(result.endsTurn).toBeUndefined();
      expect(String(result.content)).toContain(COMMAND_ID);
      expect(harness.dispatched).toHaveLength(1);
      const command = harness.dispatched[0]!;
      expect(command.commandId).toBe(COMMAND_ID);
      expect(command.op).toEqual({
        kind: "messages",
        call: { kind: "find-chats", query: "mum", limit: 5 },
      });
      // Intent before the effect, and it is the record `machine_command_check`
      // reads back: dispatched, with no decision, because nobody was asked.
      const intent = decodeMachineIntentRecordV1(
        harness.storage.get(machineIntentKeyV1(COMMAND_ID)),
      );
      expect(intent.decision).toBeUndefined();
      expect(intent.outcome).toBe("dispatched");
      expect(intent.turn).toBe(4);
      // Nothing was put on the session log: a read shows the user no card.
      expect(
        harness.session.events.filter((event) => event.type === "send/to-user"),
      ).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  test("a queue that refuses is a visible refusal, and the intent says so", async () => {
    const harness = await mount({ refuse: "Refused: over quota." });
    try {
      const result = await invoke(harness, MESSAGES_ACTIVITY_TOOL_V1, {
        machineId: "mac-1",
      });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("over quota");
      expect(
        decodeMachineIntentRecordV1(
          harness.storage.get(machineIntentKeyV1(COMMAND_ID)),
        ).outcome,
      ).toBe("refused");
    } finally {
      await harness.dispose();
    }
  });
});

describe("the send", () => {
  test("asks for approval on the landed path, ends the Turn, and queues nothing", async () => {
    const harness = await mount();
    try {
      const result = await invoke(harness, MESSAGES_SEND_TOOL_V1, {
        machineId: "mac-1",
        to: "+61400000000",
        text: 'tell them "yes"',
      });
      expect(result.isError).toBe(false);
      expect(result.endsTurn).toBe(true);
      // Nothing reached the queue: the settlement dispatches, not the tool.
      expect(harness.dispatched).toEqual([]);
      const sends = harness.session.events.filter(
        (event) => event.type === "send/to-user",
      );
      expect(sends).toHaveLength(1);
      const payload = (sends[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload.type).toBe("approval");
      expect(payload.approvalId).toBe(COMMAND_ID);
      expect(payload.risk).toBe("high");
      // The card carries the exact text: approving a message you have not read
      // is not approving anything.
      expect(String(payload.action)).toContain('tell them "yes"');
      expect(String(payload.action)).toContain("+61400000000");
      const intent = decodeMachineIntentRecordV1(
        harness.storage.get(machineIntentKeyV1(COMMAND_ID)),
      );
      expect(intent.decision).toBeUndefined();
      expect(intent.outcome).toBeUndefined();
      expect(intent.op).toEqual({
        kind: "messages",
        call: { kind: "send", to: "+61400000000", text: 'tell them "yes"' },
      });
    } finally {
      await harness.dispose();
    }
  });
});
