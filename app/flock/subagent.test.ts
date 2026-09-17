// `subagent`: what the tool asks for, and the two things it refuses.
//
// The tool half only. What one hand-off is actually admitted as — the lane,
// the origin, the run id — is the Bot Durable Object's half of the seam, and
// is proved in `app/shell/backend-flock.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  createSubagentTool,
  decodeSubagentInputV1,
  SUBAGENT_SPAWNS_PER_TURN_V1,
  SUBAGENT_TASK_MAX_V1,
  subagentHandoffAdmissionCeilingV1,
  type SubagentHandoffHostV1,
} from "./subagent.ts";

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-09-17T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

function host(options?: { handoffDepth?: number; fail?: string }): {
  seam: SubagentHandoffHostV1;
  asked: { task: string; effectId: string }[];
} {
  const asked: { task: string; effectId: string }[] = [];
  return {
    asked,
    seam: {
      handoffDepth: options?.handoffDepth ?? 0,
      spawn: async (request) => {
        if (options?.fail) throw new Error(options.fail);
        asked.push(request);
        // Admission is all that answers here: the Turn itself is queued behind
        // the Turn that asked for it and settles long after this tool did.
        return { runId: `handoff-${asked.length}`, status: "started" };
      },
    },
  };
}

describe("the subagent input", () => {
  test("takes a task and nothing else", () => {
    expect(decodeSubagentInputV1({ task: "  audit the invoices  " })).toEqual({
      task: "audit the invoices",
    });
    expect(() => decodeSubagentInputV1({ task: "" })).toThrow();
    expect(() => decodeSubagentInputV1({})).toThrow();
    expect(() => decodeSubagentInputV1({ task: "x", model: "big" })).toThrow();
    expect(() =>
      decodeSubagentInputV1({ task: "x".repeat(SUBAGENT_TASK_MAX_V1 + 1) }),
    ).toThrow();
  });
});

describe("a hand-off", () => {
  test("hands the task over and reports it started", async () => {
    const { seam, asked } = host();
    const result = await createSubagentTool(seam).execute!(
      { task: "reconcile last month" },
      CONTEXT,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content as string)).toEqual({
      runId: "handoff-1",
      status: "started",
    });
    // The occurrence travels with it: the run id is derived from it behind the
    // seam, so a replay asks for the Turn it already admitted.
    expect(asked).toEqual([
      { task: "reconcile last month", effectId: "tool:1:1:0" },
    ]);
  });

  test("is refused to a Turn that is already a hand-off", async () => {
    const { seam, asked } = host({ handoffDepth: 1 });
    const result = await createSubagentTool(seam).execute!(
      { task: "and again" },
      CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cannot hand off again");
    expect(asked).toHaveLength(0);
  });

  test("is refused past the per-Turn cap", async () => {
    const { seam, asked } = host();
    const tool = createSubagentTool(seam);
    for (let call = 0; call < SUBAGENT_SPAWNS_PER_TURN_V1; call += 1) {
      const allowed = await tool.execute!({ task: `task ${call}` }, CONTEXT);
      expect(allowed.isError).toBe(false);
    }
    const refused = await tool.execute!({ task: "one more" }, CONTEXT);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("limit");
    expect(asked).toHaveLength(SUBAGENT_SPAWNS_PER_TURN_V1);
  });

  test("does not spend a cap slot on a refusal", async () => {
    const { seam, asked } = host();
    const tool = createSubagentTool(seam);
    await tool.execute!({ task: "" }, CONTEXT);
    for (let call = 0; call < SUBAGENT_SPAWNS_PER_TURN_V1; call += 1) {
      expect(
        (await tool.execute!({ task: `task ${call}` }, CONTEXT)).isError,
      ).toBe(false);
    }
    expect(asked).toHaveLength(SUBAGENT_SPAWNS_PER_TURN_V1);
  });

  test("reports a refused admission rather than throwing", async () => {
    const { seam } = host({ fail: "bot has queued conversational work" });
    const result = await createSubagentTool(seam).execute!(
      { task: "go" },
      CONTEXT,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("queued conversational work");
  });

  test("is offered in the conversation and nowhere else", () => {
    // The manifest ceiling is the first of the two depth fences: the `agent`
    // Turn a hand-off runs as is never handed the tool at all.
    expect(subagentHandoffAdmissionCeilingV1()).toEqual(["chat"]);
  });
});
