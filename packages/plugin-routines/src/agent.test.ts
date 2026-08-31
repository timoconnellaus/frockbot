import { describe, expect, test } from "bun:test";
import {
  createRoutineManageTool,
  routineManageCommandV1,
  routineToolCommandIdV1,
  type RoutinesRuntimeHostV1,
} from "./agent.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";

const WRITER = {
  sessionId: "tim:scout",
  turnId: "turn-4",
  runId: "run-9",
};

const CONTEXT = {
  botId: "scout",
  agentId: "scout",
  sessionId: "tim:scout",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

function host(): RoutinesRuntimeHostV1 & { store: RoutineStore } {
  const store = new RoutineStore(createMemoryRoutineStorageV1(), {
    defaultTimezone: "Australia/Sydney",
  });
  return {
    botId: "scout",
    writer: WRITER,
    store,
    list: () => store.list("scout"),
    execute: (command, writer) => store.execute(command, writer),
  };
}

describe("routine_manage", () => {
  test("creates a Routine through the same command path the client uses", async () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
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
    const listed = await seam.list();
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({
      name: "Morning brief",
      schedule: "@daily",
      timezone: "Australia/Sydney",
      createdBy: { kind: "bot", botId: "scout" },
    });
  });

  test("records the Session and Turn of the writing Bot", async () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
    await tool.execute(
      {
        action: "create",
        routineId: "brief",
        name: "Brief",
        prompt: "Do it",
        trigger: "webhook",
      },
      CONTEXT,
    );
    const record = await seam.store.read("brief");
    expect(record?.createdBy).toEqual({
      kind: "bot",
      botId: "scout",
      sessionId: "tim:scout",
      turnId: "turn-4",
    });
    expect(record?.trigger).toEqual({ kind: "webhook" });
  });

  test("a repeated call under one effect identifier writes once", async () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
    const input = {
      action: "create",
      name: "Brief",
      prompt: "Do it",
      schedule: "@daily",
    };
    await tool.execute(input, CONTEXT);
    await tool.execute(input, CONTEXT);
    expect((await seam.list()).routines).toHaveLength(1);
  });

  test("pause, resume and delete reach the record", async () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
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
    await tool.execute(
      { action: "pause", routineId: "brief" },
      {
        ...CONTEXT,
        effectId: "tool:1:2:0",
      },
    );
    expect((await seam.store.read("brief"))?.enabled).toBe(false);
    await tool.execute(
      { action: "resume", routineId: "brief" },
      {
        ...CONTEXT,
        effectId: "tool:1:3:0",
      },
    );
    expect((await seam.store.read("brief"))?.enabled).toBe(true);
    const deleted = await tool.execute(
      { action: "delete", routineId: "brief" },
      { ...CONTEXT, effectId: "tool:1:4:0" },
    );
    expect(deleted.content).toContain("Deleted Routine brief");
    expect(await seam.store.read("brief")).toBeUndefined();
  });

  test("a bad cron and a missing id are observable refusals, not throws", async () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
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
  });

  test("declares no admission of its own, so its Capability's ceiling decides", () => {
    const seam = host();
    expect(
      createRoutineManageTool({ ...seam, writer: WRITER }).admission,
    ).toBeUndefined();
  });

  test("refuses unknown input fields and an unknown action", () => {
    const seam = host();
    const tool = createRoutineManageTool({ ...seam, writer: WRITER });
    expect(tool.validate?.({ action: "backfill", routineId: "brief" })).toBe(
      false,
    );
    expect(tool.validate?.({ action: "pause", secret: "x" })).toBe(false);
    expect(tool.validate?.({ action: "pause", routineId: "brief" })).toBe(true);
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
});

describe("routineToolCommandIdV1", () => {
  test("derives a stable identifier from the Turn's effect identifier", () => {
    expect(routineToolCommandIdV1("tool:1:1:0")).toBe("rt-tool-1-1-0");
    expect(routineToolCommandIdV1("tool:1:1:0")).toBe(
      routineToolCommandIdV1("tool:1:1:0"),
    );
  });
});
