import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  PROBE_BROKEN_SOURCE,
  PROBE_PACKAGE_SOURCE,
} from "./bot-isolate-probe.ts";
import { provisionBot, PROVISIONED_MODEL } from "./provision-bot.ts";

function probe(name: string) {
  return env.BOT_ISOLATES.getByName(name);
}

function botState(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

const MODEL_CAPABILITY = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  kind: "model" as const,
  connectionId: "ollama-1",
};

describe("a Bot Package in a loaded Dynamic Worker", () => {
  test("an isolate tool is callable through ctx.tools", async () => {
    const stub = probe(`tool-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "reverse_text",
      toolInput: { text: "frockbot" },
    });

    expect(result).toEqual({ content: "tobkcorf", isError: false });
  });

  test("an isolate tool is reached by the Agent loop in a Turn", async () => {
    const stub = probe(`turn-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      text: "abcd",
    });

    expect(result.text).toBe("tool:dcba");
    expect(result.loaderCalls).toBe(1);
  });

  test("a Turn that uses no isolate tool makes no loader call", async () => {
    const stub = probe(`no-isolate-${crypto.randomUUID()}`);

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      text: "abcd",
    });

    expect(result.loaderCalls).toBe(0);
  });

  test("a non-first-party Package loads with globalOutbound disabled and User-enabled bindings only", async () => {
    const stub = probe(`outbound-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    // A loader id is served from cache, so this Bot must be a fresh identity
    // or the callback that produces the WorkerCode never runs again.
    const loaded = await stub.observedWorkerCode({
      userId: `user-${crypto.randomUUID()}`,
      botId: `bot-${crypto.randomUUID()}`,
      artifact,
    });

    expect(loaded).toHaveLength(1);
    // Network access exists only through the bindings the User enabled.
    expect(loaded[0]?.globalOutbound).toBeNull();
    expect(loaded[0]?.envKeys).toEqual(["CAPABILITIES", "IDENTITY"]);
    expect(loaded[0]?.identityKeys).toEqual([
      "botId",
      "generationId",
      "packageId",
    ]);
    expect(loaded[0]?.limits.subRequests).toBeGreaterThan(0);
  });

  test("fetch() inside Bot code is rejected", async () => {
    const stub = probe(`egress-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "reach_network",
    });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("egress-allowed");
    expect(result.content).toMatch(/not permitted to access the internet/i);
  });

  test("the isolate sees exactly CAPABILITIES and IDENTITY", async () => {
    const stub = probe(`bindings-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "env_keys",
    });

    expect(JSON.parse(result.content)).toEqual(["CAPABILITIES", "IDENTITY"]);
  });

  test("the isolate reaches no storage, no secret, and no other Bot's Durable Object", async () => {
    const stub = probe(`isolation-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    await stub.writeStorage("host-only");

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "leak_probe",
    });

    expect(JSON.parse(result.content)).toEqual({
      packageId: "bot-authored",
      botId: "bot-1",
      secret: "undefined",
      botStates: "undefined",
      loader: "undefined",
      storage: "undefined",
      env: "undefined",
      durableObject: "undefined",
    });
    // The Durable Object still owns the storage the isolate cannot see.
    expect(await stub.readStorage()).toBe("host-only");
  });

  test("two Bots of one User with the same artifact and grant get different loader ids", async () => {
    const stub = probe(`loader-ids-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const first = await stub.observedLoaderIds({
      userId: "user-1",
      botId: "bot-1",
      artifact,
    });
    const second = await stub.observedLoaderIds({
      userId: "user-1",
      botId: "bot-2",
      artifact,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatch(/^bot-package:user-1:[0-9a-f]{64}$/);
    expect(second[0]).toMatch(/^bot-package:user-1:[0-9a-f]{64}$/);
    expect(second[0]).not.toBe(first[0]);
  });

  test("changing the User-enabled set changes the loader id", async () => {
    const stub = probe(`loader-grant-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const before = await stub.observedLoaderIds({
      userId: "user-1",
      botId: "bot-1",
      artifact,
    });
    const after = await stub.observedLoaderIds({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      capabilities: [MODEL_CAPABILITY],
    });

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
  });

  test("a broken package.js fails verification with a diagnostic, not a hang", async () => {
    const stub = probe(`broken-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_BROKEN_SOURCE);

    const failure = await stub.verifyFailure({
      userId: "user-1",
      botId: "bot-1",
      artifact,
    });

    expect(failure).toContain("failed to mount in its isolate");
    expect(failure).toMatch(/package\.js/);
  });
});

describe("the isolate capability binding", () => {
  test("list reports the User-enabled capability set", async () => {
    const stub = probe(`list-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const withNone = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "list_capabilities",
    });
    const withModel = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "list_capabilities",
      capabilities: [MODEL_CAPABILITY],
    });

    expect(JSON.parse(withNone.content)).toEqual([]);
    expect(JSON.parse(withModel.content)).toEqual([
      { capabilityId: "ollama-cloud-models", kind: "model" },
    ]);
  });

  test("invokeModel with no resolved model binding is unavailable", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`model-denied-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const botId = `model-denied-bot-${suffix}`;

    const result = await stub.callTool({
      userId: "user-1",
      botId,
      artifact,
      tool: "call_model",
      toolInput: {
        requestId: "request-1",
        provider: PROVISIONED_MODEL.provider,
        model: PROVISIONED_MODEL.providerModelId,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(JSON.parse(result.content)).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
    expect(
      await botState("user-1", botId).isolateModelRequestRecords(),
    ).toHaveLength(0);
  });

  test("invokeModel for a provider the Bot's binding does not name is unavailable", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`model-mismatch-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const userId = `model-mismatch-user-${suffix}`;
    const botId = `model-mismatch-bot-${suffix}`;
    await provisionBot({ userId, botId });
    // Materializes the Bot's durable configuration in its own object, the way
    // the first command addressed to a new Bot does.
    await botState(userId, botId).readConfiguration({
      schemaVersion: 1,
      userId,
      botId,
    });
    await botState(userId, botId).seedCompositionGeneration(
      await stub.generationFor(artifact),
    );

    // The User enabled the Ollama Cloud model Capability. That authorizes
    // exactly that Package's provider and exactly the model its binding names
    // — not the first-party provider the Bot asked for here.
    const result = await stub.callTool({
      userId,
      botId,
      artifact,
      tool: "call_model",
      capabilities: [MODEL_CAPABILITY],
      toolInput: {
        requestId: "request-1",
        provider: "foundation",
        model: "deterministic-v1",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(JSON.parse(result.content)).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
    expect(
      await botState(userId, botId).isolateModelRequestRecords(),
    ).toHaveLength(0);
  });

  test("invokeModel for the enabled model but another Package's provider is unavailable", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`model-provider-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const userId = `model-provider-user-${suffix}`;
    const botId = `model-provider-bot-${suffix}`;
    await provisionBot({ userId, botId });
    // Materializes the Bot's durable configuration in its own object, the way
    // the first command addressed to a new Bot does.
    await botState(userId, botId).readConfiguration({
      schemaVersion: 1,
      userId,
      botId,
    });
    await botState(userId, botId).seedCompositionGeneration(
      await stub.generationFor(artifact),
    );

    const result = await stub.callTool({
      userId,
      botId,
      artifact,
      tool: "call_model",
      capabilities: [MODEL_CAPABILITY],
      toolInput: {
        requestId: "request-1",
        provider: "foundation",
        model: PROVISIONED_MODEL.providerModelId,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(JSON.parse(result.content)).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
  });

  test("invokeModel with the authority's exact enabled provider and model streams", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`model-allowed-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const userId = `model-allowed-user-${suffix}`;
    const botId = `model-allowed-bot-${suffix}`;
    await provisionBot({ userId, botId });
    // Materializes the Bot's durable configuration in its own object, the way
    // the first command addressed to a new Bot does.
    await botState(userId, botId).readConfiguration({
      schemaVersion: 1,
      userId,
      botId,
    });
    await botState(userId, botId).seedCompositionGeneration(
      await stub.generationFor(artifact),
    );

    const result = await stub.callTool({
      userId,
      botId,
      artifact,
      tool: "call_model",
      capabilities: [MODEL_CAPABILITY],
      toolInput: {
        requestId: "request-1",
        provider: PROVISIONED_MODEL.provider,
        model: PROVISIONED_MODEL.providerModelId,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(result).toMatchObject({ isError: false });
    const streamed = JSON.parse(result.content) as {
      status: string;
      requestId: string;
      text: string;
    };
    expect(streamed.status).toBe("streaming");
    expect(streamed.requestId).toBe("request-1");
    expect(streamed.text).toBe("Ollama reply");

    const recorded = (await botState(
      userId,
      botId,
    ).isolateModelRequestRecords()) as {
      requestId: string;
      packageId: string;
      capabilityId: string;
    }[];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      requestId: "request-1",
      packageId: "bot-authored",
      capabilityId: PROVISIONED_MODEL.capabilityId,
    });
  });

});
