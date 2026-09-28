import { describe, expect, test } from "bun:test";
import type {
  Session,
  SessionEvent,
  ToolExecutionContext,
} from "@frockbot/core/contracts";
import {
  createRoutineManageTool,
  routineChangeNeedsApprovalV1,
  routineManageCommandV1,
  routineToolCommandIdV1,
  type RoutineApprovalRuntimeV1,
  type RoutinesRuntimeHostV1,
} from "./agent.js";
import { routinePromptByV1 } from "./records.js";
import type { RoutineCommandV1 } from "./shared.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";

const WRITER = {
  sessionId: "tim:scout",
  turnId: "turn-4",
  runId: "run-9",
};

const CONTEXT: ToolExecutionContext = {
  botId: "scout",
  agentId: "scout",
  sessionId: "tim:scout",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

const ZONE = "Australia/Sydney";

/**
 * The seam as the Bot Durable Object gives it, with the approval half kept in
 * memory: an intent per occurrence, and `approve` doing what the settlement
 * does — applying exactly the recorded command with the Approval on it.
 */
function host(): RoutinesRuntimeHostV1 & {
  store: RoutineStore;
  intents: Map<string, RoutineCommandV1>;
  approve(approvalId: string): Promise<void>;
} {
  const store = new RoutineStore(createMemoryRoutineStorageV1());
  const intents = new Map<string, RoutineCommandV1>();
  return {
    botId: "scout",
    writer: WRITER,
    store,
    intents,
    list: () => store.list("scout", undefined, ZONE),
    execute: (command, writer) => store.execute(command, writer, ZONE),
    askApproval: async ({ command, effectId }) => {
      const approvalId = `routine-approval-${effectId.replace(/[^a-z0-9]/gi, "")}`;
      if (!intents.has(approvalId)) intents.set(approvalId, command);
      return { approvalId };
    },
    async approve(approvalId) {
      const command = intents.get(approvalId);
      if (!command) throw new Error(`no intent ${approvalId}`);
      await store.execute(
        command,
        {
          kind: "bot",
          botId: "scout",
          sessionId: "tim:scout",
          turnId: "turn-4",
        },
        ZONE,
        { approvalId },
      );
    },
  };
}

/** A Turn's log with one open step, where the approval card is recorded. */
function turnLog(): RoutineApprovalRuntimeV1 & { events: SessionEvent[] } {
  const events: SessionEvent[] = [
    { type: "step/start", turn: 1, step: 1 } as unknown as SessionEvent,
  ];
  const session = {
    id: "tim:scout",
    get activeRunJournal() {
      return events;
    },
    append(event: SessionEvent) {
      events.push(event);
    },
    async flush() {},
  } as unknown as Session;
  return {
    events,
    sessions: {
      get: (id: string) => (id === session.id ? session : undefined),
    } as unknown as RoutineApprovalRuntimeV1["sessions"],
  };
}

function approvalsOn(events: readonly SessionEvent[]) {
  return events.flatMap((event) =>
    event.type === "send/to-user" && event.payload.type === "approval"
      ? [event.payload]
      : [],
  );
}

describe("routine_manage", () => {
  test("creating a Routine asks the person on a card, and arms nothing until they approve", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    const result = await tool.execute(
      {
        action: "create",
        name: "Morning brief",
        prompt: "Summarize overnight email.",
        schedule: "@daily",
      },
      CONTEXT,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Nothing is armed");
    expect((await seam.list()).routines).toHaveLength(0);
    const [card] = approvalsOn(log.events);
    expect(card?.approvalId).toMatch(/^routine-approval-/);
    expect(card?.action).toContain('Set up the Routine "Morning brief"');
    expect(card?.rationale).toContain("Summarize overnight email.");

    await seam.approve(card!.approvalId);
    const listed = await seam.list();
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({
      name: "Morning brief",
      schedule: "@daily",
      timezone: "Australia/Sydney",
      createdBy: { kind: "bot", botId: "scout" },
    });
    // Approved, its prompt is the person's standing request.
    const record = await seam.store.read(listed.routines[0]!.routineId);
    expect(record?.promptApprovalId).toBe(card!.approvalId);
    expect(routinePromptByV1(record!)).toBe("user");
  });

  test("the model cannot vouch for itself: there is no userAsked to set", () => {
    const tool = createRoutineManageTool({ ...host(), writer: WRITER });
    expect(
      tool.validate?.({
        action: "pause",
        routineId: "theirs",
        userAsked: true,
      }),
    ).toBe(false);
    expect(JSON.stringify(tool.inputSchema)).not.toContain("userAsked");
  });

  test("a repeated call under one effect identifier asks once", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    const input = {
      action: "create",
      name: "Brief",
      prompt: "Do it",
      schedule: "@daily",
    };
    await tool.execute(input, CONTEXT);
    await tool.execute(input, CONTEXT);
    expect(approvalsOn(log.events)).toHaveLength(1);
    expect(seam.intents.size).toBe(1);
  });

  test("the Bot's housekeeping of a Routine it set up needs no card, and keeps it the person's", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    await tool.execute(
      {
        action: "create",
        routineId: "brief",
        name: "Brief",
        prompt: "Do it",
        schedule: "@daily",
      },
      CONTEXT,
    );
    await seam.approve(approvalsOn(log.events)[0]!.approvalId);
    await tool.execute(
      { action: "pause", routineId: "brief" },
      { ...CONTEXT, effectId: "tool:1:2:0" },
    );
    expect((await seam.store.read("brief"))?.enabled).toBe(false);
    await tool.execute(
      { action: "resume", routineId: "brief" },
      { ...CONTEXT, effectId: "tool:1:3:0" },
    );
    const resumed = await seam.store.read("brief");
    expect(resumed?.enabled).toBe(true);
    // Pausing and resuming did not change whose words the prompt is.
    expect(routinePromptByV1(resumed!)).toBe("user");
    await tool.execute(
      { action: "update", routineId: "brief", name: "Morning brief" },
      { ...CONTEXT, effectId: "tool:1:4:0" },
    );
    expect((await seam.store.read("brief"))?.name).toBe("Morning brief");
    const deleted = await tool.execute(
      { action: "delete", routineId: "brief" },
      { ...CONTEXT, effectId: "tool:1:5:0" },
    );
    expect(deleted.content).toContain("Deleted Routine brief");
    expect(await seam.store.read("brief")).toBeUndefined();
    expect(approvalsOn(log.events)).toHaveLength(1);
  });

  test("changing what a Routine asks, or when it runs, needs a new card bound to the change", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    await tool.execute(
      {
        action: "create",
        routineId: "brief",
        name: "Brief",
        prompt: "Do it",
        schedule: "@daily",
      },
      CONTEXT,
    );
    const first = approvalsOn(log.events)[0]!.approvalId;
    await seam.approve(first);
    const asked = await tool.execute(
      { action: "update", routineId: "brief", prompt: "Do it twice" },
      { ...CONTEXT, effectId: "tool:1:2:0" },
    );
    expect(asked.content).toContain("Nothing is armed or changed");
    expect((await seam.store.read("brief"))?.prompt).toBe("Do it");
    const second = approvalsOn(log.events)[1]!;
    expect(second.approvalId).not.toBe(first);
    expect(second.rationale).toContain("Do it twice");
    await seam.approve(second.approvalId);
    const changed = await seam.store.read("brief");
    expect(changed?.prompt).toBe("Do it twice");
    expect(changed?.promptApprovalId).toBe(second.approvalId);
  });

  test("a bad cron, a missing id and a Routine that is not there are refused before anybody is asked", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    const badCron = await tool.execute(
      {
        action: "create",
        name: "Brief",
        prompt: "Do it",
        schedule: "not a cron",
      },
      CONTEXT,
    );
    expect(badCron).toMatchObject({ isError: true });
    expect(badCron.content).toContain("five fields");
    const missingId = await tool.execute(
      { action: "pause" },
      { ...CONTEXT, effectId: "tool:1:2:0" },
    );
    expect(missingId).toMatchObject({ isError: true });
    expect(missingId.content).toContain("needs a routineId");
    const gone = await tool.execute(
      { action: "update", routineId: "gone", prompt: "Anything" },
      { ...CONTEXT, effectId: "tool:1:3:0" },
    );
    expect(gone).toMatchObject({ isError: true });
    expect(approvalsOn(log.events)).toHaveLength(0);
  });

  test("a subagent, which cannot ask, hands the change back", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    const result = await tool.execute(
      { action: "create", name: "Brief", prompt: "Do it", schedule: "@daily" },
      { ...CONTEXT, turnType: "subagent" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Hand it back");
    expect(seam.intents.size).toBe(0);
  });

  test("names no turn types of its own, so its Capability's ceiling decides", () => {
    const seam = host();
    const admission = createRoutineManageTool({
      ...seam,
      writer: WRITER,
    }).admission;
    expect(admission?.turnTypes).toBeUndefined();
    // It does narrow the second dimension: managing Routines is a general work
    // tool, so only an `executor` subagent is offered it.
    expect(admission?.subagentRoles).toEqual(["executor"]);
  });

  test("refuses unknown input fields and an unknown action", () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
    expect(tool.validate?.({ action: "backfill", routineId: "brief" })).toBe(
      false,
    );
    expect(tool.validate?.({ action: "pause", secret: "x" })).toBe(false);
    expect(
      tool.validate?.({
        action: "create",
        name: "Brief",
        prompt: "Do it",
        schedule: "@daily",
        timezone: "Australia/Sydney",
      }),
    ).toBe(false);
    expect(tool.validate?.({ action: "pause", routineId: "brief" })).toBe(true);
  });
});

// A Bot paused a User's Routine in a Turn about avatar farming: no approval, no
// confirmation, nothing in the transcript. A Routine the User made is theirs.
describe("a Routine the User created", () => {
  async function seeded() {
    const seam = host();
    await seam.store.execute(
      {
        schemaVersion: 1,
        type: "routine/create",
        commandId: "cmd-user",
        botId: "scout",
        routineId: "theirs",
        name: "Minute ping",
        prompt: "Say ping.",
        schedule: "@every 1m",
      },
      { kind: "user" },
      ZONE,
    );
    return seam;
  }

  for (const action of ["pause", "delete", "update"] as const) {
    test(`${action} waits on the person's card`, async () => {
      const seam = await seeded();
      const log = turnLog();
      const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);

      const result = await tool.execute(
        {
          action,
          routineId: "theirs",
          ...(action === "update" ? { prompt: "Say pong." } : {}),
        },
        CONTEXT,
      );

      expect(result.isError).toBe(false);
      expect(approvalsOn(log.events)).toHaveLength(1);
      const listed = await seam.list();
      expect(listed.routines[0]).toMatchObject({
        enabled: true,
        prompt: "Say ping.",
        createdBy: { kind: "user" },
      });
    });
  }

  test("pauses it once the person approves the card, and it stays theirs", async () => {
    const seam = await seeded();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    await tool.execute({ action: "pause", routineId: "theirs" }, CONTEXT);
    await seam.approve(approvalsOn(log.events)[0]!.approvalId);
    const paused = await seam.store.read("theirs");
    expect(paused?.enabled).toBe(false);
    expect(routinePromptByV1(paused!)).toBe("user");
  });

  test("says which changes put a card in front of the User", () => {
    const tool = createRoutineManageTool({ ...host(), writer: WRITER });
    expect(tool.description).toContain("approval card");
    expect(tool.description).toContain("do not switch it off yourself");
  });
});

describe("routineChangeNeedsApprovalV1", () => {
  const meta = { schemaVersion: 1 as const, commandId: "c", botId: "scout" };
  test("a create, and a change of prompt or timing, always need the card", () => {
    expect(
      routineChangeNeedsApprovalV1(
        {
          ...meta,
          type: "routine/create",
          name: "A",
          prompt: "B",
          schedule: "@daily",
        },
        undefined,
      ),
    ).toBe(true);
    for (const change of [
      { prompt: "B" },
      { schedule: "@hourly" },
      { trigger: { kind: "webhook" as const } },
    ]) {
      expect(
        routineChangeNeedsApprovalV1(
          { ...meta, type: "routine/update", routineId: "r", ...change },
          {
            createdBy: {
              kind: "bot",
              botId: "scout",
              sessionId: "s",
              turnId: "t",
            },
          },
        ),
      ).toBe(true);
    }
  });

  test("pausing or deleting needs the card only for the person's own, or when nobody can tell", () => {
    const bot = {
      createdBy: {
        kind: "bot" as const,
        botId: "scout",
        sessionId: "s",
        turnId: "t",
      },
    };
    const user = { createdBy: { kind: "user" as const } };
    for (const type of ["routine/pause", "routine/delete"] as const) {
      const command = { ...meta, type, routineId: "r" };
      expect(routineChangeNeedsApprovalV1(command, bot)).toBe(false);
      expect(routineChangeNeedsApprovalV1(command, user)).toBe(true);
      expect(routineChangeNeedsApprovalV1(command, null)).toBe(true);
    }
    expect(
      routineChangeNeedsApprovalV1(
        { ...meta, type: "routine/resume", routineId: "r" },
        user,
      ),
    ).toBe(false);
  });
});

describe("routineManageCommandV1", () => {
  test("maps a webhook trigger to the record's trigger shape", () => {
    expect(
      routineManageCommandV1(
        {
          action: "create",
          name: "Brief",
          prompt: "Do it",
          trigger: "webhook",
        },
        { botId: "scout", commandId: "cmd-1" },
      ),
    ).toMatchObject({ type: "routine/create", trigger: { kind: "webhook" } });
  });

  test("maps a connected-app trigger exclusive with schedule, webhook and plugin", () => {
    expect(
      routineManageCommandV1(
        {
          action: "create",
          name: "Inbox",
          prompt: "Read it",
          connectionTrigger: {
            connectionId: "conn-gmail",
            triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
          },
        },
        { botId: "scout", commandId: "cmd-4" },
      ),
    ).toMatchObject({
      type: "routine/create",
      trigger: {
        kind: "connection",
        connectionId: "conn-gmail",
        triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      },
    });
  });

  test("refuses connectionTrigger.config keys other than query", async () => {
    const seam = host();
    const log = turnLog();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER }, log);
    const refused = await tool.execute(
      {
        action: "create",
        name: "Inbox",
        prompt: "Read shipping mail.",
        connectionTrigger: {
          connectionId: "conn-gmail",
          triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
          config: { labelIds: "INBOX", userId: "someone", interval: 15 },
        },
      },
      CONTEXT,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/unknown field/);
    const accepted = await tool.execute(
      {
        action: "create",
        name: "Inbox",
        prompt: "Read shipping mail.",
        connectionTrigger: {
          connectionId: "conn-gmail",
          triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
          config: { query: "from:stripe.com" },
        },
      },
      CONTEXT,
    );
    expect(accepted.isError).toBe(false);
    await seam.approve(approvalsOn(log.events)[0]!.approvalId);
    const listed = await seam.list();
    expect(listed.routines[0]?.trigger).toEqual({
      kind: "connection",
      connectionId: "conn-gmail",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      config: { query: "from:stripe.com" },
    });
  });

  test("refuses a webhook and a connected-app trigger on the same call", async () => {
    const tool = createRoutineManageTool({ ...host(), writer: WRITER });
    const result = await tool.execute(
      {
        action: "create",
        name: "Inbox",
        prompt: "Read it",
        trigger: "webhook",
        connectionTrigger: {
          connectionId: "conn-gmail",
          triggerType: "GMAIL_EMAIL_SENT",
        },
      },
      CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("one of");
  });

  test("list_triggers names the connected-app events a Routine may fire on", async () => {
    const seam = host();
    const tool = createRoutineManageTool({
      ...seam,
      writer: WRITER,
      listTriggers: () =>
        Promise.resolve([
          {
            connectionId: "conn-gmail",
            connectionLabel: "Gmail",
            toolkitName: "Gmail",
            slug: "GMAIL_NEW_GMAIL_MESSAGE",
            name: "New Gmail message received",
            description: "When a new message arrives.",
          },
          {
            connectionId: "conn-gmail",
            connectionLabel: "Gmail",
            toolkitName: "Gmail",
            slug: "GMAIL_EMAIL_SENT",
            name: "Email sent",
            description: "When a message is sent.",
          },
        ]),
    });
    const listed = await tool.execute({ action: "list_triggers" }, CONTEXT);
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("GMAIL_NEW_GMAIL_MESSAGE");
    expect(listed.content).toContain("GMAIL_EMAIL_SENT");
    expect(listed.content).toContain("connectionTrigger");
  });

  test("maps a Plugin trigger to the Plugin's id and trigger, exclusive with the webhook", () => {
    expect(
      routineManageCommandV1(
        {
          action: "create",
          name: "Alerts",
          prompt: "Read it",
          pluginTrigger: { pluginId: "weather", trigger: "alert" },
        },
        { botId: "scout", commandId: "cmd-2" },
      ),
    ).toMatchObject({
      type: "routine/create",
      trigger: { kind: "plugin", pluginId: "weather", trigger: "alert" },
    });
    expect(
      routineManageCommandV1(
        {
          action: "update",
          routineId: "alerts",
          pluginTrigger: { pluginId: "weather", trigger: "alert" },
        },
        { botId: "scout", commandId: "cmd-3" },
      ),
    ).toMatchObject({
      type: "routine/update",
      trigger: { kind: "plugin", pluginId: "weather", trigger: "alert" },
    });
  });
});

describe("routineToolCommandIdV1", () => {
  test("derives a stable identifier from the Turn's run and effect", async () => {
    const id = await routineToolCommandIdV1("run-9", "tool:1:1:0");
    expect(id).toMatch(/^rt-[0-9a-f]{32}$/);
    expect(await routineToolCommandIdV1("run-9", "tool:1:1:0")).toBe(id);
  });

  test("derives another identifier for the same effect in another run", async () => {
    // Effect ids restart in every Session: a Routine Turn's first call is
    // `tool:1:1:0` exactly as the conversation's first call was.
    expect(await routineToolCommandIdV1("run-chat", "tool:1:1:0")).not.toBe(
      await routineToolCommandIdV1("run-routine", "tool:1:1:0"),
    );
  });

  test("a create in another run with the same effect writes another Routine", async () => {
    const seam = host();
    const input = {
      action: "create" as const,
      name: "Morning brief",
      prompt: "Summarize overnight email.",
      schedule: "@daily",
    };
    const writer = { kind: "user" as const };
    for (const runId of ["run-chat", "run-routine"]) {
      await seam.store.execute(
        routineManageCommandV1(input, {
          botId: "scout",
          commandId: await routineToolCommandIdV1(runId, "tool:1:1:0"),
        }),
        writer,
        ZONE,
      );
    }
    expect((await seam.list()).routines).toHaveLength(2);
  });
});

describe("whose words a Routine's prompt is", () => {
  const meta = { schemaVersion: 1 as const, botId: "scout" };
  const bot = {
    kind: "bot" as const,
    botId: "scout",
    sessionId: "tim:scout",
    turnId: "turn-4",
  };

  test("a Bot's prompt without an Approval asks nothing, however often the person toggles it", async () => {
    const seam = host();
    await seam.store.execute(
      {
        ...meta,
        commandId: "c1",
        type: "routine/create",
        routineId: "r",
        name: "R",
        prompt: "Do it",
        schedule: "@daily",
      },
      bot,
      ZONE,
    );
    await seam.store.execute(
      { ...meta, commandId: "c2", type: "routine/pause", routineId: "r" },
      { kind: "user" },
      ZONE,
    );
    await seam.store.execute(
      { ...meta, commandId: "c3", type: "routine/resume", routineId: "r" },
      { kind: "user" },
      ZONE,
    );
    expect(routinePromptByV1((await seam.store.read("r"))!)).toBe("bot");
  });

  test("a Bot's later prompt without an Approval takes the person's authority away", async () => {
    const seam = host();
    await seam.store.execute(
      {
        ...meta,
        commandId: "c1",
        type: "routine/create",
        routineId: "r",
        name: "R",
        prompt: "Do it",
        schedule: "@daily",
      },
      bot,
      ZONE,
      { approvalId: "routine-approval-1" },
    );
    expect(routinePromptByV1((await seam.store.read("r"))!)).toBe("user");
    await seam.store.execute(
      {
        ...meta,
        commandId: "c2",
        type: "routine/update",
        routineId: "r",
        prompt: "Do something else",
      },
      bot,
      ZONE,
    );
    const record = await seam.store.read("r");
    expect(record?.promptApprovalId).toBeUndefined();
    expect(routinePromptByV1(record!)).toBe("bot");
  });
});
