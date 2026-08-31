import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  PROBE_BROKEN_SOURCE,
  PROBE_PACKAGE_SOURCE,
} from "./bot-isolate-probe.ts";

function probe(name: string) {
  return env.BOT_ISOLATES.getByName(name);
}

function botState(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

const MODEL_ASSIGNMENT = {
  assignmentId: "model-assignment",
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  kind: "model" as const,
};

function botSettings(botId: string, assignments: unknown[]) {
  return {
    schemaVersion: 1 as const,
    botId,
    revision: 1,
    profile: { name: "Isolate probe" },
    notifications: { enabled: false },
    assignments,
  };
}

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

  test("a non-first-party Package loads with globalOutbound disabled and Assignment-derived bindings only", async () => {
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
    // Network access exists only through the bindings the Assignments grant.
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

  test("two Bots with the same artifact get different loader ids", async () => {
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
    expect(first[0]).toMatch(/^bot-package:user-1:bot-1:[0-9a-f]{64}$/);
    expect(second[0]).toMatch(/^bot-package:user-1:bot-2:[0-9a-f]{64}$/);
    expect(first[0]).not.toBe(second[0]);
    // Same artifact, so the content-addressed component is identical.
    expect(first[0]?.split(":").at(-1)).toBe(second[0]?.split(":").at(-1));
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
  test("requestAuthority returns a pending decision and records it durably", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`authority-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const botId = `authority-bot-${suffix}`;

    const result = await stub.callTool({
      userId: "user-1",
      botId,
      artifact,
      tool: "ask_authority",
    });

    const answer = JSON.parse(result.content) as {
      status: string;
      decisionId: string;
    };
    expect(result.isError).toBe(false);
    expect(answer.status).toBe("pending-user-decision");
    expect(answer.decisionId).toMatch(/^decision-/);

    const decisions = (await botState("user-1", botId).isolateDecisions()) as {
      decisionId: string;
      capabilityId: string;
      status: string;
      packageId: string;
    }[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decisionId: answer.decisionId,
      capabilityId: "memory:write",
      packageId: "bot-authored",
      status: "pending",
    });
  });

  test("list reports only the Assignment-derived capabilities", async () => {
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
      assignments: [MODEL_ASSIGNMENT],
    });

    expect(JSON.parse(withNone.content)).toEqual([]);
    expect(JSON.parse(withModel.content)).toEqual([
      { capabilityId: "ollama-cloud-models", kind: "model" },
    ]);
  });

  test("invokeModel without a matching model Assignment is a pending decision", async () => {
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
        provider: "foundation",
        model: "deterministic-v1",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(JSON.parse(result.content)).toMatchObject({
      status: "pending-user-decision",
    });
    expect(
      await botState("user-1", botId).isolateModelRequestRecords(),
    ).toHaveLength(0);
  });

  test("invokeModel with a matching model Assignment streams a completion", async () => {
    const suffix = crypto.randomUUID();
    const stub = probe(`model-allowed-${suffix}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const botId = `model-allowed-bot-${suffix}`;
    await botState("user-1", botId).seedCompositionGeneration(
      await stub.generationFor(artifact),
    );
    await botState("user-1", botId).seedBotConfiguration(
      // SAFETY: the durable configuration shape is the Bot settings view.
      botSettings(botId, [{ ...MODEL_ASSIGNMENT, state: "enabled" }]) as never,
    );

    const result = await stub.callTool({
      userId: "user-1",
      botId,
      artifact,
      tool: "call_model",
      assignments: [MODEL_ASSIGNMENT],
      toolInput: {
        requestId: "request-1",
        provider: "foundation",
        model: "deterministic-v1",
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
    expect(streamed.text).toBe("Cordis runtime: hello");

    const recorded = (await botState(
      "user-1",
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
      capabilityId: "ollama-cloud-models",
    });
  });
});
