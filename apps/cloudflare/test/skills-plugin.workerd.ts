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
  ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1,
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

const PROBE_PLUGIN: ProbePluginV1 = {
  pluginId: PLUGIN_ID,
  descriptor: PLUGIN_DESCRIPTOR,
  source: PLUGIN_SOURCE,
};

/**
 * The probe Plugin whose two Skills sit on the artifact bound.
 *
 * Its Skills are CJK: one UTF-16 code unit, three UTF-8 bytes each. The pair
 * is what tells the two ways of counting an artifact apart -- read as code
 * units it is about a third of the size the encoded bound measures, so a bound
 * counted that way stores a generation this one refuses.
 */
const BYTES_PLUGIN_ID = "probe-bounded-bytes";
/** One CJK character: one UTF-16 code unit, three UTF-8 bytes. */
const CJK = "字";

/** A `SKILL.md` of exactly `bytes` UTF-8 bytes whose body is CJK. */
function boundedSkillText(slug: string, bytes: number): string {
  const header = `---\nname: ${slug}\ndescription: Use this when bounded.\n---\n\n`;
  const ascii = (bytes - header.length) % 3;
  const characters = (bytes - header.length - ascii) / 3;
  return `${header}${"x".repeat(ascii)}${CJK.repeat(characters)}`;
}

/**
 * The bounded Plugin's descriptor, with its second Skill `second` bytes long.
 *
 * Raw, not decoded here: whether this descriptor may be written at all is
 * exactly what the Composition it is proposed to decides.
 */
function boundedDescriptor(second: number): Record<string, unknown> {
  return {
    id: BYTES_PLUGIN_ID,
    displayName: "Probe bounded bytes",
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
        slug: "first",
        text: boundedSkillText("first", ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 / 2),
      },
      { slug: "second", text: boundedSkillText("second", second) },
    ],
    contextKeys: ["user", "bot", "session"],
  };
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  readPluginEnablement(input: unknown): Promise<{ revision: number }>;
  setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
  listSkills(input: unknown): Promise<{ skills: Array<{ ref: string }> }>;
}

/** One probe Plugin: the id its member is named by, its descriptor, its module. */
interface ProbePluginV1 {
  pluginId: string;
  descriptor: unknown;
  source: string;
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
async function pinPluginGeneration(
  userId: string,
  plugin: ProbePluginV1,
): Promise<void> {
  const bootstrap = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const contentHash = await sha256Hex(plugin.source);
  await env.APPLICATION_ARTIFACTS.put(
    `packages/${contentHash}.mjs`,
    plugin.source,
  );
  const createdAt = "2026-09-17T01:00:00.000Z";
  const members: CompositionMemberV1[] = [
    {
      packageId: plugin.pluginId,
      version: "0.0.1",
      descriptor: plugin.descriptor as CompositionMemberV1["descriptor"],
      provenance: {
        kind: "bot",
        packageId: plugin.pluginId,
        version: "0.0.1",
        botId: "bot-1",
        sessionId: `${userId}:bot-1`,
        turnId: "run-0",
        runId: "run-0",
        authoredAt: createdAt,
      },
      artifact: {
        contentHash,
        size: plugin.source.length,
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
  pluginId: string,
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
        pluginId,
        enabled,
        expectedRevision: current.revision,
      },
    }),
  ).toMatchObject({ status: "applied" });
}

/** The Skill refs the composer's popover reads for this Bot. */
async function listSkillRefs(identity: {
  userId: string;
  botId: string;
}): Promise<string[]> {
  const catalog = await bot(identity).listSkills({
    schemaVersion: 1,
    ...identity,
  });
  return catalog.skills.map((entry) => entry.ref);
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
    await pinPluginGeneration(userId, PROBE_PLUGIN);

    // The Plugin is installed for the User; only this Bot switches it on.
    await switchPlugin(runner, PLUGIN_ID, true);

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

  test(
    "a Skill past the bound in encoded bytes is refused at the Composition, and one on the bound reaches the catalog",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const userId = `plugin-bytes-${suffix}`;
      const identity = { userId, botId: `bytes-${suffix}` };
      await provisionBot(identity);
      const plugin: ProbePluginV1 = {
        pluginId: BYTES_PLUGIN_ID,
        source: PLUGIN_SOURCE,
        descriptor: boundedDescriptor(
          ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 / 2 + 1,
        ),
      };

      // One byte of Skill text past the bound, in two Skills whose UTF-16
      // length is a third of that: the User's Composition refuses the
      // generation rather than carry it as one durable value.
      await expect(pinPluginGeneration(userId, plugin)).rejects.toThrow(
        /bytes of Skill text/,
      );

      // Refused means not installed: the Bot's own catalog is the bootstrap
      // one.
      expect(await listSkillRefs(identity)).not.toContain(
        `plugin/${BYTES_PLUGIN_ID}/first`,
      );

      // The same two Skills, the longer one a byte shorter, sit exactly on the
      // bound and are admitted; the Bot that switches the Plugin on is offered
      // both, so the refusal above was about the bytes and not the shape.
      await pinPluginGeneration(userId, {
        ...plugin,
        descriptor: boundedDescriptor(
          ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1 / 2,
        ),
      });
      await switchPlugin(identity, BYTES_PLUGIN_ID, true);
      expect(await listSkillRefs(identity)).toEqual(
        expect.arrayContaining([
          `plugin/${BYTES_PLUGIN_ID}/first`,
          `plugin/${BYTES_PLUGIN_ID}/second`,
        ]),
      );
    },
  );
});
