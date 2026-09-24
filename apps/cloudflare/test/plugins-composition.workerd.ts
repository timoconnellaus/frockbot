// The User owns the Composition; a Bot mirrors it before admission (ADR 0026).
//
// Two claims against the real User and Bot Durable Objects: a generation the
// User pins is what the next admitted Turn on any of that User's Bots runs
// under — whichever way that Turn is admitted, a chat Turn or a Routine
// firing — and the outcome of that activation lands on the User's record, not
// the Bot's.
import { env } from "cloudflare:workers";
import type { AuditEntryV1 } from "@frockbot/app/audit";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index.ts";
import { describe, expect, test, vi } from "vitest";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import { THEME_ASSEMBLE_DUE_KEY_V1 } from "@frockbot/app/theme/owed";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";
import {
  ISOLATE_CONTRACT_VERSION,
  decodePluginDescriptorV1,
  pluginCardToolNameV1,
  pluginPageKeyV1,
  withPluginPageBridgeV1,
} from "@frockbot/core/contracts";
import {
  routineDeliveryIdV1,
  routineHookDigestV1,
  verifyRoutineHookTokenV1,
} from "@frockbot/app/routines/hook";
import { decodePendingBotInputV1 } from "@frockbot/app/routines/inbox";
import { cardValuesDigestV1 } from "@frockbot/app/shell/cards";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";

/**
 * A Plugin that exercises the loopback capabilities from inside a real Turn:
 * its storage round-trips a value, its settings read what the Bot holds, and
 * `capabilities.list()` reports the Bot's authority — all through the Bot
 * Durable Object, which is what the per-User stub routes to.
 */
const STORE_PLUGIN_ID = "probe-store";
const STORE_PLUGIN_SOURCE = `
export const tools = [
  { name: "store_roundtrip", description: "Writes, lists and reads a value", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "store_roundtrip") return "unknown tool";
  const put = await ctx.storage.put({ key: "greeting", value: { word: input.word } });
  const got = await ctx.storage.get({ key: "greeting" });
  const missing = await ctx.storage.get({ key: "absent" });
  const listed = await ctx.storage.list({});
  const settings = await ctx.settings.read();
  const authority = await ctx.capabilities.list();
  return JSON.stringify({
    put: put.status,
    got: got.value,
    missing: missing.value,
    keys: listed.status === "available" ? listed.entries.map((entry) => entry.key) : listed,
    settings: settings.status === "available" ? settings.values : settings,
    authority: authority.status,
    connections: authority.status === "available" ? authority.connections.length : -1,
    bot: ctx.bot.botId,
    user: ctx.user.userId,
  });
}
`;
const STORE_PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: STORE_PLUGIN_ID,
  displayName: "Probe store",
  version: "0.0.1",
  contractVersion: ISOLATE_CONTRACT_VERSION,
  tools: [
    {
      name: "store_roundtrip",
      description: "Writes, lists and reads a value",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: ["storage"],
  contextKeys: ["user", "bot", "session"],
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface CompositionRpc {
  readComposition(input: unknown): Promise<{
    current: {
      generationId: string;
      status: string;
      createdAt: string;
      artifactSetHash: string;
      members: unknown[];
    };
    lastKnownGood: { generationId: string };
  }>;
  readCompositionGeneration(
    input: unknown,
  ): Promise<{ generationId: string; status: string } | undefined>;
  proposeComposition(input: unknown): Promise<void>;
  listCompositionGenerations(
    input: unknown,
  ): Promise<{ generations: { generationId: string; status: string }[] }>;
  setFeatures(input: unknown): Promise<unknown>;
}

interface FeaturesRpc {
  setFeatures(input: unknown): Promise<unknown>;
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  setFocusedPanel(input: unknown): Promise<{ status: string }>;
  recordPanelDeviceUse(
    input: unknown,
  ): Promise<{ status: string; reason?: string }>;
  openFocusedPanel(input: unknown): Promise<{
    focus: { pluginId: string | null; surfaceId?: string };
    document?: unknown;
    page?: { url: string; state: Record<string, unknown> };
    failure?: string;
  }>;
  listCards(input: unknown): Promise<{
    cards: Array<{
      surfaceId: string;
      revision: number;
      components: Array<Record<string, unknown>>;
      dataModel: Record<string, unknown>;
    }>;
  }>;
  cardAction(input: unknown): Promise<{
    routed: string;
    failure?: string;
    card: {
      surfaceId: string;
      revision: number;
      components: Array<Record<string, unknown>>;
      dataModel: Record<string, unknown>;
    };
  }>;
  listCompositionGenerations(input: unknown): Promise<{
    botId: string;
    currentGenerationId: string;
    generations: { generationId: string; isCurrent: boolean }[];
  }>;
  setPluginEnabled(input: unknown): Promise<
    | {
        status: "applied";
        enablement: { revision: number; enabled: Record<string, boolean> };
      }
    | { status: "conflict"; currentRevision: number }
  >;
  listNotifications(
    input: unknown,
  ): Promise<Array<{ notificationId: string; title: string; body: string }>>;
  assembleTheme(input: unknown): Promise<unknown>;
  readLook(input: unknown): Promise<{
    look: unknown;
    document?: { tokens: { surfaces: { window: string } } };
  }>;
  executeRoutineCommand(input: unknown): Promise<{
    status: string;
    hook?: { token: string; keyVersion: number };
  }>;
  deliverRoutineHook(
    input: unknown,
  ): Promise<
    | { status: "accepted" | "duplicate"; fireId: string }
    | { status: "dropped"; reason: string }
  >;
  readPluginEnablement(input: unknown): Promise<{
    revision: number;
    enabled: Record<string, boolean>;
  }>;
  listApprovals(input: unknown): Promise<{
    pending: number;
    approvals: Array<{ approvalId: string; decision: string; action: string }>;
  }>;
  decideApproval(input: unknown): Promise<{
    status: string;
    approval: { approvalId: string; decision: string };
  }>;
  readBotPluginsFrame(input: unknown): Promise<{
    revision: number;
    plugins: Array<{
      pluginId: string;
      kind: string;
      on: boolean;
      sections?: Array<{
        surfaceId: string;
        root?: unknown;
        failure?: string;
        nodes: number;
      }>;
    }>;
  }>;
  executeBotPluginTool(
    input: unknown,
  ): Promise<
    | { status: "ran"; content: string; isError: boolean }
    | { status: "rejected"; failure: string }
  >;
  setBotPluginEnabled(
    input: unknown,
  ): Promise<
    | { status: "applied"; revision: number }
    | { status: "conflict"; currentRevision: number }
    | { status: "rejected"; failure: string }
  >;
}

function user(userId: string): CompositionRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the methods the test calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as CompositionRpc;
}

function features(userId: string): FeaturesRpc {
  // SAFETY: as above — only the one method the test calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as FeaturesRpc;
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
  const answer = await bot(identity).setBotPluginEnabled({
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
  });
  expect(answer).toMatchObject({ status: "applied" });
}

/** The stored events of one run, for reading a tool's answer back. */
async function runEvents(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<Array<{ type: string; content?: string; name?: string }>> {
  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string; name?: string }>;
      }>(state.storage),
  );
  return runs.find((candidate) => candidate.runId === runId)?.events ?? [];
}

interface AuditReadRpc {
  readAuditEntries(input: unknown): Promise<{ entries: AuditEntryV1[] }>;
  rebuildAuditIndex(input: unknown): Promise<{ status: string }>;
}

function audit(userId: string): AuditReadRpc {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as AuditReadRpc;
}

function bot(identity: { userId: string; botId: string }): BotRpc {
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc;
}

async function pinnedGeneration(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<string | undefined> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) => {
      const runs = await hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        compositionGenerationId?: string;
      }>(state.storage);
      return runs.find((run) => run.runId === runId)?.compositionGenerationId;
    },
  );
}

interface ApprovalDeliveryProbe {
  runId: string;
  sessionId: string;
  status: string;
  admission?: { origin?: { kind: string } };
  preparedInputs?: {
    bot: { enablement: { enabled: Record<string, boolean> } };
  };
}

/**
 * The Turn an approval decision opened, once it has settled. It starts on the
 * promise the decision left behind, or on the recovery alarm, so this nudges
 * the alarm between looks.
 */
async function settledApprovalDelivery(identity: {
  userId: string;
  botId: string;
}): Promise<ApprovalDeliveryProbe> {
  const stub = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await runInDurableObject(stub, async (_instance, state) =>
      (await hydratedStoredRunsV1<ApprovalDeliveryProbe>(state.storage)).find(
        (run) => run.admission?.origin?.kind === "input-delivery",
      ),
    );
    if (found && found.status !== "running") return found;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(stub, (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error("the decision never opened a Turn");
}

async function turn(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<void> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: "hello",
    },
  });
}

/**
 * The pin each admitted run took, by run id. `pinnedGeneration` answers for
 * one known run; a firing mints its own id, so this returns the lot.
 */
async function pinnedGenerations(identity: {
  userId: string;
  botId: string;
}): Promise<Array<{ runId: string; compositionGenerationId?: string }>> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) => {
      const runs = await hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        compositionGenerationId?: string;
        admission?: { origin?: { routineId?: string } };
      }>(state.storage);
      return runs
        .filter((run) => run.admission?.origin?.routineId === "brief")
        .map((run) => ({
          runId: run.runId,
          ...(run.compositionGenerationId === undefined
            ? {}
            : { compositionGenerationId: run.compositionGenerationId }),
        }));
    },
  );
}

/**
 * Runs `store_roundtrip` as a real Turn of `identity` and returns what the
 * Plugin saw through the loopback.
 */
async function storeRoundtrip(
  identity: { userId: string; botId: string },
  runId: string,
  word: string,
): Promise<Record<string, unknown>> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "call_dynamic_tool",
        dynamicToolInputV1({
          namespace: STORE_PLUGIN_ID,
          toolName: "store_roundtrip",
          input: { word },
        }),
      ]),
    },
  });

  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string; name?: string }>;
      }>(state.storage),
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  const result = run?.events.find(
    (event) =>
      event.type === "tool/result" &&
      typeof event.content === "string" &&
      event.content.includes('"put"'),
  );
  expect(
    result,
    // What every tool answered, so a refusal reads as its own words.
    JSON.stringify(
      run?.events
        .filter((event) => event.type === "tool/result")
        .map((event) => event.content),
    ),
  ).toBeDefined();
  const raw = (result as { content?: string }).content ?? "";
  const outer = JSON.parse(raw) as { content?: string };
  return JSON.parse(
    typeof outer.content === "string" ? outer.content : raw,
  ) as Record<string, unknown>;
}

/**
 * A Plugin that pushes on the storage grant's declared bound: it stores a
 * value whose UTF-16 length is inside 64 KiB but whose UTF-8 encoding is not,
 * then one that fits, so a Turn shows which of the two the bound is measured
 * in.
 */
const BOUND_PLUGIN_ID = "probe-bound";
const BOUND_PLUGIN_SOURCE = `
export const tools = [
  { name: "bound_probe", description: "Pushes on the value bound", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "bound_probe") return "unknown tool";
  // 40,000 UTF-16 units, ~120,000 bytes once encoded.
  const oversized = await ctx.storage.put({ key: "big", value: "\u5B57".repeat(40000) });
  const readBack = await ctx.storage.get({ key: "big" });
  // 20,000 UTF-16 units, ~60,000 bytes: inside the bound either way.
  const fits = await ctx.storage.put({ key: "fits", value: "\u5B57".repeat(20000) });
  const listed = await ctx.storage.list({});
  return JSON.stringify({
    put: oversized.status,
    oversized: oversized.status,
    oversizedReason: oversized.status === "unavailable" ? oversized.reason : null,
    readBack: readBack.status === "available" ? readBack.value : readBack.status,
    fits: fits.status,
    keys: listed.status === "available" ? listed.entries.map((entry) => entry.key) : listed,
  });
}
`;
const BOUND_PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: BOUND_PLUGIN_ID,
  displayName: "Probe bound",
  version: "0.0.1",
  contractVersion: ISOLATE_CONTRACT_VERSION,
  tools: [
    {
      name: "bound_probe",
      description: "Pushes on the value bound",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: ["storage"],
  contextKeys: ["user", "bot", "session"],
});

/** A Plugin that declared no grants at all, and so holds no storage surface. */
const UNGRANTED_PLUGIN_ID = "probe-ungranted";
const UNGRANTED_PLUGIN_SOURCE = `
export const tools = [
  { name: "grant_probe", description: "Reports the surfaces it holds", inputSchema: { type: "object" }, idempotent: true },
];
export async function execute(tool, input, ctx) {
  if (tool !== "grant_probe") return "unknown tool";
  let reached = "absent";
  try {
    const outcome = await ctx.storage.put({ key: "sneak", value: 1 });
    reached = outcome.status;
  } catch (error) {
    reached = "threw:" + String(error && error.name);
  }
  return JSON.stringify({
    put: "n/a",
    storage: typeof ctx.storage,
    reached,
  });
}
`;
const UNGRANTED_PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: UNGRANTED_PLUGIN_ID,
  displayName: "Probe ungranted",
  version: "0.0.1",
  contractVersion: ISOLATE_CONTRACT_VERSION,
  tools: [
    {
      name: "grant_probe",
      description: "Reports the surfaces it holds",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: [],
  contextKeys: ["user", "bot", "session"],
});

/**
 * A Plugin the User approved for open network access: whatever host it
 * reaches, the egress loopback minted for the worker admits.
 */
const OPEN_PLUGIN_ID = "probe-open";
const OPEN_PLUGIN_SOURCE = `
export const tools = [
  { name: "open_probe", description: "Reaches an arbitrary host", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "open_probe") return "unknown tool";
  let put = "n/a";
  try {
    const response = await fetch("https://nowhere.example/probe");
    return JSON.stringify({ put, admitted: true, status: response.status });
  } catch (error) {
    return JSON.stringify({ put, admitted: false, reason: String(error && error.message) });
  }
}
`;
const OPEN_PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: OPEN_PLUGIN_ID,
  displayName: "Probe open",
  version: "0.0.1",
  contractVersion: ISOLATE_CONTRACT_VERSION,
  tools: [
    {
      name: "open_probe",
      description: "Reaches an arbitrary host",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: ["http"],
  network: { open: true },
  contextKeys: ["user", "bot", "session"],
});

/**
 * Seeds each Plugin's artifact the way a build would store it and pins one
 * generation holding the lot, so the Bot's next Turn mounts them.
 */
async function pinGeneration(
  userId: string,
  plugins: Array<{ id: string; source: string; descriptor: unknown }>,
): Promise<void> {
  const bootstrap = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const createdAt = "2026-09-12T01:00:00.000Z";
  const members: CompositionMemberV1[] = [];
  for (const plugin of plugins) {
    const contentHash = await sha256Hex(plugin.source);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      plugin.source,
    );
    members.push({
      packageId: plugin.id,
      version: "0.0.1",
      descriptor: plugin.descriptor as CompositionMemberV1["descriptor"],
      provenance: {
        kind: "bot",
        packageId: plugin.id,
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
    });
  }
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

/** Runs one Plugin tool as a real Turn and returns the JSON it answered. */
async function callPluginTool(
  identity: { userId: string; botId: string },
  runId: string,
  namespace: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "call_dynamic_tool",
        dynamicToolInputV1({ namespace, toolName, input }),
      ]),
    },
  });

  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string; name?: string }>;
      }>(state.storage),
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  const result = run?.events.find(
    (event) =>
      event.type === "tool/result" &&
      typeof event.content === "string" &&
      event.content.includes('"put"'),
  );
  expect(
    result,
    // What every tool answered, so a refusal reads as its own words.
    JSON.stringify(
      run?.events
        .filter((event) => event.type === "tool/result")
        .map((event) => event.content),
    ),
  ).toBeDefined();
  const raw = (result as { content?: string }).content ?? "";
  const outer = JSON.parse(raw) as { content?: string };
  return JSON.parse(
    typeof outer.content === "string" ? outer.content : raw,
  ) as Record<string, unknown>;
}

/** One Plugin tool run as a real Turn, answered with the text the Bot read. */
async function callPluginToolRaw(
  identity: { userId: string; botId: string },
  runId: string,
  namespace: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "call_dynamic_tool",
        dynamicToolInputV1({ namespace, toolName, input }),
      ]),
    },
  });
  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string }>;
      }>(state.storage),
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  const results = (run?.events ?? [])
    .filter((event) => event.type === "tool/result")
    .map((event) => event.content ?? "");
  expect(results.length, JSON.stringify(results)).toBeGreaterThan(0);
  return results.join("\n");
}

/** What any Plugin storage key holds in a Bot's own Durable Object. */
async function storedValue(
  identity: { userId: string; botId: string },
  pluginId: string,
  key: string,
): Promise<unknown> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      state.storage.get(`plugin:storage:${pluginId}:${key}`),
  );
}

/** What one Plugin's storage key holds in a Bot's own Durable Object. */
async function storedGreeting(identity: {
  userId: string;
  botId: string;
}): Promise<unknown> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      state.storage.get(`plugin:storage:${STORE_PLUGIN_ID}:greeting`),
  );
}

describe("the User-owned Composition", () => {
  test("a generation the User pins is what every Bot's next Turn runs under, and it activates on the User", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const first = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(first);
    await provisionSiblingBot(second);

    // The bootstrap: one generation, the same for both Bots.
    await turn(first, "run-1");
    const bootstrap = (
      await user(userId).readComposition({
        schemaVersion: 1,
        userId,
      })
    ).current;
    expect(await pinnedGeneration(first, "run-1")).toBe(bootstrap.generationId);
    expect(bootstrap.status).toBe("active");

    // A new generation, proposed on the User and pinned for the next Turn.
    const createdAt = "2026-09-12T00:00:00.000Z";
    const proposed = {
      ...bootstrap,
      generationId: `${createdAt}:${bootstrap.generationId.split(":").at(-1)}`,
      parentGenerationId: bootstrap.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: `${userId}:bot-1`,
        turnId: "run-1",
      },
      status: "pending",
    };
    await user(userId).proposeComposition({
      schemaVersion: 1,
      userId,
      generation: proposed,
      pin: true,
      expectedCurrentGenerationId: bootstrap.generationId,
    });

    await turn(second, "run-2");
    await turn(first, "run-3");

    expect(await pinnedGeneration(second, "run-2")).toBe(proposed.generationId);
    expect(await pinnedGeneration(first, "run-3")).toBe(proposed.generationId);
    const after = await user(userId).readComposition({
      schemaVersion: 1,
      userId,
    });
    expect(after.current.generationId).toBe(proposed.generationId);
    expect(after.current.status).toBe("active");
    expect(after.lastKnownGood.generationId).toBe(proposed.generationId);
    expect(
      (
        await user(userId).readCompositionGeneration({
          schemaVersion: 1,
          userId,
          generationId: bootstrap.generationId,
        })
      )?.status,
    ).toBe("superseded");
    // The Turn that ran before the proposal keeps the generation it pinned.
    expect(await pinnedGeneration(first, "run-1")).toBe(bootstrap.generationId);
  });

  test("the Composition each Bot lists is the User's whole history, not its mirror", async () => {
    // The mirror a Bot keeps is two generations deep. The settings list has
    // to answer from the User, so a third generation must still be there.
    const userId = `user-${crypto.randomUUID()}`;
    const first = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(first);
    await provisionSiblingBot(second);
    await turn(first, "run-1");

    let parent = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const proposedIds: string[] = [];
    for (const hour of ["02", "03"]) {
      const createdAt = `2026-09-12T${hour}:00:00.000Z`;
      const generation = {
        ...parent,
        generationId: `${createdAt}:${parent.generationId.split(":").at(-1)}`,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: `install-${hour}`,
          sessionId: `${userId}:bot-1`,
          turnId: `install-${hour}`,
        },
        status: "pending",
      };
      await user(userId).proposeComposition({
        schemaVersion: 1,
        userId,
        generation,
        pin: true,
        expectedCurrentGenerationId: parent.generationId,
      });
      proposedIds.push(generation.generationId);
      parent = { ...generation, status: "active" };
    }
    const listing = await bot(first).listCompositionGenerations({
      schemaVersion: 1,
      ...first,
      query: { limit: 10 },
    });
    expect(listing.botId).toBe("bot-1");
    expect(listing.currentGenerationId).toBe(proposedIds.at(-1));
    expect(listing.generations.map((entry) => entry.generationId)).toEqual(
      expect.arrayContaining(proposedIds),
    );
    expect(listing.generations.length).toBeGreaterThanOrEqual(3);
    expect(
      listing.generations
        .filter((entry) => entry.isCurrent)
        .map((entry) => entry.generationId),
    ).toEqual([proposedIds.at(-1)]);

    // The sibling Bot, which has admitted nothing, lists the same history.
    const sibling = await bot(second).listCompositionGenerations({
      schemaVersion: 1,
      ...second,
      query: { limit: 10 },
    });
    expect(sibling.botId).toBe("bot-2");
    expect(sibling.generations.map((entry) => entry.generationId)).toEqual(
      listing.generations.map((entry) => entry.generationId),
    );
  });

  test("a Bot's enable map is its own", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    const rpc = bot(identity);
    expect(
      await rpc.readPluginEnablement({ schemaVersion: 1, ...identity }),
    ).toMatchObject({ revision: 0 });
    const off = await rpc.setPluginEnabled({
      schemaVersion: 1,
      ...identity,
      pluginId: "weather",
      enabled: false,
      expectedRevision: 0,
    });
    expect(off).toEqual({
      status: "applied",
      enablement: expect.objectContaining({
        revision: 1,
        enabled: { weather: false },
      }),
    });
    expect(
      await rpc.setPluginEnabled({
        schemaVersion: 1,
        ...identity,
        pluginId: "weather",
        enabled: true,
        expectedRevision: 0,
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    // The other Bot of the same User is untouched.
    const sibling = { userId, botId: "bot-2" };
    await provisionSiblingBot(sibling);
    expect(
      await bot(sibling).readPluginEnablement({ schemaVersion: 1, ...sibling }),
    ).toMatchObject({ revision: 0, enabled: {} });
  });

  test("a Bot's Plugins page lists what it could run, and its switches are its own", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    const rpc = bot(identity);
    const frame = await rpc.readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    expect(frame.revision).toBe(0);
    const web = frame.plugins.find((row) => row.pluginId === "web");
    expect(web).toMatchObject({ kind: "first-party", on: true });
    expect(frame.plugins.map((row) => row.pluginId)).not.toContain(
      "custom-models",
    );
    const switchWeb = (enabled: boolean, expectedRevision: number) =>
      rpc.setBotPluginEnabled({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "set-plugin-enabled",
          commandId: crypto.randomUUID(),
          pluginId: "web",
          enabled,
          expectedRevision,
        },
      });
    expect(await switchWeb(false, 0)).toEqual({
      status: "applied",
      revision: 1,
    });
    expect(
      (
        await rpc.readBotPluginsFrame({ schemaVersion: 1, ...identity })
      ).plugins.find((row) => row.pluginId === "web")?.on,
    ).toBe(false);
    expect(await switchWeb(true, 0)).toEqual({
      status: "conflict",
      currentRevision: 1,
    });
    expect(
      await rpc.setBotPluginEnabled({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "set-plugin-enabled",
          commandId: crypto.randomUUID(),
          pluginId: "nothing-here",
          enabled: true,
          expectedRevision: 1,
        },
      }),
    ).toMatchObject({ status: "rejected" });
    // The other Bot of the same User is untouched.
    const sibling = { userId, botId: "bot-2" };
    await provisionSiblingBot(sibling);
    expect(
      await bot(sibling).readPluginEnablement({ schemaVersion: 1, ...sibling }),
    ).toMatchObject({ revision: 0, enabled: {} });
  });

  test("a Bot whose first admission is a Routine firing pins the User's generation", async () => {
    // A chat Turn is not the only way in. A firing is admitted from inside the
    // object's own alarm, and if the Bot has not mirrored the User's pin by
    // then it bootstraps a generation of its own and pins that — an id the
    // User has never heard of, which fails the moment activation commits.
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);

    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const createdAt = "2026-09-12T01:00:00.000Z";
    const pinned = {
      ...bootstrap,
      generationId: `${createdAt}:${bootstrap.generationId.split(":").at(-1)}`,
      parentGenerationId: bootstrap.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId: "install-1",
        sessionId: `${userId}:bot-1`,
        turnId: "install-1",
      },
      status: "pending",
    };
    await user(userId).proposeComposition({
      schemaVersion: 1,
      userId,
      generation: pinned,
      pin: true,
      expectedCurrentGenerationId: bootstrap.generationId,
    });

    // The Bot has admitted nothing at this point; the firing is its first.
    expect(
      await bot(identity).executeRoutineCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          botId: identity.botId,
          type: "routine/create",
          commandId: `create-${userId}`,
          routineId: "brief",
          name: "Hourly brief",
          prompt: "Summarize overnight email.",
          schedule: "0 * * * *",
        },
      }),
    ).toMatchObject({ status: "applied" });
    await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:${identity.botId}`),
      async (_instance, state) => {
        const record = await state.storage.get<{ updatedAt: string }>(
          "routine:brief",
        );
        await state.storage.put("routine-schedule:brief", {
          schemaVersion: 1,
          routineId: "brief",
          anchor: record!.updatedAt,
          dueAt: Date.now() - 60 * 60_000,
        });
      },
    );
    expect(
      await runDurableObjectAlarm(
        env.BOT_STATES.getByName(`${userId}:${identity.botId}`),
      ),
    ).toBe(true);

    const fired = await pinnedGenerations(identity);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.compositionGenerationId).toBe(pinned.generationId);
    // And the activation landed on the User, which is the only place the
    // generation exists.
    const after = await user(userId).readComposition({
      schemaVersion: 1,
      userId,
    });
    expect(after.current).toMatchObject({
      generationId: pinned.generationId,
      status: "active",
    });
  });

  test("a plugin in a real Turn reaches storage, settings and the Bot's authority through the loopback", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(identity);
    await provisionSiblingBot(second);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    // The artifact is seeded the way a build would store it: content-addressed.
    const contentHash = await sha256Hex(STORE_PLUGIN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      STORE_PLUGIN_SOURCE,
    );
    const createdAt = "2026-09-12T01:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: STORE_PLUGIN_ID,
        version: "0.0.1",
        descriptor: STORE_PLUGIN_DESCRIPTOR,
        provenance: {
          kind: "bot",
          packageId: STORE_PLUGIN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: STORE_PLUGIN_SOURCE.length,
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
    // A Plugin a Bot wrote runs nowhere until a person switches it on: here
    // the Plugins page's switch stands in for the approval card.
    await switchPlugin(identity, STORE_PLUGIN_ID, true);

    const inner = await storeRoundtrip(identity, "run-1", "hello");
    expect(inner).toMatchObject({
      put: "available",
      got: { word: "hello" },
      missing: null,
      keys: ["greeting"],
      settings: {},
      authority: "available",
      bot: "bot-1",
      user: userId,
    });
    expect(inner.connections as number).toBeGreaterThanOrEqual(1);

    // The binding digest names only the User, so this Bot is served the worker
    // the first Bot's object loaded — including the `CAPABILITIES` stub minted
    // there. The stub must still answer, and it must route by the scope's Bot:
    // this Turn's writes land in this Bot's own object, not the first one's.
    // The switch is per Bot, so the sibling turns the Plugin on for itself.
    await switchPlugin(second, STORE_PLUGIN_ID, true);
    const sibling = await storeRoundtrip(second, "run-2", "world");
    expect(sibling).toMatchObject({
      put: "available",
      got: { word: "world" },
      keys: ["greeting"],
      authority: "available",
      bot: "bot-2",
      user: userId,
    });
    expect(await storedGreeting(second)).toEqual({ word: "world" });
    expect(await storedGreeting(identity)).toEqual({ word: "hello" });
  });

  test("the storage value bound is measured in encoded bytes, and an over-bound value is refused rather than stored", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    await pinGeneration(userId, [
      {
        id: BOUND_PLUGIN_ID,
        source: BOUND_PLUGIN_SOURCE,
        descriptor: BOUND_PLUGIN_DESCRIPTOR,
      },
    ]);
    // A Plugin a Bot wrote runs nowhere until a person switches it on.
    await switchPlugin(identity, BOUND_PLUGIN_ID, true);

    const seen = await callPluginTool(
      identity,
      "run-1",
      BOUND_PLUGIN_ID,
      "bound_probe",
      {},
    );

    // 40,000 CJK characters are inside 64 Ki UTF-16 units and outside 64 KiB
    // encoded: the bound the Plugin was told about is the encoded one.
    expect(seen).toMatchObject({
      oversized: "unavailable",
      readBack: null,
      fits: "available",
      keys: ["fits"],
    });
    expect(await storedValue(identity, BOUND_PLUGIN_ID, "big")).toBeUndefined();
    expect(await storedValue(identity, BOUND_PLUGIN_ID, "fits")).toEqual(
      "\u5B57".repeat(20000),
    );
  });

  test("a plugin that declared no storage grant holds no storage surface at all", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    await pinGeneration(userId, [
      {
        id: UNGRANTED_PLUGIN_ID,
        source: UNGRANTED_PLUGIN_SOURCE,
        descriptor: UNGRANTED_PLUGIN_DESCRIPTOR,
      },
    ]);
    // A Plugin a Bot wrote runs nowhere until a person switches it on.
    await switchPlugin(identity, UNGRANTED_PLUGIN_ID, true);

    const seen = await callPluginTool(
      identity,
      "run-1",
      UNGRANTED_PLUGIN_ID,
      "grant_probe",
      {},
    );

    expect(seen).toMatchObject({ storage: "undefined" });
    expect(String(seen.reached)).toMatch(/^threw:/);
    expect(
      await storedValue(identity, UNGRANTED_PLUGIN_ID, "sneak"),
    ).toBeUndefined();
  });

  test("a plugin the User approved for open access reaches any host through the egress loopback", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    await pinGeneration(userId, [
      {
        id: OPEN_PLUGIN_ID,
        source: OPEN_PLUGIN_SOURCE,
        descriptor: OPEN_PLUGIN_DESCRIPTOR,
      },
    ]);
    // A Plugin a Bot wrote runs nowhere until a person switches it on.
    await switchPlugin(identity, OPEN_PLUGIN_ID, true);

    const seen = await callPluginTool(
      identity,
      "run-1",
      OPEN_PLUGIN_ID,
      "open_probe",
      {},
    );

    // The host is declared by nobody; open access admits it anyway. The
    // suite's outbound stands in for the outside and answers 403, which only
    // a request the loopback let out can see — a refusal throws instead.
    expect(seen).toMatchObject({ admitted: true, status: 403 });
  });

  test("a sibling Bot asks to turn a Plugin on, and it runs only once the User approves", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const author = { userId, botId: "bot-1" };
    const sibling = { userId, botId: "bot-2" };
    await provisionBot(author);
    await provisionSiblingBot(sibling);
    await features(userId).setFeatures({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/set-features",
        pluginAuthoring: true,
      },
      updatedBy: "test",
    });
    await turn(author, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const contentHash = await sha256Hex(STORE_PLUGIN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      STORE_PLUGIN_SOURCE,
    );
    const createdAt = "2026-09-12T02:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: STORE_PLUGIN_ID,
        version: "0.0.1",
        descriptor: STORE_PLUGIN_DESCRIPTOR,
        provenance: {
          kind: "bot",
          packageId: STORE_PLUGIN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: STORE_PLUGIN_SOURCE.length,
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

    // The sibling sees the Plugin but does not run it; plugin_enable asks.
    const session = `${userId}:bot-2`;
    await bot(sibling).run({
      schemaVersion: 1,
      ...sibling,
      command: {
        runId: "ask-1",
        sessionId: session,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "frockbot",
            toolName: "plugin_enable",
            input: { pluginId: STORE_PLUGIN_ID },
          }),
        ]),
      },
    });
    const asked = (await runEvents(sibling, "ask-1")).find(
      (event) =>
        event.type === "tool/result" &&
        typeof event.content === "string" &&
        event.content.includes("Asked the User to turn"),
    );
    expect(asked, "plugin_enable did not ask").toBeDefined();
    const listed = await bot(sibling).listApprovals({
      schemaVersion: 1,
      ...sibling,
    });
    expect(listed.pending).toBe(1);
    const card = listed.approvals[0]!;
    expect(card.action).toContain('Turn on the Plugin "Probe store"');
    expect(
      (
        await bot(sibling).readPluginEnablement({
          schemaVersion: 1,
          ...sibling,
        })
      ).enabled[STORE_PLUGIN_ID],
    ).toBeUndefined();

    // The person answers; the switch flips with the decision.
    const decided = await bot(sibling).decideApproval({
      schemaVersion: 1,
      ...sibling,
      approvalId: card.approvalId,
      command: { schemaVersion: 1, decision: "approved" },
    });
    expect(decided.status).toBe("recorded");
    expect(
      (
        await bot(sibling).readPluginEnablement({
          schemaVersion: 1,
          ...sibling,
        })
      ).enabled[STORE_PLUGIN_ID],
    ).toBe(true);
    // The answer opens the Bot's own Turn, with the Plugin already on in it,
    // so the Bot can say it is ready without the person having to ask.
    const delivery = await settledApprovalDelivery(sibling);
    expect(delivery.status).toBe("completed");
    expect(
      delivery.preparedInputs?.bot.enablement.enabled[STORE_PLUGIN_ID],
    ).toBe(true);

    // And from the next Turn the Plugin's tool answers.
    await bot(sibling).run({
      schemaVersion: 1,
      ...sibling,
      command: {
        runId: "use-1",
        sessionId: session,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: STORE_PLUGIN_ID,
            toolName: "store_roundtrip",
            input: { word: "approved" },
          }),
        ]),
      },
    });
    const answered = (await runEvents(sibling, "use-1")).find(
      (event) =>
        event.type === "tool/result" &&
        typeof event.content === "string" &&
        event.content.includes('"put"'),
    );
    expect(
      answered,
      "the Plugin's tool did not run after approval",
    ).toBeDefined();
  });

  test("a Plugin trigger reads a delivery at the webhook door and says what the Routine runs on", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const TRIGGER_PLUGIN_ID = "alerts";
    const TRIGGER_PLUGIN_SOURCE = `
export const tools = [
  { name: "alerts_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export const triggers = {
  inbound: async function (delivery, ctx) {
    const event = JSON.parse(delivery.body);
    return "Storm warning for " + event.city + " (signed " + delivery.headers["x-signature"] + ") for " + ctx.bot.botId;
  },
  refuse: async function () {
    return { drop: true, reason: "nothing in this delivery is for me" };
  },
};
export async function execute() {
  return "ok";
}
`;
    const descriptor = decodePluginDescriptorV1({
      id: TRIGGER_PLUGIN_ID,
      displayName: "Alerts",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "alerts_noop", description: "Does nothing", inputSchema: {} },
      ],
      hooks: [],
      grants: [],
      triggers: [
        { name: "inbound", description: "A delivery" },
        { name: "refuse", description: "A delivery it drops" },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(TRIGGER_PLUGIN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      TRIGGER_PLUGIN_SOURCE,
    );
    const createdAt = "2026-09-12T03:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: TRIGGER_PLUGIN_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: TRIGGER_PLUGIN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: TRIGGER_PLUGIN_SOURCE.length,
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
    await switchPlugin(identity, TRIGGER_PLUGIN_ID, true);

    const routine = async (routineId: string, trigger: string) => {
      const receipt = await bot(identity).executeRoutineCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          type: "routine/create",
          commandId: `create-${routineId}`,
          botId: identity.botId,
          routineId,
          name: `Routine ${routineId}`,
          prompt: "Tell the User what the alert means.",
          trigger: { kind: "plugin", pluginId: TRIGGER_PLUGIN_ID, trigger },
        },
      });
      expect(receipt.hook?.keyVersion, "a Plugin trigger is keyed").toBe(1);
      return receipt.hook!.token;
    };
    const deliver = async (token: string, body: string, key: string) => {
      const claims = await verifyRoutineHookTokenV1(
        env.ROUTINE_HOOK_SECRET,
        token,
      );
      return bot(identity).deliverRoutineHook({
        schemaVersion: 1,
        ...identity,
        delivery: {
          routineId: claims.r,
          keyVersion: claims.v,
          digest: await routineHookDigestV1(token),
          deliveryId: await routineDeliveryIdV1(claims.r, body, key),
          body,
          contentType: "application/json",
          headers: {
            "x-signature": "sig-1",
            "content-type": "application/json",
          },
        },
      });
    };

    const inbound = await routine("storms", "inbound");
    const fired = await deliver(inbound, '{"city":"Wollongong"}', "evt-1");
    expect(fired).toMatchObject({ status: "accepted" });
    // The firing carries what the Plugin said, never the raw body. It is read
    // from the run it admits: the Bot may take a firing off its queue the
    // moment it is accepted, so a read of the queue raced the Bot for it.
    const cues = async () =>
      [
        ...(
          await runInDurableObject(
            env.BOT_STATES.getByName(`${userId}:bot-1`),
            (_instance, state) =>
              state.storage.list<{
                input: string;
                admission?: { origin?: { routineId?: string } };
              }>({ prefix: "run:" }),
          )
        ).values(),
      ]
        .filter((run) => run.admission?.origin?.routineId === "storms")
        .map((run) => run.input);
    await runDurableObjectAlarm(env.BOT_STATES.getByName(`${userId}:bot-1`));
    await vi.waitFor(async () => expect(await cues()).toHaveLength(1), {
      timeout: 5_000,
      interval: 25,
    });
    const [cue] = await cues();
    expect(cue).toContain(
      "Storm warning for Wollongong (signed sig-1) for bot-1",
    );
    expect(cue).not.toContain('{"city":"Wollongong"}');
    // A replay answers with the firing, and asks the Plugin nothing twice.
    expect(await deliver(inbound, '{"city":"Wollongong"}', "evt-1")).toEqual({
      status: "duplicate",
      fireId: (fired as { fireId: string }).fireId,
    });

    const refusing = await routine("quiet", "refuse");
    expect(await deliver(refusing, "{}", "evt-2")).toEqual({
      status: "dropped",
      reason: "nothing in this delivery is for me",
    });

    // Off for this Bot, the Plugin sees nothing and the delivery is dropped.
    await switchPlugin(identity, TRIGGER_PLUGIN_ID, false);
    expect(await deliver(inbound, '{"city":"Sydney"}', "evt-3")).toMatchObject({
      status: "dropped",
      reason: expect.stringContaining("is off for this Bot"),
    });
  });

  test("the Turn reads the Plugin's sentence, and a second copy of one delivery joins the first", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    // The trigger dwells on every delivery, so a second copy of one event
    // reaches the door while the Plugin still holds the first. Three seconds
    // rather than one: the bound below is the dwell itself, and a CI runner
    // spends a few hundred milliseconds mounting the Plugin before the first
    // dwell begins, which a shorter dwell had no room for.
    const SLOW_PLUGIN_ID = "slow-alerts";
    const DWELL_MS = 3_000;
    const SLOW_PLUGIN_SOURCE = `
export const tools = [
  { name: "slow_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export const triggers = {
  slow: async function (delivery) {
    await new Promise((resolve) => setTimeout(resolve, ${DWELL_MS}));
    return "Storm over " + JSON.parse(delivery.body).city;
  },
};
export async function execute() {
  return "ok";
}
`;
    const descriptor = decodePluginDescriptorV1({
      id: SLOW_PLUGIN_ID,
      displayName: "Slow alerts",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "slow_noop", description: "Does nothing", inputSchema: {} },
      ],
      hooks: [],
      grants: [],
      triggers: [{ name: "slow", description: "A delivery it dwells on" }],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(SLOW_PLUGIN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      SLOW_PLUGIN_SOURCE,
    );
    const createdAt = "2026-09-12T04:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: SLOW_PLUGIN_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: SLOW_PLUGIN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: SLOW_PLUGIN_SOURCE.length,
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
    await switchPlugin(identity, SLOW_PLUGIN_ID, true);

    const routine = async (routineId: string) => {
      const receipt = await bot(identity).executeRoutineCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          type: "routine/create",
          commandId: `create-${routineId}`,
          botId: identity.botId,
          routineId,
          name: `Routine ${routineId}`,
          prompt: "Tell the User what the alert means.",
          trigger: {
            kind: "plugin",
            pluginId: SLOW_PLUGIN_ID,
            trigger: "slow",
          },
        },
      });
      return receipt.hook!.token;
    };
    const delivery = async (token: string, body: string, key: string) => {
      const claims = await verifyRoutineHookTokenV1(
        env.ROUTINE_HOOK_SECRET,
        token,
      );
      return {
        schemaVersion: 1,
        ...identity,
        delivery: {
          routineId: claims.r,
          keyVersion: claims.v,
          digest: await routineHookDigestV1(token),
          deliveryId: await routineDeliveryIdV1(claims.r, body, key),
          body,
          contentType: "application/json",
          headers: { "content-type": "application/json" },
        },
      };
    };
    // What the Turn was admitted with, for the Routine named: the cue the
    // model reads, which is where the Plugin's answer has to turn up.
    const cuesFor = async (routineId: string) =>
      [
        ...(
          await runInDurableObject(
            env.BOT_STATES.getByName(`${userId}:bot-1`),
            (_instance, state) =>
              state.storage.list<{
                input: string;
                admission?: { origin?: { routineId?: string } };
              }>({ prefix: "run:" }),
          )
        ).values(),
      ]
        .filter((run) => run.admission?.origin?.routineId === routineId)
        .map((run) => run.input);

    // Two copies of one delivery, both at the door while the Plugin dwells.
    const twice = await routine("twice");
    const copy = await delivery(twice, '{"city":"Wollongong"}', "evt-1");
    const [first, second] = await Promise.all([
      bot(identity).deliverRoutineHook(copy),
      (async () => {
        // Halfway into the dwell: late enough that the first copy is inside
        // the Plugin even on a slow runner, early enough that a copy which
        // joined it finishes well inside a dwell of its own.
        await new Promise((resolve) => setTimeout(resolve, DWELL_MS / 2));
        const startedAt = Date.now();
        const receipt = await bot(identity).deliverRoutineHook(copy);
        return { receipt, elapsedMs: Date.now() - startedAt };
      })(),
    ]);
    expect(first).toMatchObject({ status: "accepted" });
    expect(second.receipt).toEqual({
      status: "duplicate",
      fireId: (first as { fireId: string }).fireId,
    });
    // It answered sooner than an ask of its own could have: the second copy
    // joined the delivery already inside the Plugin instead of handing the
    // Plugin the same event twice.
    expect(
      second.elapsedMs,
      "the second copy waited out a dwell of its own, so the Plugin was asked twice",
    ).toBeLessThan(DWELL_MS);

    // The one firing those copies made runs a Turn, and its cue is what the
    // Plugin said — never the body the Plugin read.
    await runDurableObjectAlarm(env.BOT_STATES.getByName(`${userId}:bot-1`));
    await vi.waitFor(
      async () => expect(await cuesFor("twice")).toHaveLength(1),
      { timeout: 5_000, interval: 25 },
    );
    const [cue] = await cuesFor("twice");
    expect(cue).toContain("Storm over Wollongong");
    expect(cue).not.toContain('{"city":"Wollongong"}');
  });

  test("a Plugin that fails three Turns in a row is noticed each time and then turned off for this Bot", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const FLAKY_ID = "flaky";
    const FLAKY_SOURCE = `
export const tools = [
  { name: "flaky_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export const hooks = {
  "agent/tool-exposure": async function () {
    throw new Error("the flaky hook exploded");
  },
};
export async function execute() {
  return "ok";
}
`;
    const descriptor = decodePluginDescriptorV1({
      id: FLAKY_ID,
      displayName: "Flaky",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "flaky_noop", description: "Does nothing", inputSchema: {} },
      ],
      hooks: ["agent/tool-exposure"],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(FLAKY_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      FLAKY_SOURCE,
    );
    const createdAt = "2026-09-12T04:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: FLAKY_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: FLAKY_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: FLAKY_SOURCE.length,
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
    await switchPlugin(identity, FLAKY_ID, true);

    const enabledFlag = async () =>
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled[FLAKY_ID];
    const notices = async () =>
      (
        await bot(identity).listNotifications({ schemaVersion: 1, ...identity })
      ).map((notice) => notice.title);

    // Two failing Turns: skipped, noticed, still on.
    await turn(identity, "run-1");
    await turn(identity, "run-2");
    expect(await enabledFlag()).toBe(true);
    expect(
      (await notices()).filter((title) => title === "A plugin was skipped"),
    ).toHaveLength(2);
    expect(await notices()).not.toContain("A plugin was turned off");

    // The third turns it off for this Bot, and says so.
    await turn(identity, "run-3");
    expect(await enabledFlag()).toBe(false);
    expect(await notices()).toContain("A plugin was turned off");
    const page = await bot(identity).readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    const row = page.plugins.find(
      (candidate) => candidate.pluginId === FLAKY_ID,
    ) as { on: boolean; quarantined?: string } | undefined;
    expect(row).toMatchObject({ on: false });
    expect(row?.quarantined).toContain("Turned off after 3 Turns in a row");

    // A Turn with it off raises nothing new; switching it on clears the history.
    await turn(identity, "run-4");
    expect(
      (await notices()).filter((title) => title === "A plugin was skipped"),
    ).toHaveLength(3);
    await switchPlugin(identity, FLAKY_ID, true);
    const again = await bot(identity).readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    expect(
      (
        again.plugins.find((candidate) => candidate.pluginId === FLAKY_ID) as {
          quarantined?: string;
        }
      ).quarantined,
    ).toBeUndefined();
  });
  test("a theme document the kernel refuses is noticed with its reason and counts toward turning the Plugin off", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const DUSK_ID = "dusk";
    // Text the colour of its own window: 1:1, far under the 4.5:1 floor.
    const DUSK_SOURCE = `
export const tools = [];
export const hooks = {
  "theme/assemble": async function (payload) {
    const tokens = payload.document.tokens;
    return {
      ...payload.document,
      tokens: { ...tokens, surfaces: { ...tokens.surfaces, text: tokens.surfaces.window } },
    };
  },
};
export async function execute() {
  return "ok";
}
`;
    await seedPlugin(
      identity,
      bootstrap.generationId,
      "2026-09-12T05:00:00.000Z",
      DUSK_ID,
      DUSK_SOURCE,
      decodePluginDescriptorV1({
        id: DUSK_ID,
        displayName: "Dusk",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [],
        hooks: ["theme/assemble"],
        grants: [],
        contextKeys: ["user", "bot", "session"],
      }),
    );
    await switchPlugin(identity, DUSK_ID, true);
    const enabled = async () =>
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled[DUSK_ID];
    const notices = async () =>
      await bot(identity).listNotifications({ schemaVersion: 1, ...identity });

    await bot(identity).assembleTheme({ schemaVersion: 1, ...identity });
    const refused = (await notices()).find(
      (notice) => notice.title === "A plugin could not set this Bot's theme",
    );
    // The person reads which Plugin and why, not a silent skip.
    expect(refused?.body).toContain(
      'The plugin "dusk" could not set this Bot\'s theme',
    );
    expect(refused?.body).toContain("contrast");

    // Switching it on assembles in the background too, so the third refusal
    // may land before the third call; either way it ends off.
    for (let call = 0; call < 3 && (await enabled()); call += 1) {
      await bot(identity).assembleTheme({ schemaVersion: 1, ...identity });
    }
    expect(await enabled()).toBe(false);
    expect((await notices()).map((notice) => notice.body)).toContain(
      'The plugin "dusk" failed to set this Bot\'s theme 3 times in a row and is now off for this Bot. Turn it on again under Plugins to try it once more.',
    );
  });

  test("approving a theme Plugin re-assembles the look through the Bot's own alarm, not at the next hour", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const author = { userId, botId: "bot-1" };
    const sibling = { userId, botId: "bot-2" };
    await provisionBot(author);
    await provisionSiblingBot(sibling);
    await features(userId).setFeatures({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/set-features",
        pluginAuthoring: true,
      },
      updatedBy: "test",
    });
    await turn(author, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const CANARY_ID = "canary";
    const CANARY_SOURCE = `
export const tools = [];
export const hooks = {
  "theme/assemble": async function (payload) {
    const tokens = payload.document.tokens;
    return {
      ...payload.document,
      tokens: { ...tokens, surfaces: {
        window: "#ffef00", surface: "#fff7a8", raised: "#fffbd0",
        text: "#1a1a1a", muted: "#4d4a00", line: "#c9bd00",
        accent: "#1a1a1a", onAccent: "#ffef00",
      } },
    };
  },
};
export async function execute() {
  return "ok";
}
`;
    await seedPlugin(
      author,
      bootstrap.generationId,
      "2026-09-12T06:00:00.000Z",
      CANARY_ID,
      CANARY_SOURCE,
      decodePluginDescriptorV1({
        id: CANARY_ID,
        displayName: "Canary",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [],
        hooks: ["theme/assemble"],
        grants: [],
        contextKeys: ["user", "bot", "session"],
      }),
    );
    const window = async () =>
      (await bot(sibling).readLook({ schemaVersion: 1, ...sibling })).document
        ?.tokens.surfaces.window;
    expect(await window()).not.toBe("#ffef00");

    await bot(sibling).run({
      schemaVersion: 1,
      ...sibling,
      command: {
        runId: "ask-1",
        sessionId: `${userId}:bot-2`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: "frockbot",
            toolName: "plugin_enable",
            input: { pluginId: CANARY_ID },
          }),
        ]),
      },
    });
    const [card] = (
      await bot(sibling).listApprovals({ schemaVersion: 1, ...sibling })
    ).approvals;
    await bot(sibling).decideApproval({
      schemaVersion: 1,
      ...sibling,
      approvalId: card!.approvalId,
      command: { schemaVersion: 1, decision: "approved" },
    });

    // Nothing calls assembleTheme: the approval owes one, and the alarms
    // that settle its delivery Turn run it instead of waiting for the hour.
    await settledApprovalDelivery(sibling);
    await vi.waitFor(async () => expect(await window()).toBe("#ffef00"), {
      timeout: 5_000,
      interval: 25,
    });
  });

  test("a theme Plugin's tool writing its storage re-assembles the look when the Turn settles", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const PAINT_ID = "paint";
    // Bob's shape: the tool stores the colour, the hook reads it back.
    const PAINT_SOURCE = `
export const tools = [
  { name: "paint_set", description: "Stores the window colour", inputSchema: { type: "object" }, idempotent: false },
];
export const hooks = {
  "theme/assemble": async function (payload, ctx) {
    const stored = await ctx.storage.get({ key: "window" });
    if (typeof stored.value !== "string") return payload.document;
    const tokens = payload.document.tokens;
    return {
      ...payload.document,
      tokens: { ...tokens, surfaces: {
        window: stored.value, surface: "#fff7a8", raised: "#fffbd0",
        text: "#1a1a1a", muted: "#4d4a00", line: "#c9bd00",
        accent: "#1a1a1a", onAccent: "#ffef00",
      } },
    };
  },
};
export async function execute(tool, input, ctx) {
  await ctx.storage.put({ key: "window", value: input.window });
  return "Set.";
}
`;
    await seedPlugin(
      identity,
      bootstrap.generationId,
      "2026-09-12T07:00:00.000Z",
      PAINT_ID,
      PAINT_SOURCE,
      decodePluginDescriptorV1({
        id: PAINT_ID,
        displayName: "Paint",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [
          {
            name: "paint_set",
            description: "Stores the window colour",
            inputSchema: { type: "object" },
          },
        ],
        hooks: ["theme/assemble"],
        grants: ["storage"],
        contextKeys: ["user", "bot", "session"],
      }),
    );
    await switchPlugin(identity, PAINT_ID, true);
    const window = async () =>
      (await bot(identity).readLook({ schemaVersion: 1, ...identity })).document
        ?.tokens.surfaces.window;
    // Let the assemble the switch owed settle before the Turn writes.
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(
            env.BOT_STATES.getByName(`${userId}:bot-1`),
            (_instance, state) =>
              state.storage.get<number>(THEME_ASSEMBLE_DUE_KEY_V1),
          ),
        ).toBeGreaterThan(Date.now()),
      { timeout: 5_000, interval: 25 },
    );
    expect(await window()).not.toBe("#ffef00");

    await bot(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: "paint-1",
        sessionId: `${userId}:bot-1`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: PAINT_ID,
            toolName: "paint_set",
            input: { window: "#ffef00" },
          }),
        ]),
      },
    });

    // Nothing calls assembleTheme: the write owed one, and the alarm the
    // settled Turn re-armed runs it rather than the next hour.
    await vi.waitFor(async () => expect(await window()).toBe("#ffef00"), {
      timeout: 5_000,
      interval: 25,
    });
  });

  /**
   * Seeds one Plugin as the current pinned generation of `userId`, and
   * answers the generation id so the next proposal can parent itself on it.
   */
  async function seedPlugin(
    identity: { userId: string; botId: string },
    parentGenerationId: string,
    createdAt: string,
    pluginId: string,
    source: string,
    descriptor: ReturnType<typeof decodePluginDescriptorV1>,
  ): Promise<string> {
    const contentHash = await sha256Hex(source);
    await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, source);
    // What the User's Composition already carries, minus any earlier
    // generation of this same probe Plugin. A proposal that dropped the
    // deployment's seeded members would be re-seeded by the next
    // `readComposition`, moving the pin out from under the generation this
    // helper just returned.
    const existing = (
      await user(identity.userId).readComposition({
        schemaVersion: 1,
        userId: identity.userId,
      })
    ).current.members as CompositionMemberV1[];
    const members: CompositionMemberV1[] = [
      ...existing.filter((member) => member.packageId !== pluginId),
      {
        packageId: pluginId,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: pluginId,
          version: "0.0.1",
          botId: identity.botId,
          sessionId: `${identity.userId}:${identity.botId}`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: source.length,
          mediaType: "application/javascript",
          bundlerVersion: "probe-seed",
        },
      },
    ];
    const artifactSetHash = await compositionArtifactSetHashV1(members);
    const generationId = compositionGenerationIdV1(createdAt, artifactSetHash);
    await user(identity.userId).proposeComposition({
      schemaVersion: 1,
      userId: identity.userId,
      generation: {
        schemaVersion: 1,
        generationId,
        artifactSetHash,
        parentGenerationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "run-0",
          sessionId: `${identity.userId}:${identity.botId}`,
          turnId: "run-0",
        },
        members,
        status: "pending",
      },
      pin: true,
      expectedCurrentGenerationId: parentGenerationId,
    });
    return generationId;
  }

  const NOOP_SOURCE = `
export const tools = [
  { name: "steady_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export async function execute() {
  return "ok";
}
`;
  const THROWING_SOURCE = `
export const tools = [
  { name: "steady_noop", description: "Does nothing", inputSchema: {}, idempotent: true },
];
export const hooks = {
  "agent/tool-exposure": async function () {
    throw new Error("the hook exploded");
  },
};
export async function execute() {
  return "ok";
}
`;
  const steadyDescriptor = (contractVersion: number, hooks: string[]) =>
    decodePluginDescriptorV1({
      id: "steady",
      displayName: "Steady",
      version: "0.0.1",
      contractVersion,
      tools: [
        { name: "steady_noop", description: "Does nothing", inputSchema: {} },
      ],
      hooks,
      grants: [],
      contextKeys: ["user", "bot", "session"],
    });

  test("a Plugin built against a retired contract is refused at resolve, noticed, and turned off at three", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    await seedPlugin(
      identity,
      bootstrap.generationId,
      "2026-09-12T05:00:00.000Z",
      "steady",
      NOOP_SOURCE,
      // A literal on purpose: this Plugin must sit outside the contract
      // window the host serves, or the refusal under test stops happening.
      steadyDescriptor(2, []),
    );
    await switchPlugin(identity, "steady", true);

    const enabledFlag = async () =>
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled.steady;
    const notices = async () =>
      await bot(identity).listNotifications({ schemaVersion: 1, ...identity });

    await turn(identity, "run-1");
    const skipped = (await notices()).filter(
      (notice) => notice.title === "A plugin was skipped",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.body).toContain("could not be admitted");
    expect(skipped[0]?.body).toContain("no longer serves");
    expect(await enabledFlag()).toBe(true);

    await turn(identity, "run-2");
    expect(await enabledFlag()).toBe(true);
    await turn(identity, "run-3");
    expect(await enabledFlag()).toBe(false);
    expect((await notices()).map((notice) => notice.title)).toContain(
      "A plugin was turned off",
    );
    const page = await bot(identity).readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    const row = page.plugins.find(
      (candidate) => candidate.pluginId === "steady",
    ) as { on: boolean; quarantined?: string } | undefined;
    expect(row).toMatchObject({ on: false });
    expect(row?.quarantined).toContain("Turned off after 3 Turns in a row");
  });

  test("a Turn the Plugin ran clean settles its record, so failing Turns must be in a row to turn it off", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const broken = await seedPlugin(
      identity,
      bootstrap.generationId,
      "2026-09-12T06:00:00.000Z",
      "steady",
      THROWING_SOURCE,
      steadyDescriptor(ISOLATE_CONTRACT_VERSION, ["agent/tool-exposure"]),
    );
    await switchPlugin(identity, "steady", true);

    const enabledFlag = async () =>
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled.steady;

    // Two failing Turns, then a Turn the Plugin runs clean, then two more
    // failing Turns: five failing-or-not Turns, never three in a row.
    await turn(identity, "run-1");
    await turn(identity, "run-2");
    expect(await enabledFlag()).toBe(true);
    const healed = await seedPlugin(
      identity,
      broken,
      "2026-09-12T06:10:00.000Z",
      "steady",
      NOOP_SOURCE,
      steadyDescriptor(ISOLATE_CONTRACT_VERSION, []),
    );
    await turn(identity, "run-3");
    await seedPlugin(
      identity,
      healed,
      "2026-09-12T06:20:00.000Z",
      "steady",
      THROWING_SOURCE,
      steadyDescriptor(ISOLATE_CONTRACT_VERSION, ["agent/tool-exposure"]),
    );
    await turn(identity, "run-4");
    await turn(identity, "run-5");
    expect(await enabledFlag()).toBe(true);
    const page = await bot(identity).readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    expect(
      page.plugins.find((candidate) => candidate.pluginId === "steady"),
    ).toMatchObject({ on: true });
  });

  test("a Plugin's settings section is drawn on the Bot's page, and its control runs the tool it names", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const COUNTER_ID = "counter";
    const COUNTER_SOURCE = `
export const tools = [
  { name: "counter_bump", description: "Adds one", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "counter_bump") return "unknown tool";
  const got = await ctx.storage.get({ key: "count" });
  const next = (typeof got.value === "number" ? got.value : 0) + (input.by ?? 1);
  await ctx.storage.put({ key: "count", value: next });
  return "count is " + next;
}
export const views = {
  "counter.settings": async function (ctx) {
    const got = await ctx.storage.get({ key: "count" });
    const count = typeof got.value === "number" ? got.value : 0;
    return {
      root: {
        type: "group",
        orientation: "column",
        children: [
          { type: "text", text: "Count: " + count + " for " + ctx.bot.botId },
          { type: "action", actionId: "counter_bump", label: "Add two", input: { by: 2 } },
          { type: "field", field: { id: "nope", label: "nope", kind: "text" } },
        ],
      },
    };
  },
};
`;
    const descriptor = decodePluginDescriptorV1({
      id: COUNTER_ID,
      displayName: "Counter",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "counter_bump", description: "Adds one", inputSchema: {} },
      ],
      hooks: [],
      grants: ["storage"],
      views: [{ slot: "settings.sections", surfaceId: "counter.settings" }],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(COUNTER_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      COUNTER_SOURCE,
    );
    const createdAt = "2026-09-12T05:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: COUNTER_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: COUNTER_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: COUNTER_SOURCE.length,
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

    const row = async () =>
      (
        await bot(identity).readBotPluginsFrame({
          schemaVersion: 1,
          ...identity,
        })
      ).plugins.find((candidate) => candidate.pluginId === COUNTER_ID);
    const press = (by: number, commandId: string) =>
      bot(identity).executeBotPluginTool({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "plugin-tool",
          commandId,
          pluginId: COUNTER_ID,
          tool: "counter_bump",
          arguments: JSON.stringify({ by }),
        },
      });

    // Off, the Plugin draws nothing and its control is refused.
    expect((await row())?.sections).toBeUndefined();
    expect(await press(2, "press-0")).toEqual({
      status: "rejected",
      failure: '"Counter" is off for this Bot',
    });

    // On, the section is the Plugin's tree minus what a section cannot hold.
    await switchPlugin(identity, COUNTER_ID, true);
    const before = (await row())?.sections;
    expect(before).toHaveLength(1);
    expect(before?.[0]?.failure).toMatch(/cannot hold a field node/);

    // The control runs the tool outside any Turn, through the same loopback.
    expect(await press(2, "press-1")).toEqual({
      status: "ran",
      content: "count is 2",
      isError: false,
    });
    expect(await press(3, "press-2")).toMatchObject({ content: "count is 5" });
    expect(
      await bot(identity).executeBotPluginTool({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "plugin-tool",
          commandId: "press-3",
          pluginId: COUNTER_ID,
          tool: "counter_other",
          arguments: "",
        },
      }),
    ).toEqual({
      status: "rejected",
      failure: '"Counter" has no "counter_other" control',
    });
  });

  test("a Plugin's panel page is its stored page's URL and its view's state, and a tool it calls moves that state", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const SCORE_ID = "score";
    const SCORE_SOURCE = `
export const tools = [
  { name: "score_add", description: "Adds one", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  const got = await ctx.storage.get({ key: "score" });
  const next = (typeof got.value === "number" ? got.value : 0) + 1;
  await ctx.storage.put({ key: "score", value: next });
  return "score is " + next;
}
export const views = {
  score: async function (ctx) {
    const got = await ctx.storage.get({ key: "score" });
    return { score: typeof got.value === "number" ? got.value : 0, bot: ctx.bot.botId };
  },
};
`;
    const PAGE = withPluginPageBridgeV1(
      "<!doctype html><html><head></head><body>score</body></html>",
    );
    const descriptor = decodePluginDescriptorV1({
      id: SCORE_ID,
      displayName: "Score",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [{ name: "score_add", description: "Adds one", inputSchema: {} }],
      hooks: [],
      grants: ["storage"],
      views: [
        { slot: "conversation.panel", surfaceId: "score", page: "score.html" },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(SCORE_SOURCE);
    const pageHash = await sha256Hex(PAGE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      SCORE_SOURCE,
    );
    await env.APPLICATION_ARTIFACTS.put(pluginPageKeyV1(pageHash), PAGE);
    const createdAt = "2026-09-24T05:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: SCORE_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: SCORE_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: SCORE_SOURCE.length,
          mediaType: "application/javascript",
          bundlerVersion: "probe-seed",
        },
        pages: [
          { path: "score.html", contentHash: pageHash, size: PAGE.length },
        ],
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
    await switchPlugin(identity, SCORE_ID, true);
    expect(
      await bot(identity).setFocusedPanel({
        schemaVersion: 1,
        ...identity,
        pluginId: SCORE_ID,
        surfaceId: "score",
      }),
    ).toMatchObject({ status: "applied" });

    const ORIGIN = "https://bot.example.com";
    const open = () =>
      bot(identity).openFocusedPanel({
        schemaVersion: 1,
        ...identity,
        appOrigin: ORIGIN,
      });
    // The page, where the app serves it, with the state its view returned for
    // this Bot — and no document beside it.
    const first = await open();
    expect(first.page).toEqual({
      url: `${ORIGIN}/plugin-pages/${pageHash}.html`,
      state: { score: 0, bot: "bot-1" },
    });
    expect(first.document).toBeUndefined();
    expect(first.failure).toBeUndefined();

    // The Worker serves those bytes to anyone who names them, sandboxed.
    const context = createExecutionContext();
    const served = await worker.fetch(
      new Request(first.page!.url),
      env as unknown as Parameters<typeof worker.fetch>[1],
      context,
    );
    await waitOnExecutionContext(context);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(PAGE);
    expect(served.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts;/,
    );

    // A tool the page calls runs outside any Turn, and the next read hands the
    // page what it left behind.
    expect(
      await bot(identity).executeBotPluginTool({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "plugin-tool",
          commandId: "page-press-1",
          pluginId: SCORE_ID,
          tool: "score_add",
          arguments: "{}",
        },
      }),
    ).toEqual({ status: "ran", content: "score is 1", isError: false });
    expect((await open()).page?.state).toEqual({
      score: 1,
      bot: "bot-1",
    });
  });

  // ADR 0036: a page's use of the microphone, reported by the client that
  // opened it, is one row in the User's audit, and a rebuild keeps it.
  test("a page's microphone use is one audit row the User reads, and a rebuild keeps it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const STROBE_ID = "strobe";
    const SOURCE = `export const tools = [];
export async function execute() {
  throw new Error("no tools");
}
export const views = { strobe: async () => ({}) };
`;
    const PAGE = withPluginPageBridgeV1(
      "<!doctype html><html><head></head><body>strobe</body></html>",
    );
    const descriptor = decodePluginDescriptorV1({
      id: STROBE_ID,
      displayName: "Strobe",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [],
      hooks: [],
      grants: ["device"],
      device: { abilities: ["microphone"] },
      views: [
        {
          slot: "conversation.panel",
          surfaceId: "strobe",
          page: "strobe.html",
        },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(SOURCE);
    const pageHash = await sha256Hex(PAGE);
    await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, SOURCE);
    await env.APPLICATION_ARTIFACTS.put(pluginPageKeyV1(pageHash), PAGE);
    const createdAt = "2026-09-24T05:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: STROBE_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: STROBE_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: SOURCE.length,
          mediaType: "application/javascript",
          bundlerVersion: "probe-seed",
        },
        pages: [
          { path: "strobe.html", contentHash: pageHash, size: PAGE.length },
        ],
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
    await switchPlugin(identity, STROBE_ID, true);

    const use = {
      useId: "nAbCdEf_1234",
      pluginId: STROBE_ID,
      surfaceId: "strobe",
      ability: "microphone",
      device: "web",
      startedAt: "2026-09-24T05:00:00.000Z",
      endedAt: "2026-09-24T05:02:14.000Z",
      ending: "stopped",
    };
    const record = (reported: Record<string, unknown>) =>
      bot(identity).recordPanelDeviceUse({
        schemaVersion: 1,
        ...identity,
        use: reported,
      });
    expect(await record(use)).toEqual({ status: "recorded" });
    // A client that retries is still one use.
    expect(await record(use)).toEqual({ status: "recorded" });
    expect(
      await record({ ...use, useId: "nOtHeR_5678", surfaceId: "nope" }),
    ).toEqual({ status: "refused", reason: '"strobe" has no page "nope".' });

    const read = () =>
      audit(userId).readAuditEntries({
        schemaVersion: 1,
        userId,
        kind: "device",
      });
    const recorded = await read();
    expect(recorded.entries).toHaveLength(1);
    expect(recorded.entries[0]).toMatchObject({
      botId: "bot-1",
      kind: "device",
      target: "device:web",
      toolName: "microphone",
      preview: "Strobe used the microphone",
      outcome: "ok",
      durationMs: 134_000,
      turn: 0,
    });

    // No run holds it, and a rebuild still reproduces it from the Bot.
    expect(
      await audit(userId).rebuildAuditIndex({ schemaVersion: 1, userId }),
    ).toMatchObject({ status: "rebuilt" });
    expect((await read()).entries).toEqual(recorded.entries);
  });

  // ADR 0030 step 6: a Plugin that declares a card is offered one tool per
  // card, the kernel mints the surface and records the Approval the card asks
  // for, and a press the renderer names `plugin/<id>/<action>` reaches the
  // Plugin's own handler and redraws the card without costing a Turn.
  test("a Plugin's card tool draws a surface, mints its Approval, and its own action redraws it", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");

    const CARD_PLUGIN_ID = "probe-card";
    const CARD_PLUGIN_SOURCE = `
export const tools = [];
export async function execute(tool) {
  throw new Error("unknown tool " + tool);
}
function detail(subject, expanded) {
  return [
    {
      id: "rows",
      component: "KeyValueRows",
      rows: expanded
        ? [{ label: "Subject", value: subject }, { label: "Detail", value: "everything" }]
        : [{ label: "Subject", value: subject }],
    },
    {
      id: "more",
      component: "Button",
      label: "More",
      action: {
        event: { name: "plugin/probe-card/details", context: { expanded: true } },
      },
    },
  ];
}
function components(subject, expanded) {
  return [
    { id: "root", component: "Column", children: ["rows", "more", "actions"] },
    ...detail(subject, expanded),
    {
      id: "actions",
      component: "ApprovalActions",
      approvalId: "not-the-kernels",
      approveLabel: "Send",
      declineLabel: "Discard",
    },
  ];
}
export const cards = {
  draft: {
    render: async function (payload, ctx) {
      await ctx.storage.put({ key: "subject:" + payload.surfaceId, value: payload.data.subject });
      return {
        messages: [
          {
            version: "v1.0",
            createSurface: {
              surfaceId: payload.surfaceId,
              components: components(payload.data.subject, false),
            },
          },
        ],
        // What the decision this card asks for covers, and what it asks, in
        // the Plugin's own words. A draw that asks for one and names neither
        // is refused.
        covers: { subject: payload.data.subject },
        decision: { action: "Send the draft", risk: "medium" },
      };
    },
    actions: {
      details: async function (press, ctx) {
        const stored = await ctx.storage.get({ key: "subject:" + press.surfaceId });
        return {
          messages: [
            {
              version: "v1.0",
              updateComponents: {
                surfaceId: press.surfaceId,
                components: detail(String(stored.value), press.context.expanded === true),
              },
            },
          ],
          input: "The person opened the draft's details.",
        };
      },
      escalate: async function (press) {
        return [
          {
            version: "v1.0",
            updateComponents: {
              surfaceId: press.surfaceId,
              components: [
                {
                  id: "actions",
                  component: "ApprovalActions",
                  approvalId: "minted-by-the-plugin",
                  approveLabel: "Send",
                  declineLabel: "Discard",
                },
              ],
            },
          },
        ];
      },
      refuse: async function () {
        return { drop: true, reason: "this draft has already settled" };
      },
    },
  },
};
`;
    const descriptor = decodePluginDescriptorV1({
      id: CARD_PLUGIN_ID,
      displayName: "Card probe",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [],
      hooks: [],
      grants: ["storage"],
      cards: [
        {
          id: "draft",
          displayName: "Draft",
          description: "Shows a draft and asks the person to decide.",
          dataSchema: {
            type: "object",
            properties: { subject: { type: "string" } },
            required: ["subject"],
            additionalProperties: false,
          },
          actions: [
            { name: "details", description: "Show the rest." },
            { name: "escalate", description: "Ask for a decision." },
            { name: "refuse", description: "Decline the press on purpose." },
          ],
        },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    await pinGeneration(userId, [
      {
        id: CARD_PLUGIN_ID,
        source: CARD_PLUGIN_SOURCE,
        descriptor,
      },
    ]);
    await switchPlugin(identity, CARD_PLUGIN_ID, true);

    // The Bot calls the card's own tool with the values, and nothing else.
    await callPluginToolRaw(
      identity,
      "run-card-1",
      CARD_PLUGIN_ID,
      "probe_card_draft",
      { data: { subject: "Hello" } },
    );

    const listed = await bot(identity).listCards({
      schemaVersion: 1,
      ...identity,
    });
    expect(listed.cards).toHaveLength(1);
    const card = listed.cards[0]!;
    // The kernel minted the surface, so the Plugin never named one.
    expect(card.surfaceId.startsWith(`${CARD_PLUGIN_ID}_draft.`)).toBe(true);
    const actions = card.components.find((part) => part.id === "actions")!;
    // Trust chrome is bound to an id only the kernel issues: whatever the
    // Plugin wrote is gone.
    expect(actions.approvalId).not.toBe("not-the-kernels");
    expect(String(actions.approvalId)).toMatch(/^card-approval-/);

    // And the Approval behind it is a real one, recorded on this Turn.
    const approvals = await bot(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(
      approvals.approvals.map((approval) => approval.approvalId),
    ).toContain(actions.approvalId);

    // A press the renderer named for this Plugin reaches its handler, which
    // redraws the card in place. The revision moves; no Turn was spent.
    const pressed = await bot(identity).cardAction({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        surfaceId: card.surfaceId,
        revision: card.revision,
        commandId: "press-1",
        event: {
          name: `plugin/${CARD_PLUGIN_ID}/details`,
          context: { expanded: true },
        },
      },
    });
    expect(pressed.failure).toBeUndefined();
    expect(pressed.routed).toBe("plugin");
    expect(pressed.card.revision).toBeGreaterThan(card.revision);
    expect(
      (
        pressed.card.components.find((part) => part.id === "rows")?.rows as
          unknown[] | undefined
      )?.length,
    ).toBe(2);
    // A press redraws what it was about and leaves the trust chrome alone:
    // the Approval the kernel bound when the card was sent is still the one
    // the decision is read under, so the card can still be decided.
    expect(
      pressed.card.components.find((part) => part.id === "actions")?.approvalId,
    ).toBe(actions.approvalId);

    // The line the handler left for the Bot is waiting as durable input.
    const pending = await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:bot-1`),
      (_instance, state) =>
        state.storage.list<{ kind?: string; context?: string }>({
          prefix: "routine-wake:",
        }),
    );
    expect(
      [...pending.values()].some(
        (input) =>
          input.kind === "card-action" &&
          input.context === "The person opened the draft's details.",
      ),
    ).toBe(true);
    // And it opened no Turn: the handler answered the press on the card, so
    // its line rides the Bot's next Turn rather than spending one of its own.
    expect(
      await runInDurableObject(
        env.BOT_STATES.getByName(`${userId}:bot-1`),
        async (_instance, state) =>
          (
            await hydratedStoredRunsV1<{
              runId: string;
              sessionId: string;
              admission?: { origin?: { kind: string } };
            }>(state.storage)
          ).filter((run) => run.admission?.origin?.kind === "input-delivery"),
      ),
    ).toEqual([]);

    const press = async (name: string, revision: number) =>
      bot(identity).cardAction({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          surfaceId: card.surfaceId,
          revision,
          commandId: crypto.randomUUID(),
          event: { name, context: { expanded: true } },
        },
      });

    // A press routed to a Plugin that did not mint this surface never reaches
    // a handler: the surface id's prefix is what says whose card this is.
    const strangers = await press(
      `plugin/${STORE_PLUGIN_ID}/details`,
      pressed.card.revision,
    );
    expect(strangers.failure).toMatch(/is not a surface plugin/);
    expect(strangers.card.revision).toBe(pressed.card.revision);

    // A press runs outside a Turn, so it can record no Approval. A handler
    // that answered with trust chrome is refused whole and the Card stands.
    const escalated = await press(
      `plugin/${CARD_PLUGIN_ID}/escalate`,
      pressed.card.revision,
    );
    expect(escalated.failure).toMatch(/may not ask for a decision/);
    expect(escalated.card.revision).toBe(pressed.card.revision);
    expect(
      escalated.card.components.find((part) => part.id === "actions")
        ?.approvalId,
    ).toBe(actions.approvalId);

    // A handler that refuses in as many words is not a handler that broke:
    // past the quarantine threshold of deliberate drops, the Plugin still
    // runs the next press.
    for (let index = 0; index < 4; index += 1) {
      const dropped = await press(
        `plugin/${CARD_PLUGIN_ID}/refuse`,
        pressed.card.revision,
      );
      expect(dropped.failure).toMatch(/already settled/);
    }
    const stillRunning = await press(
      `plugin/${CARD_PLUGIN_ID}/details`,
      pressed.card.revision,
    );
    expect(stillRunning.failure).toBeUndefined();

    // A press id is the client's own command id, whatever length the seam
    // admits. A record the inbox's own decoder refuses would wedge every
    // later drain, so the id a press writes stays inside what it reads.
    const longCommandId = "c".repeat(128);
    const longPress = await bot(identity).cardAction({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        surfaceId: card.surfaceId,
        revision: stillRunning.card.revision,
        commandId: longCommandId,
        event: {
          name: `plugin/${CARD_PLUGIN_ID}/details`,
          context: { expanded: true },
        },
      },
    });
    expect(longPress.failure).toBeUndefined();
    const queued = await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:bot-1`),
      (_instance, state) =>
        state.storage.list<unknown>({ prefix: "routine-wake:" }),
    );
    for (const record of queued.values()) {
      expect(() => decodePendingBotInputV1(record)).not.toThrow();
    }

    // A card tool whose values do not fit the declared schema draws nothing.
    const refused = await callPluginToolRaw(
      identity,
      "run-card-2",
      CARD_PLUGIN_ID,
      "probe_card_draft",
      { data: { subject: 7 } },
    );
    expect(refused).toMatch(/refused/);
    expect(
      (await bot(identity).listCards({ schemaVersion: 1, ...identity })).cards,
    ).toHaveLength(1);
  });

  // ADR 0030, amended 2026-09-24: a card whose fields the person edits is
  // decided about what they left there. The Plugin restates the edit, and the
  // kernel moves the decision's binding onto it in the transaction that
  // records the decision — so a capability claiming it later is held to what
  // the person sent, not to the draft they changed.
  test("a person's edit to a Plugin's card is what their Send decides", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");

    const EDIT_PLUGIN_ID = "probe-edit";
    const EDIT_PLUGIN_SOURCE = `
export const tools = [];
export async function execute(tool) {
  throw new Error("unknown tool " + tool);
}
function drawn(surfaceId, subject) {
  return [
    {
      version: "v1.0",
      createSurface: {
        surfaceId,
        sendDataModel: true,
        dataModel: { subject },
        components: [
          { id: "root", component: "Column", children: ["subject", "actions"] },
          { id: "subject", component: "TextField", label: "Subject", value: { path: "/subject" } },
          { id: "actions", component: "ApprovalActions", approvalId: "pending", approveLabel: "Send", declineLabel: "Discard" },
        ],
      },
    },
  ];
}
export const cards = {
  draft: {
    render: async function (payload, ctx) {
      await ctx.storage.put({ key: "subject:" + payload.surfaceId, value: payload.data.subject });
      return {
        messages: drawn(payload.surfaceId, payload.data.subject),
        covers: { subject: payload.data.subject },
        decision: { action: "Send: " + payload.data.subject, risk: "medium" },
      };
    },
    revise: async function (edit, ctx) {
      const subject = String(edit.dataModel.subject ?? "").trim();
      if (subject.length === 0) return { drop: true, reason: "a draft needs a subject" };
      await ctx.storage.put({ key: "subject:" + edit.surfaceId, value: subject });
      return {
        covers: { subject },
        decision: { action: "Send: " + subject, risk: "medium" },
        messages: [{ version: "v1.0", updateDataModel: { surfaceId: edit.surfaceId, value: { subject } } }],
      };
    },
  },
};
`;
    const descriptor = decodePluginDescriptorV1({
      id: EDIT_PLUGIN_ID,
      displayName: "Edit probe",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [],
      hooks: [],
      grants: ["storage"],
      cards: [
        {
          id: "draft",
          displayName: "Draft",
          description: "Shows a draft the person may edit before sending.",
          dataSchema: {
            type: "object",
            properties: { subject: { type: "string" } },
            required: ["subject"],
            additionalProperties: false,
          },
          actions: [],
        },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    await pinGeneration(userId, [
      { id: EDIT_PLUGIN_ID, source: EDIT_PLUGIN_SOURCE, descriptor },
    ]);
    await switchPlugin(identity, EDIT_PLUGIN_ID, true);
    const tool = pluginCardToolNameV1(EDIT_PLUGIN_ID, "draft");
    await callPluginToolRaw(identity, "run-edit-1", EDIT_PLUGIN_ID, tool, {
      data: { subject: "Drawn" },
    });
    await callPluginToolRaw(identity, "run-edit-2", EDIT_PLUGIN_ID, tool, {
      data: { subject: "Left alone" },
    });

    const cards = (
      await bot(identity).listCards({ schemaVersion: 1, ...identity })
    ).cards;
    const cardFor = (subject: string) =>
      cards.find((card) => card.dataModel.subject === subject)!;
    const edited = cardFor("Drawn");
    const untouched = cardFor("Left alone");
    const approvalOf = (card: typeof edited) =>
      String(card.components.find((part) => part.id === "actions")?.approvalId);
    const send = (card: typeof edited, subject: string, revision?: number) =>
      bot(identity).cardAction({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          surfaceId: card.surfaceId,
          revision: revision ?? card.revision,
          commandId: crypto.randomUUID(),
          event: {
            name: `approval/${approvalOf(card)}`,
            context: { decision: "approved" },
          },
          dataModel: { subject },
        },
      });
    const approvals = async () =>
      new Map(
        (
          await bot(identity).listApprovals({ schemaVersion: 1, ...identity })
        ).approvals.map((approval) => [approval.approvalId, approval]),
      );
    const bindingOf = (card: typeof edited) =>
      runInDurableObject(
        env.BOT_STATES.getByName(`${userId}:bot-1`),
        (_instance, state) =>
          state.storage.get<{ digest: string }>(
            `shell:card-approval:${EDIT_PLUGIN_ID}:${card.surfaceId}`,
          ),
      );
    const drawnDigest = (await bindingOf(edited))!.digest;
    expect(drawnDigest).toBe(await cardValuesDigestV1({ subject: "Drawn" }));

    // An edit the Plugin refuses decides nothing, and the person reads why.
    const refused = await send(edited, "   ");
    expect(refused.routed).toBe("approval");
    expect(refused.failure).toMatch(/a draft needs a subject/);
    expect((await approvals()).get(approvalOf(edited))?.decision).toBe(
      "pending",
    );
    expect((await bindingOf(edited))!.digest).toBe(drawnDigest);

    // Their words are the decision: the binding now digests what they sent,
    // the Approval says it, and the card holds it for every device.
    const sent = await send(edited, "Edited");
    expect(sent.failure).toBeUndefined();
    expect(sent.card.dataModel).toEqual({ subject: "Edited" });
    expect(sent.card.revision).toBeGreaterThan(edited.revision);
    const decided = (await approvals()).get(approvalOf(edited));
    expect(decided).toMatchObject({
      decision: "approved",
      action: "Send: Edited",
    });
    expect((await bindingOf(edited))!.digest).toBe(
      await cardValuesDigestV1({ subject: "Edited" }),
    );

    // A Send over fields left as they were asks the Plugin nothing and
    // decides exactly what was drawn.
    const plain = await send(untouched, "Left alone");
    expect(plain.failure).toBeUndefined();
    expect((await approvals()).get(approvalOf(untouched))).toMatchObject({
      decision: "approved",
      action: "Send: Left alone",
    });
    expect((await bindingOf(untouched))!.digest).toBe(
      await cardValuesDigestV1({ subject: "Left alone" }),
    );
  });

  test("a Plugin whose module does not parse leaves the page and its switch standing", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const BROKEN_ID = "broken-view";
    // A module the worker's index cannot parse: the whole worker fails to
    // mount, which is the page's worst case for a section.
    const BROKEN_SOURCE = `export const tools = [ ;`;
    const descriptor = decodePluginDescriptorV1({
      id: BROKEN_ID,
      displayName: "Broken",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "broken_noop", description: "Does nothing", inputSchema: {} },
      ],
      hooks: [],
      grants: [],
      views: [{ slot: "settings.sections", surfaceId: "broken.settings" }],
      contextKeys: ["user", "bot", "session"],
    });
    const contentHash = await sha256Hex(BROKEN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      BROKEN_SOURCE,
    );
    const createdAt = "2026-09-12T06:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: BROKEN_ID,
        version: "0.0.1",
        descriptor,
        provenance: {
          kind: "bot",
          packageId: BROKEN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: BROKEN_SOURCE.length,
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
    await switchPlugin(identity, BROKEN_ID, true);

    const frame = await bot(identity).readBotPluginsFrame({
      schemaVersion: 1,
      ...identity,
    });
    const row = frame.plugins.find(
      (candidate) => candidate.pluginId === BROKEN_ID,
    );
    expect(row?.on).toBe(true);
    expect(row?.sections?.[0]?.failure).toMatch(/could not show its section/);
    // The switch the User needs to turn it off still works.
    await switchPlugin(identity, BROKEN_ID, false);
  });

  test("a Plugin's model call in a real Turn is recorded on the Turn's log, attributed to the Plugin", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");

    const ASKER_ID = "asker";
    const ASKER_SOURCE = `
export const tools = [
  { name: "ask_model", description: "Asks the Bot's model one thing", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "ask_model") return "unknown tool";
  const outcome = await ctx.model.invoke({
    requestId: "asker-" + input.n,
    provider: "ollama-cloud",
    model: "glm-5.3-flash:cloud",
    system: "",
    messages: [{ role: "user", content: "hello from a plugin" }],
    tools: [],
  });
  if (outcome.status !== "streaming") return JSON.stringify(outcome);
  let text = "";
  for await (const event of outcome.events) {
    if (event.type === "text-delta") text += event.text;
  }
  return "the model said: " + text;
}
`;
    const descriptor = decodePluginDescriptorV1({
      id: ASKER_ID,
      displayName: "Asker",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [
        { name: "ask_model", description: "Asks the model", inputSchema: {} },
      ],
      hooks: [],
      grants: ["ai"],
      contextKeys: ["user", "bot", "session"],
    });
    await pinGeneration(userId, [
      { id: ASKER_ID, source: ASKER_SOURCE, descriptor },
    ]);
    await switchPlugin(identity, ASKER_ID, true);

    await bot(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: "run-1",
        sessionId: `${userId}:bot-1`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          dynamicToolInputV1({
            namespace: ASKER_ID,
            toolName: "ask_model",
            input: { n: 1 },
          }),
        ]),
      },
    });
    const events = await runEvents(identity, "run-1");
    const answer = events.find(
      (event) =>
        event.type === "tool/result" &&
        typeof event.content === "string" &&
        event.content.includes("the model said"),
    );
    expect(
      answer,
      JSON.stringify(events.map((event) => event.type)),
    ).toBeDefined();
    // The accounting the loop keeps for its own calls, kept for the Plugin's:
    // attributed, counted, and on the Turn's own log.
    const usage = events.find((event) => event.type === "package/model-usage");
    expect(usage).toMatchObject({
      type: "package/model-usage",
      packageId: ASKER_ID,
      requestId: "asker-1",
      provider: "ollama-cloud",
      model: "glm-5.3-flash:cloud",
    });
    const counted = usage as unknown as {
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
      estimated: boolean;
    };
    expect(counted.inputTokens).toBeGreaterThan(0);
    expect(counted.outputTokens).toBeGreaterThan(0);
    expect(counted.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof counted.estimated).toBe("boolean");
  });
  /**
   * A press is counted toward quarantine the way a Turn is, but it is not a
   * Turn, and the notices a person reads must say which. Driven against the
   * real Bot Durable Object: a run made only of failing presses is read back
   * as presses, and a run holding a press and a Turn claims neither.
   */
  test("a run of failed card presses turns the Plugin off as presses, and a mixed run claims no Turns", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");

    const PRESS_ID = "press-probe";
    const MIXED_ID = "mixed-probe";
    const cardSource = (hook: boolean) => `
export const tools = [];
export async function execute(tool) { throw new Error("unknown tool " + tool); }
${
  hook
    ? `export const hooks = {
  "agent/tool-exposure": async function (payload, ctx) {
    const armed = await ctx.storage.get({ key: "armed" });
    if (armed.value) throw new Error("the hook exploded");
    return payload.tools;
  },
};`
    : ""
}
export const cards = {
  draft: {
    render: async function (payload) {
      return [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: payload.surfaceId,
            components: [
              { id: "root", component: "Column", children: ["rows"] },
              {
                id: "rows",
                component: "KeyValueRows",
                rows: [{ label: "Subject", value: payload.data.subject }],
              },
            ],
          },
        },
      ];
    },
    actions: {
      boom: async function () { throw new Error("the press exploded"); },
      arm: async function (press, ctx) {
        await ctx.storage.put({ key: "armed", value: true });
        return { drop: true, reason: "armed on purpose" };
      },
    },
  },
};
`;
    const cardDescriptor = (id: string, hooks: string[]) =>
      decodePluginDescriptorV1({
        id,
        displayName: "Press probe",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [],
        hooks,
        grants: ["storage"],
        cards: [
          {
            id: "draft",
            displayName: "Draft",
            description: "Shows a draft the person can press.",
            dataSchema: {
              type: "object",
              properties: { subject: { type: "string" } },
              required: ["subject"],
              additionalProperties: false,
            },
            actions: [
              { name: "boom", description: "Throws on purpose." },
              { name: "arm", description: "Arms the hook, and drops." },
            ],
          },
        ],
        contextKeys: ["user", "bot", "session"],
      });
    await pinGeneration(userId, [
      {
        id: PRESS_ID,
        source: cardSource(false),
        descriptor: cardDescriptor(PRESS_ID, []),
      },
      {
        id: MIXED_ID,
        source: cardSource(true),
        descriptor: cardDescriptor(MIXED_ID, ["agent/tool-exposure"]),
      },
    ]);
    await switchPlugin(identity, PRESS_ID, true);
    await switchPlugin(identity, MIXED_ID, true);

    // A failing press leaves the Card's revision where it was, so each press
    // in a run needs its own surface: the count is per run, and a run is a
    // Card at a revision. Every draw happens before any press, because a Turn
    // the Plugin ran clean settles its record.
    const draw = async (pluginId: string, runId: string, subject: string) => {
      await callPluginToolRaw(
        identity,
        runId,
        pluginId,
        pluginCardToolNameV1(pluginId, "draft"),
        { data: { subject } },
      );
    };
    for (const [index, runId] of ["run-p1", "run-p2", "run-p3"].entries()) {
      await draw(PRESS_ID, runId, `press ${index + 1}`);
    }
    for (const [index, runId] of ["run-m1", "run-m2"].entries()) {
      await draw(MIXED_ID, runId, `mixed ${index + 1}`);
    }

    const surfaces = async (pluginId: string) =>
      (
        await bot(identity).listCards({ schemaVersion: 1, ...identity })
      ).cards.filter((card) => card.surfaceId.startsWith(`${pluginId}_draft.`));
    const press = async (
      card: { surfaceId: string; revision: number },
      pluginId: string,
      action: string,
    ) =>
      bot(identity).cardAction({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          surfaceId: card.surfaceId,
          revision: card.revision,
          commandId: crypto.randomUUID(),
          event: { name: `plugin/${pluginId}/${action}` },
        },
      });
    const notices = async () =>
      (
        await bot(identity).listNotifications({ schemaVersion: 1, ...identity })
      ).map((notice) => `${notice.title}: ${notice.body}`);
    const quarantineNotice = async (pluginId: string) =>
      (await notices()).find(
        (notice) =>
          notice.startsWith("A plugin was turned off") &&
          notice.includes(`"${pluginId}"`),
      );

    const pressCards = await surfaces(PRESS_ID);
    expect(pressCards).toHaveLength(3);
    for (const card of pressCards) {
      const answer = await press(card, PRESS_ID, "boom");
      expect(answer.failure).toContain("the press exploded");
      // The Card is left exactly as it was: a press that failed is not a
      // redraw.
      expect(answer.card.revision).toBe(card.revision);
    }
    // Three failing presses is the same total three failing Turns is, and the
    // Plugin is off — but the person is told about presses, not Turns.
    expect(
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled[PRESS_ID],
    ).toBe(false);
    const pressQuarantine = await quarantineNotice(PRESS_ID);
    expect(pressQuarantine).toContain("failed on 3 card presses in a row");
    expect(pressQuarantine).not.toContain("Turns");
    const pressPage = (
      await bot(identity).readBotPluginsFrame({ schemaVersion: 1, ...identity })
    ).plugins.find((row) => row.pluginId === PRESS_ID) as
      { on: boolean; quarantined?: string } | undefined;
    expect(pressPage).toMatchObject({ on: false });
    expect(pressPage?.quarantined).toContain(
      "3 card presses in a row that failed",
    );

    // The mixed run: two failing presses and then a failing Turn. The total is
    // what turns the Plugin off, and the words claim no kind the run did not
    // hold.
    const mixedCards = await surfaces(MIXED_ID);
    expect(mixedCards).toHaveLength(2);
    for (const card of mixedCards) {
      expect((await press(card, MIXED_ID, "boom")).failure).toContain(
        "the press exploded",
      );
    }
    expect(await quarantineNotice(MIXED_ID)).toBeUndefined();
    // A handler that refuses in as many words is not one that broke, so
    // arming the hook costs the Plugin nothing.
    expect((await press(mixedCards[0]!, MIXED_ID, "arm")).failure).toContain(
      "armed on purpose",
    );
    await turn(identity, "run-m3");
    expect(
      (
        await bot(identity).readPluginEnablement({
          schemaVersion: 1,
          ...identity,
        })
      ).enabled[MIXED_ID],
    ).toBe(false);
    const mixedQuarantine = await quarantineNotice(MIXED_ID);
    expect(mixedQuarantine).toContain("failed 3 times in a row");
    expect(mixedQuarantine).not.toContain("Turns in a row");
    expect(mixedQuarantine).not.toContain("card presses in a row");

    // A press on a Plugin a quarantine turned off says what happened, and
    // never tells the person they switched it off themselves.
    const afterQuarantine = await press(pressCards[0]!, PRESS_ID, "boom");
    expect(afterQuarantine.failure).toContain("after it failed repeatedly");
    expect(afterQuarantine.failure).not.toContain("is switched off");
  });

  /**
   * Three different things are said apart when the kernel will not put a
   * press to a Plugin, and none of them is the Plugin failing: it never ran,
   * so none is counted toward its quarantine.
   */
  test("a press the kernel will not route says which of three things is wrong, and charges the Plugin nothing", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    await turn(identity, "run-0");

    const REFUSE_ID = "refuse-probe";
    const SOURCE = `
export const tools = [];
export async function execute(tool) { throw new Error("unknown tool " + tool); }
export const cards = {
  draft: {
    render: async function (payload) {
      return [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: payload.surfaceId,
            components: [
              { id: "root", component: "Column", children: ["rows"] },
              { id: "rows", component: "KeyValueRows", rows: [{ label: "Subject", value: payload.data.subject }] },
            ],
          },
        },
      ];
    },
    actions: {
      redraw: async function (press) {
        return [
          {
            version: "v1.0",
            updateComponents: {
              surfaceId: press.surfaceId,
              components: [
                { id: "rows", component: "KeyValueRows", rows: [{ label: "Subject", value: "pressed" }] },
              ],
            },
          },
        ];
      },
    },
  },
};
`;
    const descriptor = decodePluginDescriptorV1({
      id: REFUSE_ID,
      displayName: "Refusal probe",
      version: "0.0.1",
      contractVersion: ISOLATE_CONTRACT_VERSION,
      tools: [],
      hooks: [],
      grants: [],
      cards: [
        {
          id: "draft",
          displayName: "Draft",
          description: "Shows a draft the person can press.",
          dataSchema: {
            type: "object",
            properties: { subject: { type: "string" } },
            required: ["subject"],
            additionalProperties: false,
          },
          actions: [{ name: "redraw", description: "Redraws the card." }],
        },
      ],
      contextKeys: ["user", "bot", "session"],
    });
    await pinGeneration(userId, [
      { id: REFUSE_ID, source: SOURCE, descriptor },
    ]);
    await switchPlugin(identity, REFUSE_ID, true);
    await callPluginToolRaw(
      identity,
      "run-refuse-1",
      REFUSE_ID,
      pluginCardToolNameV1(REFUSE_ID, "draft"),
      { data: { subject: "Hello" } },
    );
    const card = (
      await bot(identity).listCards({ schemaVersion: 1, ...identity })
    ).cards.find((candidate) =>
      candidate.surfaceId.startsWith(`${REFUSE_ID}_draft.`),
    )!;
    const press = async (action: string) =>
      bot(identity).cardAction({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          surfaceId: card.surfaceId,
          revision: card.revision,
          commandId: crypto.randomUUID(),
          event: { name: `plugin/${REFUSE_ID}/${action}` },
        },
      });

    // A member that is on, whose descriptor declares no such action.
    const undeclared = await press("vanished");
    expect(undeclared.failure).toContain('declares no action "vanished"');
    expect(undeclared.failure).not.toContain("switched off");

    // A member this Bot switched off. The card still carries its controls.
    await switchPlugin(identity, REFUSE_ID, false);
    const off = await press("redraw");
    expect(off.failure).toContain("is switched off for this Bot");
    expect(off.failure).toContain("turned back on under Plugins");
    expect(off.failure).not.toContain("failed repeatedly");

    // A Plugin the Composition no longer carries has no switch to throw, so
    // it must not be named as one a person could turn back on.
    await switchPlugin(identity, REFUSE_ID, true);
    await pinGeneration(userId, []);
    const gone = await press("redraw");
    expect(gone.failure).toContain(
      `this Bot no longer runs plugin "${REFUSE_ID}"`,
    );
    expect(gone.failure).not.toContain("switched off");
    expect(gone.failure).not.toContain("turn it back on");

    // None of the three is the Plugin failing: it never ran, so nothing was
    // charged to it and the Card stands at the revision it was drawn at.
    expect(
      (
        await bot(identity).listNotifications({ schemaVersion: 1, ...identity })
      ).map((notice) => notice.title),
    ).not.toContain("A plugin could not answer a card press");
    expect(
      (
        await bot(identity).listCards({ schemaVersion: 1, ...identity })
      ).cards.find((candidate) => candidate.surfaceId === card.surfaceId)
        ?.revision,
    ).toBe(card.revision);
  });
});
