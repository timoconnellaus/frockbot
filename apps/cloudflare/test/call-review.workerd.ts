// Per-call review of `mutate` tools, against the real Bot Durable Object.
//
// A Plugin a Bot wrote is code from outside the deployment, so Turn
// supervision asks Jev about each of its calls right before it runs. A refused
// call never runs, the model reads why, and the refusal is a `supervision`
// audit row naming the Plugin's tool. First-party tools are `read` and go
// unreviewed.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuditEntryV1 } from "@frockbot/app/audit";
import { fakeJevAnswersV1 } from "@frockbot/app/supervision/testing";
import {
  ISOLATE_CONTRACT_VERSION,
  decodePluginDescriptorV1,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { provisionBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import {
  frockbotToolCall,
  JEV_STUB_ORIGIN,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";

type Identity = { userId: string; botId: string };
type StoredEvent = {
  type: string;
  name?: string;
  content?: string;
  tool?: string;
  occurrenceId?: string;
  decision?: { decision?: string; reasonCode?: string };
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function source(pluginId: string): string {
  return `
export const tools = [
  { name: "post_note", description: "Posts a note", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  await ctx.storage.put({ key: "posted", value: { text: input.text } });
  return "posted by ${pluginId}: " + input.text;
}
`;
}

interface Rpc {
  run(command: unknown): Promise<{ runId: string }>;
  readPluginEnablement(input: unknown): Promise<{ revision: number }>;
  setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
  readComposition(input: unknown): Promise<{
    current: { generationId: string };
  }>;
  proposeComposition(input: unknown): Promise<void>;
  readAuditEntries(input: unknown): Promise<{ entries: AuditEntryV1[] }>;
}

const bot = (identity: Identity) =>
  env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as Rpc;
const user = (userId: string) =>
  env.USER_CONFIGURATIONS.getByName(userId) as unknown as Rpc;

async function run(identity: Identity, runId: string, text: string) {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
}

async function runEvents(
  identity: Identity,
  runId: string,
): Promise<StoredEvent[]> {
  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{ runId: string; sessionId: string }>(state.storage),
  );
  return (runs.find((candidate) => candidate.runId === runId)?.events ??
    []) as StoredEvent[];
}

async function storedNote(identity: Identity): Promise<unknown> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) => {
      const entries = await state.storage.list();
      return [...entries.entries()].find(([key]) => key.includes("posted"));
    },
  );
}

/** Installs a Bot-authored Plugin and switches it on for this Bot. */
async function installBotPlugin(identity: Identity, pluginId: string) {
  const { userId } = identity;
  await run(identity, "run-0", "hello");
  const bootstrap = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const code = source(pluginId);
  const contentHash = await sha256Hex(code);
  await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, code);
  const createdAt = "2026-09-12T01:00:00.000Z";
  const members: CompositionMemberV1[] = [
    {
      packageId: pluginId,
      version: "0.0.1",
      descriptor: decodePluginDescriptorV1({
        id: pluginId,
        displayName: "Note poster",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [
          {
            name: "post_note",
            description: "Posts a note",
            inputSchema: { type: "object" },
          },
        ],
        hooks: [],
        grants: ["storage"],
        contextKeys: ["user", "bot", "session"],
      }),
      provenance: {
        kind: "bot",
        packageId: pluginId,
        version: "0.0.1",
        botId: identity.botId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: "run-0",
        runId: "run-0",
        authoredAt: createdAt,
      },
      artifact: {
        contentHash,
        size: code.length,
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
        sessionId: `${userId}:${identity.botId}`,
        turnId: "run-0",
      },
      members,
      status: "pending",
    },
    pin: true,
    expectedCurrentGenerationId: bootstrap.generationId,
  });
  await switchOn(identity, pluginId);
}

async function switchOn(identity: Identity, pluginId: string) {
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
        enabled: true,
        expectedRevision: current.revision,
      },
    }),
  ).toMatchObject({ status: "applied" });
}

function postNote(pluginId: string, text: string): string {
  return toolCallTriggerPrompt([
    "call_dynamic_tool",
    dynamicToolInputV1({
      namespace: pluginId,
      toolName: "post_note",
      input: { text },
      description: "Post the note the person asked for",
    }),
  ]);
}

/** Jev as the fake answers it, except that nobody asked for the call. */
function jevRefusingCalls(): void {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== JEV_STUB_ORIGIN) return real(request);
    const body = (await request.json()) as {
      questions?: Record<string, unknown>;
    };
    const answers = fakeJevAnswersV1(body);
    if (body.questions && "authorization" in body.questions) {
      (answers.answers as Record<string, unknown>).authorization = {
        type: "choice",
        choice: "none",
        probabilities: { none: 1 },
        confidence: 1,
      };
    }
    return Response.json(answers);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("per-call review of mutate tools", () => {
  test("a Bot-authored Plugin's call is reviewed, allowed, and runs", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await installBotPlugin(identity, "note-poster");

    await run(identity, "run-1", postNote("note-poster", "buy milk"));
    const events = await runEvents(identity, "run-1");
    const reviews = events.filter((event) => event.type === "supervision/call");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      tool: "note-poster/post_note",
      decision: { decision: "allow" },
    });
    const result = events.find((event) => event.type === "tool/result");
    expect(result?.content).toContain("posted by note-poster: buy milk");
  });

  test("a refused call never runs, the model reads why, and the audit names the tool", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await installBotPlugin(identity, "note-poster");

    jevRefusingCalls();
    await run(identity, "run-1", postNote("note-poster", "wire $5000"));
    const events = await runEvents(identity, "run-1");
    const reviews = events.filter((event) => event.type === "supervision/call");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      tool: "note-poster/post_note",
      decision: { decision: "reject", reasonCode: "no_authorization" },
    });
    const result = events.find((event) => event.type === "tool/result");
    expect(result?.content).toContain(
      "Not run: supervision found no request from the person for this call.",
    );
    expect(result?.content).not.toContain("posted by");
    expect(await storedNote(identity)).toBeUndefined();

    const { entries } = await user(identity.userId).readAuditEntries({
      schemaVersion: 1,
      userId: identity.userId,
      kind: "supervision",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "supervision",
      toolName: "note-poster/post_note",
    });
    expect(entries[0]?.preview).toContain("not asked for");
  });

  test("a first-party tool is read: it runs with no call review even when Jev would refuse", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);

    jevRefusingCalls();
    await run(
      identity,
      "run-1",
      toolCallTriggerPrompt(
        frockbotToolCall("memory_write", {
          path: "notes/milk.md",
          content: "buy milk",
        }),
      ),
    );
    const events = await runEvents(identity, "run-1");
    const result = events.find((event) => event.type === "tool/result");
    expect(
      events.filter((event) => event.type === "supervision/call"),
    ).toHaveLength(0);
    expect(result?.content ?? "").not.toContain("Not run: supervision");
  });

  test("a deployment-seeded Plugin's tool is read: no call review even when Jev would refuse", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await run(identity, "run-0", "hello");
    await switchOn(identity, "email");

    jevRefusingCalls();
    await run(
      identity,
      "run-1",
      toolCallTriggerPrompt([
        "call_dynamic_tool",
        dynamicToolInputV1({
          namespace: "email",
          toolName: "email_send",
          input: { surfaceId: "draft-1", approvalId: "approval-1" },
          description: "Send the approved draft",
        }),
      ]),
    );
    const events = await runEvents(identity, "run-1");
    const result = events.find((event) => event.type === "tool/result");
    expect(
      events.filter((event) => event.type === "supervision/call"),
    ).toHaveLength(0);
    expect(result?.content ?? "").not.toContain("Not run: supervision");
  });
});
