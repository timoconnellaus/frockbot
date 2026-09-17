// A Skill a Plugin ships (ADR 0030 step 2, item 4), in workerd.
//
// The claim: a Plugin's Skill goes exactly where its tools go. Two Bots of one
// User run under one pinned Composition holding the same Plugin; one has it
// switched on and one does not. The Bot that runs it can `skill_load` the
// Skill at `plugin/<pluginId>/<slug>` and read the reference the descriptor
// ships beside it; the Bot that does not is told no such Skill is loaded.
//
// Driven through real Turns on real Bot Durable Objects, over the real
// Composition record and the real artifact bucket, with the model scripted to
// call the tool the way a model reaches it in production.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  ISOLATE_CONTRACT_VERSION,
  decodePluginDescriptorV1,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

const PLUGIN_ID = "probe-weather";
const SKILL_SLUG = "weather-report";
const SKILL_REF = `plugin/${PLUGIN_ID}/${SKILL_SLUG}`;
const SKILL_BODY = "PLUGIN-SKILL-BODY: call weather_report, then summarise.";
const REFERENCE_BODY = "PLUGIN-REFERENCE-BODY: the station code table.";

const PLUGIN_SOURCE = `
export const tools = [
  { name: "weather_report", description: "Reports the weather", inputSchema: { type: "object" }, idempotent: true },
];
export async function execute() {
  return "fine";
}
`;

const PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: PLUGIN_ID,
  displayName: "Probe weather",
  version: "0.0.1",
  contractVersion: ISOLATE_CONTRACT_VERSION,
  tools: [
    {
      name: "weather_report",
      description: "Reports the weather",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: [],
  skills: [
    {
      slug: SKILL_SLUG,
      text: `---\nname: Weather report\ndescription: Use this when asked about the weather.\n---\n\n${SKILL_BODY}\n`,
      references: [{ path: "stations.md", text: `${REFERENCE_BODY}\n` }],
    },
  ],
  contextKeys: ["user", "bot", "session"],
});

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  readPluginEnablement(input: unknown): Promise<{ revision: number }>;
  setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
}

interface CompositionRpc {
  readComposition(
    input: unknown,
  ): Promise<{ current: { generationId: string } }>;
  proposeComposition(input: unknown): Promise<void>;
}

function bot(identity: { userId: string; botId: string }): BotRpc {
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc;
}

function user(userId: string): CompositionRpc {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as CompositionRpc;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Seeds the Plugin's artifact and pins the generation that carries it. */
async function pinPluginGeneration(userId: string): Promise<void> {
  const bootstrap = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const contentHash = await sha256Hex(PLUGIN_SOURCE);
  await env.APPLICATION_ARTIFACTS.put(
    `packages/${contentHash}.mjs`,
    PLUGIN_SOURCE,
  );
  const createdAt = "2026-09-17T01:00:00.000Z";
  const members: CompositionMemberV1[] = [
    {
      packageId: PLUGIN_ID,
      version: "0.0.1",
      descriptor: PLUGIN_DESCRIPTOR as CompositionMemberV1["descriptor"],
      provenance: {
        kind: "bot",
        packageId: PLUGIN_ID,
        version: "0.0.1",
        botId: "bot-1",
        sessionId: `${userId}:bot-1`,
        turnId: "run-0",
        runId: "run-0",
        authoredAt: createdAt,
      },
      artifact: {
        contentHash,
        size: PLUGIN_SOURCE.length,
        mediaType: "application/javascript",
        bundlerVersion: "probe-seed",
      },
    },
  ];
  const artifactSetHash = await compositionArtifactSetHashV1(members);
  await user(userId).proposeComposition({
    schemaVersion: 1,
    userId,
    generation: {
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
      artifactSetHash,
      parentGenerationId: bootstrap.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId: "run-0",
        sessionId: `${userId}:bot-1`,
        turnId: "run-0",
      },
      members,
      status: "pending",
    },
    pin: true,
    expectedCurrentGenerationId: bootstrap.generationId,
  });
}

/** One Bot's switch for one Plugin, as the Plugins page flips it. */
async function switchPlugin(
  identity: { userId: string; botId: string },
  enabled: boolean,
): Promise<void> {
  const current = await bot(identity).readPluginEnablement({
    schemaVersion: 1,
    ...identity,
  });
  expect(
    await bot(identity).setBotPluginEnabled({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        kind: "set-plugin-enabled",
        commandId: crypto.randomUUID(),
        pluginId: PLUGIN_ID,
        enabled,
        expectedRevision: current.revision,
      },
    }),
  ).toMatchObject({ status: "applied" });
}

/** Runs one scripted first-party tool call as a real Turn. */
async function callSkillLoad(
  identity: { userId: string; botId: string },
  runId: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: frockbotToolCallPrompt("skill_load", input),
    },
  });
  const events = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string; isError?: boolean }>;
      }>(state.storage),
  );
  const result = (events.find((run) => run.runId === runId)?.events ?? []).find(
    (event) => event.type === "tool/result",
  );
  if (!result) throw new Error(`run ${runId} recorded no tool result`);
  return { content: result.content ?? "", isError: result.isError === true };
}

describe("a Skill a Plugin ships, in Workerd", () => {
  test("reaches the Bot that runs the Plugin, references and all, and no other", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `plugin-skill-${suffix}`;
    const runner = { userId, botId: `runner-${suffix}` };
    const bystander = { userId, botId: `bystander-${suffix}` };
    await provisionBot(runner);
    await provisionSiblingBot(bystander);
    await pinPluginGeneration(userId);

    // The Plugin is installed for the User; only this Bot switches it on.
    await switchPlugin(runner, true);

    const body = await callSkillLoad(runner, "plugin-skill-1", {
      path: SKILL_REF,
    });
    expect(body.isError, body.content).toBe(false);
    expect(body.content).toContain("# Weather report");
    expect(body.content).toContain(`Ref: ${SKILL_REF}`);
    expect(body.content).toContain(SKILL_BODY);

    // The reference the descriptor ships beside it, by the name its
    // instructions index it under.
    const reference = await callSkillLoad(runner, "plugin-skill-2", {
      path: SKILL_REF,
      reference: "stations.md",
    });
    expect(reference.isError, reference.content).toBe(false);
    expect(reference.content).toContain("# Weather report · stations.md");
    expect(reference.content).toContain(REFERENCE_BODY);

    // A reference the Plugin does not ship is refused, not invented.
    const absent = await callSkillLoad(runner, "plugin-skill-3", {
      path: SKILL_REF,
      reference: "forecast.md",
    });
    expect(absent.isError).toBe(true);
    expect(absent.content).toContain('offers no reference "forecast.md"');

    // The sibling has the same Plugin installed and switched off, so the Skill
    // is not in its Turn's catalog at all.
    const withheld = await callSkillLoad(bystander, "plugin-skill-4", {
      path: SKILL_REF,
    });
    expect(withheld.isError).toBe(true);
    expect(withheld.content).toContain(`No Skill "${SKILL_REF}" is loaded`);
  });
});
