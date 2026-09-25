// What a Plugin's page reported, end to end through the real Bot Durable
// Object (ADR 0036, amended 2026-09-25): the report the gateway hands the Bot
// is recorded only for a page of a Plugin in its Composition, stamped with the
// member's version, bounded to the newest fifty, and read back by a real Turn
// through `plugin_page_reports`, which marks what an older version said.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  ISOLATE_CONTRACT_VERSION,
  decodePluginDescriptorV1,
  pluginPageKeyV1,
  withPluginPageBridgeV1,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";

interface Identity {
  userId: string;
  botId: string;
}

interface BotRpc {
  run(command: unknown): Promise<{
    events: Array<{ type: string; content?: string; isError?: boolean }>;
  }>;
  recordPanelPageReport(
    input: unknown,
  ): Promise<{ status: string; reason?: string }>;
}

interface UserRpc {
  readComposition(
    input: unknown,
  ): Promise<{ current: { generationId: string } }>;
  proposeComposition(input: unknown): Promise<void>;
  setFeatures(input: unknown): Promise<unknown>;
}

function bot(identity: Identity): BotRpc {
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc;
}

function user(userId: string): UserRpc {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserRpc;
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

let runs = 0;

async function turn(identity: Identity, text: string) {
  runs += 1;
  return bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId: `run-${runs}`,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
}

const TUNER_ID = "tuner";
const SOURCE = `export const tools = [];
export async function execute() {
  throw new Error("no tools");
}
export const views = { tuner: async () => ({}) };
`;
const PAGE = withPluginPageBridgeV1(
  "<!doctype html><html><head></head><body>tuner</body></html>",
);

/** Pins a generation holding the tuner at `version`. */
async function pinTuner(identity: Identity, version: string, runId: string) {
  const { userId } = identity;
  const parent = (await user(userId).readComposition({ schemaVersion: 1, userId }))
    .current;
  const descriptor = decodePluginDescriptorV1({
    id: TUNER_ID,
    displayName: "Tuner",
    version,
    contractVersion: ISOLATE_CONTRACT_VERSION,
    tools: [],
    hooks: [],
    grants: [],
    views: [
      { slot: "conversation.panel", surfaceId: "tuner", page: "tuner.html" },
    ],
    contextKeys: ["user", "bot", "session"],
  });
  const contentHash = await sha256Hex(SOURCE);
  const pageHash = await sha256Hex(PAGE);
  await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, SOURCE);
  await env.APPLICATION_ARTIFACTS.put(pluginPageKeyV1(pageHash), PAGE);
  const createdAt = new Date().toISOString();
  const members: CompositionMemberV1[] = [
    {
      packageId: TUNER_ID,
      version,
      descriptor,
      provenance: {
        kind: "bot",
        packageId: TUNER_ID,
        version,
        botId: identity.botId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: runId,
        runId,
        authoredAt: createdAt,
      },
      artifact: {
        contentHash,
        size: SOURCE.length,
        mediaType: "application/javascript",
        bundlerVersion: "probe-seed",
      },
      pages: [{ path: "tuner.html", contentHash: pageHash, size: PAGE.length }],
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
      parentGenerationId: parent.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: runId,
      },
      members,
      status: "pending",
    },
    pin: true,
    expectedCurrentGenerationId: parent.generationId,
  });
}

function report(
  identity: Identity,
  fields: Partial<Record<string, unknown>> = {},
) {
  return bot(identity).recordPanelPageReport({
    schemaVersion: 1,
    ...identity,
    // What the gateway hands the Bot: the client's report, once decoded.
    report: {
      pluginId: TUNER_ID,
      surfaceId: "tuner",
      device: "macos",
      level: "log",
      text: "input peaks at 0.004",
      ...fields,
    },
  });
}

async function readReports(identity: Identity): Promise<string> {
  const ran = await turn(
    identity,
    frockbotToolCallPrompt("plugin_page_reports", { pluginId: TUNER_ID }),
  );
  const result = ran.events.find((event) => event.type === "tool/result");
  expect(result, JSON.stringify(ran.events)).toBeDefined();
  expect(result?.isError).not.toBe(true);
  return result?.content ?? "";
}

describe("a Plugin page's reports", () => {
  test("are kept for a page in the Composition, newest fifty, and a Turn reads them marked by version", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await user(identity.userId).setFeatures({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        type: "user/set-features",
        pluginAuthoring: true,
      },
      updatedBy: "workerd-admin",
    });
    await turn(identity, "hello");

    // Nothing yet: the Bot is told where reports would come from.
    expect(await report(identity)).toMatchObject({ status: "refused" });

    await pinTuner(identity, "0.0.1", "run-seed-1");
    await turn(identity, "hello");

    // Switched off still counts: the page said it.
    expect(await report(identity, { text: "first" })).toEqual({
      status: "recorded",
    });
    // Not one of its pages, or not a Plugin it holds: refused, nothing kept.
    expect(await report(identity, { surfaceId: "nope" })).toEqual({
      status: "refused",
      reason: '"tuner" has no page "nope".',
    });
    expect(await report(identity, { pluginId: "stranger" })).toEqual({
      status: "refused",
      reason: '"stranger" has no page "tuner".',
    });

    for (let index = 1; index <= 54; index += 1) {
      expect(
        await report(identity, { level: "error", text: `old ${index}` }),
      ).toEqual({ status: "recorded" });
    }

    // A new version: what the old one said is marked, what it says is not.
    await pinTuner(identity, "0.0.2", "run-seed-2");
    await turn(identity, "hello");
    expect(await report(identity, { text: "new reading 0.2" })).toEqual({
      status: "recorded",
    });

    const read = await readReports(identity);
    const lines = read.split("\n");
    console.log(`plugin_page_reports answered:\n${read}`);
    expect(lines[0]).toBe(
      "50 report(s) from tuner's pages, newest first:",
    );
    expect(lines).toHaveLength(51);
    expect(lines[1]).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z log \(tuner on macos\): new reading 0\.2$/,
    );
    expect(lines[2]).toMatch(
      /error \(tuner on macos, version 0\.0\.1, before the current one\): old 54$/,
    );
    // The oldest are gone: "first" and the earliest five no longer fit.
    expect(lines[50]).toMatch(/: old 6$/);
    expect(read).not.toContain(": first");
  });
});
