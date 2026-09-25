// The `jev` grant, against the real Bot Durable Object and a real Turn.
//
// A Bot-authored Plugin that declares `jev` reaches Jev through the Bot's
// loopback: the model is pinned, the deployment's key is spent, the call is
// itemised on the Turn as the Plugin's, and a run's calls are capped. A Plugin
// that did not declare the grant has no `ctx.jev` at all. A control press
// has no Turn, so the Bot keeps its call instead.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  JEV_STUB_ORIGIN,
  JEV_TEST_API_KEY,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";
import {
  routineDeliveryIdV1,
  routineHookDigestV1,
  verifyRoutineHookTokenV1,
} from "@frockbot/app/routines/hook";

type Identity = { userId: string; botId: string };
type StoredEvent = Record<string, unknown> & { type: string };

const PLUGIN_SOURCE = `
export const tools = [
  { name: "judge", description: "Asks Jev", inputSchema: { type: "object" }, idempotent: true },
];
const QUESTION = {
  type: "choice",
  instructions: "Is this message urgent?",
  criteria: { urgent: "needs action today", later: "can wait" },
};
export const views = {
  "triage.settings": async function () {
    return {
      root: { type: "action", actionId: "judge", label: "Judge now", input: { mode: "once" } },
    };
  },
};
export const triggers = {
  inbound: async function (event, ctx) {
    const judged = await ctx.jev.decide({
      state: { message: event.body },
      questions: { urgency: QUESTION },
    });
    return "Jev judged the alert: " + JSON.stringify(judged);
  },
};
export async function execute(tool, input, ctx) {
  if (input.mode === "keys") {
    return JSON.stringify({ jev: typeof ctx.jev });
  }
  if (input.mode === "once") {
    return JSON.stringify(await ctx.jev.decide({
      state: { message: "the server is down" },
      questions: { urgency: QUESTION },
    }));
  }
  if (input.mode === "model") {
    return JSON.stringify(await ctx.jev.decide({
      state: { message: "x" },
      questions: { urgency: QUESTION },
      model: "jev-9.9.9",
    }));
  }
  if (input.mode === "big") {
    const questions = {};
    for (let i = 0; i < 33; i++) questions["q" + i] = QUESTION;
    return JSON.stringify(await ctx.jev.decide({ state: {}, questions }));
  }
  if (input.mode === "heavy") {
    return JSON.stringify(await ctx.jev.decide({
      state: { blob: "x".repeat(70 * 1024) },
      questions: { urgency: QUESTION },
    }));
  }
  if (input.mode === "many") {
    const statuses = [];
    let last;
    for (let i = 0; i < 65; i++) {
      last = await ctx.jev.decide({
        state: { i },
        questions: { urgency: QUESTION },
      });
      statuses.push(last.status);
    }
    return JSON.stringify({
      available: statuses.filter((s) => s === "available").length,
      firstUnavailable: statuses.indexOf("unavailable"),
      last,
    });
  }
  return "unknown mode";
}
`;

interface Rpc {
  run(command: unknown): Promise<{ runId: string }>;
  readPluginEnablement(input: unknown): Promise<{ revision: number }>;
  setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
  readComposition(input: unknown): Promise<{
    current: { generationId: string };
  }>;
  proposeComposition(input: unknown): Promise<void>;
  executeRoutineCommand(input: unknown): Promise<{
    status: string;
    hook?: { token: string; keyVersion: number };
  }>;
  deliverRoutineHook(input: unknown): Promise<unknown>;
  executeBotPluginTool(input: unknown): Promise<{
    status: string;
    content?: string;
    failure?: string;
  }>;
}

const bot = (identity: Identity) =>
  env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as Rpc;
const user = (userId: string) =>
  env.USER_CONFIGURATIONS.getByName(userId) as unknown as Rpc;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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

async function install(identity: Identity, pluginId: string, grants: string[]) {
  const { userId } = identity;
  await run(identity, "run-0", "hello");
  const bootstrap = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const contentHash = await sha256Hex(PLUGIN_SOURCE);
  await env.APPLICATION_ARTIFACTS.put(
    `packages/${contentHash}.mjs`,
    PLUGIN_SOURCE,
  );
  const createdAt = "2026-09-26T01:00:00.000Z";
  const members: CompositionMemberV1[] = [
    {
      packageId: pluginId,
      version: "0.0.1",
      descriptor: decodePluginDescriptorV1({
        id: pluginId,
        displayName: "Triage",
        version: "0.0.1",
        contractVersion: ISOLATE_CONTRACT_VERSION,
        tools: [
          {
            name: "judge",
            description: "Asks Jev",
            inputSchema: { type: "object" },
          },
        ],
        hooks: [],
        triggers: [{ name: "inbound", description: "An alert to judge" }],
        grants,
        views: [{ slot: "settings.sections", surfaceId: "triage.settings" }],
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
        sessionId: `${userId}:${identity.botId}`,
        turnId: "run-0",
      },
      members,
      status: "pending",
    },
    pin: true,
    expectedCurrentGenerationId: bootstrap.generationId,
  });
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

function judge(pluginId: string, mode: string): string {
  return toolCallTriggerPrompt([
    "call_dynamic_tool",
    dynamicToolInputV1({
      namespace: pluginId,
      toolName: "judge",
      input: { mode },
      description: "Ask Jev as the person asked",
    }),
  ]);
}

/** Every Jev request that is a Plugin's, as the fake Jev received it. */
function recordPluginJevRequests(): Array<{
  authorization: string | null;
  body: { model?: string; questions?: Record<string, unknown> };
}> {
  const seen: Array<{
    authorization: string | null;
    body: { model?: string; questions?: Record<string, unknown> };
  }> = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== JEV_STUB_ORIGIN) return real(request);
    const body = (await request.json()) as {
      model?: string;
      questions?: Record<string, unknown>;
    };
    if (body.questions && "urgency" in body.questions) {
      seen.push({ authorization: request.headers.get("authorization"), body });
    }
    return Response.json(fakeJevAnswersV1(body));
  });
  return seen;
}

async function toolResult(identity: Identity, runId: string) {
  const events = await runEvents(identity, runId);
  const result = events.find((event) => event.type === "tool/result");
  return {
    events,
    content: String(result?.content ?? ""),
  };
}

function parsedToolOutput(content: string): Record<string, unknown> {
  const start = content.indexOf("{");
  return JSON.parse(content.slice(start, content.lastIndexOf("}") + 1));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the jev grant", () => {
  test("a granted Plugin's Jev call in a Turn answers, is pinned, and is itemised as its own", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["jev"]);
    const seen = recordPluginJevRequests();

    await run(identity, "run-1", judge("triage", "once"));
    const { events, content } = await toolResult(identity, "run-1");
    const outcome = parsedToolOutput(content);
    expect(outcome).toMatchObject({
      status: "available",
      value: {
        model: "jev-1.13.0",
        answers: { urgency: { type: "choice", choice: "urgent" } },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.model).toBe("jev-1.13.0");
    expect(seen[0]!.authorization).toContain(JEV_TEST_API_KEY);

    const usage = events.filter(
      (event) => event.type === "package/model-usage",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      packageId: "triage",
      provider: "jev",
      model: "jev-1.13.0",
    });
    expect(usage[0]).not.toHaveProperty("costMicros");
    // A Turn's call is on the Turn, not the Bot's outside-a-Turn list.
    expect(await standaloneUsage(identity)).toBeUndefined();
    console.log(
      "EVIDENCE turn-call",
      JSON.stringify({
        toolResult: outcome,
        jevRequest: seen[0],
        usage: usage[0],
      }),
    );
  });

  test("a Plugin that did not declare jev has no ctx.jev", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["storage"]);
    const seen = recordPluginJevRequests();

    await run(identity, "run-1", judge("triage", "keys"));
    const { content } = await toolResult(identity, "run-1");
    expect(parsedToolOutput(content)).toEqual({ jev: "undefined" });

    // Reaching for it anyway throws in the Plugin; Jev hears nothing.
    await run(identity, "run-2", judge("triage", "once"));
    const second = await toolResult(identity, "run-2");
    expect(second.content).not.toContain('"status":"available"');
    expect(seen).toHaveLength(0);
    console.log(
      "EVIDENCE no-grant",
      JSON.stringify({ keys: content, reach: second.content }),
    );
  });

  test("a Plugin cannot pick its own model, overrun 32 questions or 64 KB", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["jev"]);
    const seen = recordPluginJevRequests();

    await run(identity, "run-1", judge("triage", "model"));
    const model = parsedToolOutput(
      (await toolResult(identity, "run-1")).content,
    );
    await run(identity, "run-2", judge("triage", "big"));
    const big = parsedToolOutput((await toolResult(identity, "run-2")).content);
    await run(identity, "run-3", judge("triage", "heavy"));
    const heavy = parsedToolOutput(
      (await toolResult(identity, "run-3")).content,
    );

    expect(model).toMatchObject({ status: "unavailable" });
    expect(big).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("1 to 32 questions"),
    });
    expect(heavy).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("65536 bytes"),
    });
    expect(seen).toHaveLength(0);
    console.log("EVIDENCE limits", JSON.stringify({ model, big, heavy }));
  });

  test("a run's 65th Jev call is refused, and the next run starts afresh", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["jev"]);
    const seen = recordPluginJevRequests();

    await run(identity, "run-1", judge("triage", "many"));
    const { events, content } = await toolResult(identity, "run-1");
    const many = parsedToolOutput(content);
    expect(many).toMatchObject({
      available: 64,
      firstUnavailable: 64,
      last: {
        status: "unavailable",
        reason: "this run has made its 64 Jev calls",
      },
    });
    expect(seen).toHaveLength(64);
    expect(
      events.filter((event) => event.type === "package/model-usage"),
    ).toHaveLength(64);

    await run(identity, "run-2", judge("triage", "once"));
    expect(
      parsedToolOutput((await toolResult(identity, "run-2")).content),
    ).toMatchObject({ status: "available" });
    console.log("EVIDENCE cap", JSON.stringify(many));
  });

  test("a control press's Jev call has no Turn, so the Bot keeps it as the Plugin's", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["jev"]);
    const seen = recordPluginJevRequests();

    const pressed = await bot(identity).executeBotPluginTool({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        kind: "plugin-tool",
        commandId: "press-1",
        pluginId: "triage",
        tool: "judge",
        arguments: JSON.stringify({ mode: "once" }),
      },
    });
    expect(pressed).toMatchObject({ status: "ran" });
    expect(JSON.parse(pressed.content!)).toMatchObject({
      status: "available",
      value: { model: "jev-1.13.0" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.model).toBe("jev-1.13.0");

    const kept = (await standaloneUsage(identity)) as
      Array<Record<string, unknown>> | undefined;
    expect(kept).toHaveLength(1);
    expect(kept![0]).toMatchObject({
      packageId: "triage",
      model: "jev-1.13.0",
    });
    expect(kept![0]).not.toHaveProperty("costMicros");
    console.log("EVIDENCE press", JSON.stringify({ pressed, kept }));
  });

  test("a trigger's Jev call is admitted, and the Bot keeps it as the Plugin's", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    await install(identity, "triage", ["jev"]);
    const seen = recordPluginJevRequests();

    const receipt = await bot(identity).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        type: "routine/create",
        commandId: "create-alerts",
        botId: identity.botId,
        routineId: "alerts",
        name: "Alerts",
        prompt: "Tell the User what the alert means.",
        trigger: { kind: "plugin", pluginId: "triage", trigger: "inbound" },
      },
    });
    const token = receipt.hook!.token;
    const claims = await verifyRoutineHookTokenV1(
      env.ROUTINE_HOOK_SECRET,
      token,
    );
    const body = '{"alert":"the server is down"}';
    expect(
      await bot(identity).deliverRoutineHook({
        schemaVersion: 1,
        ...identity,
        delivery: {
          routineId: claims.r,
          keyVersion: claims.v,
          digest: await routineHookDigestV1(token),
          deliveryId: await routineDeliveryIdV1(claims.r, body, "evt-1"),
          body,
          contentType: "application/json",
          headers: { "content-type": "application/json" },
        },
      }),
    ).toMatchObject({ status: "accepted" });

    const cues = async () =>
      [
        ...(
          await runInDurableObject(
            env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
            (_instance, state) =>
              state.storage.list<{
                input: string;
                admission?: { origin?: { routineId?: string } };
              }>({ prefix: "run:" }),
          )
        ).values(),
      ]
        .filter((run) => run.admission?.origin?.routineId === "alerts")
        .map((run) => run.input);
    await runDurableObjectAlarm(
      env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    );
    await vi.waitFor(async () => expect(await cues()).toHaveLength(1), {
      timeout: 5_000,
      interval: 25,
    });
    const [cue] = await cues();
    expect(cue).toContain("Jev judged the alert:");
    expect(cue).toContain('"status":"available"');
    expect(cue).not.toContain("not granted");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.model).toBe("jev-1.13.0");

    const kept = (await standaloneUsage(identity)) as
      Array<Record<string, unknown>> | undefined;
    expect(kept).toHaveLength(1);
    expect(kept![0]).toMatchObject({
      packageId: "triage",
      model: "jev-1.13.0",
    });
    console.log("EVIDENCE trigger", JSON.stringify({ cue, kept }));
  });
});

async function standaloneUsage(identity: Identity): Promise<unknown> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) => state.storage.get("plugins:jev-usage"),
  );
}
