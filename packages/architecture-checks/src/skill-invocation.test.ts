// Invocation, end to end through the Agent loop.
//
// GrokBot's users invoke a Skill with `/` or `@`
// (`docs/research/grokbot-computer.md` §2.8, register row 22). Invoking is not
// mentioning: an invoked Skill's body is expanded into the Turn's first step,
// while every other Skill stays a catalog line the Bot may read on demand.
// This proves both halves against a fake provider, and proves the third: an
// unknown ref fails the command visibly instead of being dropped.
import { describe, expect, test } from "bun:test";
import { AgentLoop } from "@frockbot/kernel-agent-loop";
import { AgentRegistry } from "@frockbot/kernel-agent-loop/agent";
import {
  SessionStore,
  type LlmProvider,
  type NormalizedModelRequest,
  type SkillRefV1,
} from "@frockbot/kernel-contracts";
import {
  botInstructionRootV1,
  createSkillsRuntimePlugin,
} from "@frockbot/plugin-skills";
import { FakeWorkspace, skillMarkdown } from "@frockbot/plugin-skills/testing";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context, type Plugin } from "cordis";

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

const OWNER = { userId: "user-1", botId: "bot-1" };
const WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  turnId: "turn-1",
  runId: "run-1",
};

async function turnWith(skills?: SkillRefV1[]) {
  const root = botInstructionRootV1(OWNER);
  const workspace = await FakeWorkspace.seeded([
    {
      root,
      path: "skills/daily-standup/SKILL.md",
      text: skillMarkdown(
        "Daily standup",
        "Use this when assembling the weekday standup.",
        "INVOKED-STANDUP-BODY",
      ),
      writer: WRITER,
    },
    {
      root,
      path: "skills/weekly-report/SKILL.md",
      text: skillMarkdown(
        "Weekly report",
        "Use this when writing the weekly report.",
        "UNINVOKED-REPORT-BODY",
      ),
      writer: WRITER,
    },
  ]);

  const requests: NormalizedModelRequest[] = [];
  const model: LlmProvider = {
    id: "skill-invoker",
    async *stream(request) {
      requests.push(request);
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "completed" };
    },
  };

  const context = new Context();
  await context.plugin(SessionStore, {});
  await context.plugin(SystemPromptRegistry);
  await context.plugin(LlmRegistry);
  await context.plugin(ToolRegistry);
  await context.plugin(AgentRegistry);
  const providerPlugin: Plugin.Function = (ctx) => ctx.llm.register(model);
  providerPlugin.inject = ["llm"];
  await context.plugin(providerPlugin);
  await context.plugin(
    createSkillsRuntimePlugin({ owner: OWNER, reads: workspace }),
  );
  await context.plugin(AgentLoop, { maxSteps: 2, composition: COMPOSITION });

  const handle = await context.agents.create({
    botId: OWNER.botId,
    sessionId: "user-1:bot-1",
    provider: model.id,
    model: "test-model",
    admitEffect: () => Promise.resolve(true),
  });
  handle.agent.send({
    text: "Run the standup.",
    ...(skills ? { skills } : {}),
  });
  await handle.agent.whenIdle();
  const events = [...handle.agent.session.events];
  await context.fiber.dispose();
  return { requests, events };
}

describe("invoking a Skill from the composer", () => {
  test("expands the invoked body into the Turn's first step, and no other", async () => {
    const { requests } = await turnWith([
      { schemaVersion: 1, source: "bot", slug: "daily-standup" },
    ]);

    const first = requests.at(0)?.system ?? "";
    expect(first).toContain("<invoked_skills>");
    expect(first).toContain("INVOKED-STANDUP-BODY");
    // The un-invoked Skill is a catalog line and nothing more: mentioning a
    // Skill is not running it.
    expect(first).toContain("skills/weekly-report/SKILL.md");
    expect(first).not.toContain("UNINVOKED-REPORT-BODY");
  });

  test("expands nothing when nothing was invoked", async () => {
    const { requests } = await turnWith();
    const first = requests.at(0)?.system ?? "";
    expect(first).toContain("<agent_skills>");
    expect(first).not.toContain("<invoked_skills>");
    expect(first).not.toContain("INVOKED-STANDUP-BODY");
  });

  test("records the ref, the generation and the content hash it resolved", async () => {
    const { events } = await turnWith([
      { schemaVersion: 1, source: "bot", slug: "daily-standup" },
    ]);

    const queued = events.find((event) => event.type === "input/queued");
    expect(queued).toMatchObject({
      skills: [{ schemaVersion: 1, source: "bot", slug: "daily-standup" }],
    });

    const invoked = events.find((event) => event.type === "skill/invoked");
    if (invoked?.type !== "skill/invoked") throw new Error("no skill/invoked");
    expect(invoked.turn).toBe(1);
    expect(invoked.ref).toEqual({
      schemaVersion: 1,
      source: "bot",
      slug: "daily-standup",
    });
    // The exact generation the Turn ran on, so the prompt is reconstructable.
    const injected = events.find((event) => event.type === "skill/injected");
    if (injected?.type !== "skill/injected") throw new Error("no injection");
    const listed = injected.skills.find(
      (skill) => skill.path === "skills/daily-standup/SKILL.md",
    );
    expect(invoked.generationId).toBe(listed!.generationId);
    expect(invoked.contentHash).toBe(listed!.contentHash);
  });

  test("fails the command with a reason when the ref names no Skill", async () => {
    const { requests, events } = await turnWith([
      { schemaVersion: 1, source: "bot", slug: "no-such-skill" },
    ]);

    // Never silently dropped: the Turn does not reach the model at all.
    expect(requests).toHaveLength(0);
    const ended = events.find((event) => event.type === "turn/end");
    if (ended?.type !== "turn/end") throw new Error("no turn/end");
    expect(ended.outcome).toBe("blocked");
    expect(ended.reason).toContain("bot/no-such-skill");
    expect(events.some((event) => event.type === "skill/invoked")).toBe(false);
  });

  test("fails a ref whose source no Bot catalog can serve yet", async () => {
    // K1 and K2 add `user`, `managed` and `plugin`. Until then the codec
    // admits the value and the resolver refuses it, visibly.
    const { events } = await turnWith([
      { schemaVersion: 1, source: "user", slug: "daily-standup" },
    ]);
    const ended = events.find((event) => event.type === "turn/end");
    if (ended?.type !== "turn/end") throw new Error("no turn/end");
    expect(ended.outcome).toBe("blocked");
    expect(ended.reason).toContain("user/daily-standup");
  });
});
