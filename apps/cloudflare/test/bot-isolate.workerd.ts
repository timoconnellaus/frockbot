import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  PROBE_BROKEN_SOURCE,
  PROBE_PACKAGE_SOURCE,
  PROBE_THROWING_HOOK_SOURCE,
  PROBE_TIMEOUT_HOOK_SOURCE,
  PROBE_UNDECODABLE_HOOK_SOURCE,
} from "./bot-isolate-probe.ts";

function probe(name: string) {
  return env.BOT_ISOLATES.getByName(name);
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

  test("a Bot-authored hook shapes one step and the log equals the provider request", async () => {
    const stub = probe(`hook-request-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      text: "abcd",
    });

    expect(result.providerRequestsJson).toBe(result.loggedRequestsJson);
    expect(result.firstStepToolNames).toContain("hook_marker");
    expect(result.secondStepToolNames).not.toContain("hook_marker");
    expect(result.durableHookFailures).toEqual([]);
  });

  test.each([
    ["throws", PROBE_THROWING_HOOK_SOURCE, /probe hook exploded/],
    ["times out", PROBE_TIMEOUT_HOOK_SOURCE, /exceeded its deadline/],
    [
      "returns an undecodable value",
      PROBE_UNDECODABLE_HOOK_SOURCE,
      /invalid fields/,
    ],
  ])(
    "a hook that %s is skipped and recorded",
    async (_label, source, message) => {
      const stub = probe(`hook-failure-${crypto.randomUUID()}`);
      const artifact = await stub.seedArtifact(source);

      const result = await stub.runTurn({
        userId: "user-1",
        botId: "bot-1",
        artifact,
        text: "abcd",
        deadlineMs: 10,
      });

      expect(result.text).toBe("tool:dcba");
      expect(result.providerRequestsJson).toBe(result.loggedRequestsJson);
      expect(result.firstStepToolNames).not.toContain("hook_marker");
      expect(result.durableHookFailures).toHaveLength(1);
      expect(result.durableHookFailures[0]).toMatchObject({
        type: "package/hook-failed",
        packageId: "bot-authored",
        event: "agent/tool-exposure",
      });
      expect(
        result.durableHookFailures[0]?.type === "package/hook-failed"
          ? result.durableHookFailures[0].message
          : "",
      ).toMatch(message);
    },
  );

  test("a Turn that uses no isolate tool makes no loader call", async () => {
    const stub = probe(`no-isolate-${crypto.randomUUID()}`);

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      text: "abcd",
    });

    expect(result.loaderCalls).toBe(0);
  });

  test("a non-first-party Package loads with globalOutbound disabled and Bot authority bindings only", async () => {
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
    // Network access exists only through the per-Bot authority bindings.
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
  test("list reports exactly the Bot's authority", async () => {
    const stub = probe(`list-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const connection = {
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      generation: "connection-generation-1",
      safeMetadata: { region: "au" },
    };
    const model = {
      connectionId: connection.connectionId,
      packageId: connection.packageId,
      provider: "ollama-cloud",
      providerModelId: "glm-5.3-flash:cloud",
      connectionGeneration: connection.generation,
    };

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "list_capabilities",
      connections: [connection],
      model,
      memory: true,
      workspace: true,
    });

    expect(JSON.parse(result.content)).toEqual({
      status: "available",
      connections: [connection],
      model,
      tools: true,
      memory: true,
      workspace: true,
      notify: true,
      schedule: true,
    });
  });

  test("a capability the Bot does not hold is unavailable", async () => {
    const stub = probe(`unavailable-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const connection = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "connection_lease",
      toolInput: { connectionId: "missing-connection" },
    });
    const model = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "call_model",
      toolInput: {
        requestId: "request-1",
        provider: "ollama-cloud",
        model: "glm-5.3-flash:cloud",
        system: "",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
    });

    expect(JSON.parse(connection.content)).toMatchObject({
      status: "unavailable",
    });
    expect(JSON.parse(model.content)).toMatchObject({
      status: "unavailable",
    });
  });

  test("the durable schedule surface is exposed", async () => {
    const stub = probe(`schedule-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "schedule_surface",
    });

    expect(result).toEqual({ content: "function", isError: false });
  });

  test("adding or removing a Connection yields a new isolate", async () => {
    const stub = probe(`connection-identity-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const identity = {
      userId: `user-${crypto.randomUUID()}`,
      botId: `bot-${crypto.randomUUID()}`,
      artifact,
    };
    const connection = {
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Work",
      generation: "connection-generation-1",
      safeMetadata: {},
    };

    const without = await stub.observedLoaderIds(identity);
    const withConnection = await stub.observedLoaderIds({
      ...identity,
      connections: [connection],
    });
    const removedAgain = await stub.observedLoaderIds(identity);

    expect(without).toHaveLength(1);
    expect(withConnection).toHaveLength(1);
    expect(removedAgain).toEqual(without);
    expect(withConnection[0]).not.toBe(without[0]);
  });
});
