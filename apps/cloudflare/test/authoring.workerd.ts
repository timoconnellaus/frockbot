import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { AUTHORING_QUOTA_DEFAULTS_V1 } from "@frockbot/plugin-authoring/quota";
import { provisionBot, PROVISIONED_MODEL } from "./provision-bot.ts";

function probe(name: string) {
  return env.AUTHORING.getByName(name);
}

function userConfiguration(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

function botState(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

const MODEL_CAPABILITY = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  kind: "model" as const,
};

const GREETER_SOURCE = `export const tools = [
  { name: "greet", description: "Greets by name", inputSchema: { type: "object" }, idempotent: true },
];
export async function execute(tool, input, ctx) {
  return "hello " + String(input?.name ?? "world");
}
`;

const SHOUTING_GREETER_SOURCE = `export const tools = [
  { name: "greet", description: "Greets loudly", inputSchema: { type: "object" }, idempotent: true },
];
export async function execute(tool, input, ctx) {
  return ("hello " + String(input?.name ?? "world")).toUpperCase();
}
`;

/** D6: a Bot-authored model adapter — a translation layer over the binding. */
const MODEL_ADAPTER_SOURCE = `export const tools = [
  { name: "summarize", description: "Summarizes through the model binding", inputSchema: { type: "object" } },
];
export async function execute(tool, input, ctx) {
  const outcome = await ctx.invokeModel(input);
  if (outcome.status !== "streaming") return JSON.stringify(outcome);
  let text = "";
  for await (const event of outcome.events) {
    if (event.type === "text-delta") text += event.text;
  }
  return JSON.stringify({ status: "streaming", requestId: outcome.requestId, text });
}
`;

function authorInput(overrides: Record<string, unknown> = {}) {
  return {
    packageId: "greeter",
    displayName: "Greeter",
    tool: {
      name: "greet",
      description: "Greets by name",
      inputSchema: { type: "object" },
    },
    source: GREETER_SOURCE,
    ...overrides,
  };
}

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}

describe("a Bot authoring a Package", () => {
  test("authoring produces a durable artifact with full provenance", async () => {
    const id = suffix();
    const stub = probe(`author-${id}`);

    const turn = await stub.runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput(),
    });

    expect(turn.text).toContain('ok:Authored Package "greeter" version 0.0.1');
    const artifacts = await stub.artifactRecords();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      mediaType: "application/javascript",
      provenance: {
        kind: "bot",
        packageId: "greeter",
        version: "0.0.1",
        botId: `bot-${id}`,
        sessionId: `user-${id}:bot-${id}`,
        runId: `run-author-${id}`,
        turnId: `run-author-${id}`,
      },
    });
    // The bytes are content-addressed and really in the artifact store.
    expect(await stub.artifactBytes(artifacts[0]!.contentHash)).toBe(
      GREETER_SOURCE,
    );
    expect(artifacts[0]!.r2Key).toBe(
      `packages/${artifacts[0]!.contentHash}.mjs`,
    );
    expect(await stub.sessionEventTypes()).toEqual(
      expect.arrayContaining(["package/author-intent", "package/authored"]),
    );
  });

  test("the authoring Turn completes on the OLD generation", async () => {
    const id = suffix();
    const stub = probe(`old-generation-${id}`);
    const before = await stub.currentGeneration();

    const turn = await stub.runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput(),
    });
    const after = await stub.currentGeneration();

    // The Turn ran on the generation it was admitted under; the authored one
    // is a different, newly pinned generation.
    expect(turn.pinnedGenerationId).toBe(before.generationId);
    expect(after.generationId).not.toBe(before.generationId);
    expect(after.parentGenerationId).toBe(before.generationId);
    expect(after.status).toBe("pending");
    expect(after.origin).toMatchObject({ kind: "bot-authored" });
    // No isolate was mounted in the authoring Turn: the member is not in the pin.
    expect(turn.loaderCalls).toBe(0);
  });

  test("a Durable Object evicted after authoring still mounts the new generation and the tool is callable", async () => {
    const id = suffix();
    const name = `activation-${id}`;
    const authored = await probe(name).runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput(),
    });
    expect(authored.text).toContain("ok:Authored Package");

    // Eviction between authoring and use: nothing but durable state survives.
    await runInDurableObject(probe(name), () => {});
    const evicted = probe(name);

    const used = await evicted.runTurn({
      runId: `run-use-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "greet",
      input: { name: "frockbot" },
    });

    expect(used.text).toBe("ok:hello frockbot");
    expect(used.loaderCalls).toBe(1);
    const active = await evicted.generation(used.pinnedGenerationId!);
    expect(active.status).toBe("active");
    expect(active.members.map((member) => member.packageId).toSorted()).toEqual(
      ["greeter", "shell"],
    );
  });

  test("a duplicate effect id after eviction does not bundle twice", async () => {
    const id = suffix();
    const name = `duplicate-${id}`;
    const input = authorInput();
    const first = await probe(name).runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input,
    });
    await runInDurableObject(probe(name), () => {});
    const evicted = probe(name);
    expect(await evicted.bundlerCalls()).toBe(1);

    // The same run id and the same source produce the same effect id, so the
    // replay resolves to the recorded artifact rather than bundling again.
    const replay = await evicted.runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input,
    });

    expect(await evicted.bundlerCalls()).toBe(1);
    expect(await evicted.artifactRecords()).toHaveLength(1);
    expect(replay.text).toBe(first.text);
  });

  test("re-authoring the same packageId appends a version and supersedes it", async () => {
    const id = suffix();
    const name = `resupersede-${id}`;
    const stub = probe(name);
    const first = await stub.runTurn({
      runId: `run-author-1-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput(),
    });
    const firstGeneration = await stub.currentGeneration();

    const second = await stub.runTurn({
      runId: `run-author-2-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput({ source: SHOUTING_GREETER_SOURCE }),
    });

    expect(first.text).toContain("version 0.0.1");
    expect(second.text).toContain("version 0.0.2");
    expect(second.text).toContain("supersedes version 0.0.1");
    const secondGeneration = await stub.currentGeneration();
    expect(secondGeneration.generationId).not.toBe(
      firstGeneration.generationId,
    );
    expect(secondGeneration.parentGenerationId).toBe(
      firstGeneration.generationId,
    );
    // The earlier generation and its artifact are untouched: superseded, never
    // edited in place.
    const recordedFirst = await stub.generation(firstGeneration.generationId);
    expect(
      recordedFirst.members.find((member) => member.packageId === "greeter")
        ?.version,
    ).toBe("0.0.1");
    expect(
      secondGeneration.members.find((member) => member.packageId === "greeter")
        ?.version,
    ).toBe("0.0.2");
    expect(await stub.artifactRecords()).toHaveLength(2);

    // The newest version is what the next admitted Turn runs.
    const used = await stub.runTurn({
      runId: `run-use-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "greet",
      input: { name: "frockbot" },
    });
    expect(used.text).toBe("ok:HELLO FROCKBOT");
    expect((await stub.generation(firstGeneration.generationId)).status).toBe(
      "superseded",
    );
  });

  test("a quota breach is a visible failure, not a throw", async () => {
    const id = suffix();
    const userId = `user-${id}`;
    await userConfiguration(userId).configureAuthoringQuota({
      schemaVersion: 1,
      userId,
      quota: { ...AUTHORING_QUOTA_DEFAULTS_V1, authoredPerUserPerDay: 1 },
    });
    const stub = probe(`quota-${id}`);

    const allowed = await stub.runTurn({
      runId: `run-author-1-${id}`,
      userId,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput(),
    });
    const refused = await stub.runTurn({
      runId: `run-author-2-${id}`,
      userId,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput({
        packageId: "second",
        source: SHOUTING_GREETER_SOURCE,
      }),
    });

    expect(allowed.text).toContain("ok:Authored Package");
    // The Turn completed; the tool result is the refusal, not an exception.
    expect(refused.text).toContain("error:Authoring was refused");
    expect(refused.text).toContain("durable per-User quota");
    const failures = await stub.failures();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      phase: "quota",
      packageId: "second",
      botId: `bot-${id}`,
    });
    expect(await stub.artifactRecords()).toHaveLength(1);
    expect(await stub.bundlerCalls()).toBe(1);
  });

  test("the bundler's fail-closed rules refuse an authored import", async () => {
    const id = suffix();
    const stub = probe(`unresolved-${id}`);

    const turn = await stub.runTurn({
      runId: `run-author-${id}`,
      userId: `user-${id}`,
      botId: `bot-${id}`,
      tool: "package_author",
      input: authorInput({
        source: `import { z } from "zod";\nexport const tools = [];\nexport async function execute() {}\n`,
      }),
    });

    expect(turn.text).toContain("error:Authoring was refused");
    expect(await stub.artifactRecords()).toHaveLength(0);
    const failures = await stub.failures();
    expect(failures[0]).toMatchObject({ phase: "bundle" });
    expect(failures[0]?.diagnostics.join(" ")).toContain("zod");
  });

  test("an authored model adapter streams through invokeModel with a matching capability", async () => {
    const id = suffix();
    const userId = `user-${id}`;
    const botId = `bot-${id}`;
    const stub = probe(`model-allowed-${id}`);
    await provisionBot({ userId, botId });

    await stub.runTurn({
      runId: `run-author-${id}`,
      userId,
      botId,
      tool: "package_author",
      input: {
        packageId: "summarizer",
        displayName: "Summarizer",
        tool: {
          name: "summarize",
          description: "Summarizes",
          inputSchema: { type: "object" },
        },
        source: MODEL_ADAPTER_SOURCE,
        model: {
          providerId: "provider-foundation",
          modelId: "deterministic-v1",
        },
      },
    });
    const generation = await stub.currentGeneration();
    expect(
      generation.members.find((member) => member.packageId === "summarizer")
        ?.manifestHash,
    ).toMatch(/^[0-9a-f]{64}$/);

    // `invokeModel` goes back to the Bot's own Durable Object, which decides
    // on its enabled capability and the durable model binding that capability
    // carries — never on anything the adapter supplied.
    await botState(userId, botId).readConfiguration({
      schemaVersion: 1,
      userId,
      botId,
    });
    await botState(userId, botId).seedCompositionGeneration(generation);

    const used = await stub.runTurn({
      runId: `run-use-${id}`,
      userId,
      botId,
      tool: "summarize",
      capabilities: [MODEL_CAPABILITY],
      input: {
        requestId: `request-${id}`,
        provider: PROVISIONED_MODEL.provider,
        model: PROVISIONED_MODEL.providerModelId,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    const streamed = JSON.parse(used.text.replace(/^ok:/, "")) as {
      status: string;
      text: string;
    };
    expect(streamed.status).toBe("streaming");
    expect(streamed.text).toBe("Ollama reply");
  });

  test("an authored model adapter with no matching capability gets a pending decision", async () => {
    const id = suffix();
    const userId = `user-${id}`;
    const botId = `bot-${id}`;
    const stub = probe(`model-denied-${id}`);

    await stub.runTurn({
      runId: `run-author-${id}`,
      userId,
      botId,
      tool: "package_author",
      input: {
        packageId: "summarizer",
        displayName: "Summarizer",
        tool: {
          name: "summarize",
          description: "Summarizes",
          inputSchema: { type: "object" },
        },
        source: MODEL_ADAPTER_SOURCE,
        model: {
          providerId: "provider-foundation",
          modelId: "deterministic-v1",
        },
      },
    });

    const used = await stub.runTurn({
      runId: `run-use-${id}`,
      userId,
      botId,
      tool: "summarize",
      input: {
        requestId: `request-${id}`,
        provider: "foundation",
        model: "deterministic-v1",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    // Self-modification never widens authority: the answer is a decision.
    expect(JSON.parse(used.text.replace(/^ok:/, ""))).toMatchObject({
      status: "pending-user-decision",
    });
  });
});
