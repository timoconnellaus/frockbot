import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { BOT_ISOLATE_CONTEXT_KEYS_V1 } from "@frockbot/core/contracts";
import {
  PROBE_BROKEN_SOURCE,
  PROBE_CONSUMER_SOURCE,
  PROBE_PACKAGE_SOURCE,
  PROBE_PROVIDER_SOURCE,
  PROBE_REQUEST_HOOK_SOURCE,
  PROBE_REQUEST_HOOKS,
  PROBE_REQUEST_REDIRECT_HOOK_SOURCE,
  PROBE_THROWING_HOOK_SOURCE,
  PROBE_TRIGGER_ID,
  PROBE_TRIGGER_SOURCE,
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

  test("an isolate namespace is not external, so a call needs no call metadata", async () => {
    const stub = probe(`external-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    // `external` is external-*service* status: it forces a
    // human-readable reason onto a call that leaves for a third party. An
    // isolate runs this deployment's own reviewed code with `globalOutbound:
    // null`, so it is not that — and calling it external had a cost. The
    // dispatch guard refused every call without `mcpDetails.description`,
    // while the discovery envelope, the namespace prompt block and the
    // `call_dynamic_tool` blurb all told the model to omit the field. The
    // envelope offered was the envelope refused, so the Applets Package (which
    // mounts here) could not be reached by chat at all.
    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "reverse_text",
      toolInput: { text: "frockbot" },
      omitDescription: true,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("tobkcorf");
    expect(result.content).not.toContain("requires mcpDetails.description");
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

  test("the agent/request hook shapes the request it was handed", async () => {
    const stub = probe(`request-hook-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_REQUEST_HOOK_SOURCE);

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      text: "abcd",
      hooks: PROBE_REQUEST_HOOKS,
    });

    const requests = JSON.parse(result.providerRequestsJson) as {
      requestId: string;
      provider: string;
      model: string;
      system: string;
    }[];
    expect(result.text).toBe("tool:dcba");
    expect(result.durableHookFailures).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    // The hook is handed turn and step, like `agent/tool-exposure` is.
    expect(requests[0]?.system).toContain(
      "[shaped by the plugin at turn 1 step 1]",
    );
    // The widened signature is real per-step data, not a constant: every
    // request carries the step it was shaped at.
    expect(
      requests.map(
        (request) =>
          /\[shaped by the plugin at turn (\d+) step (\d+)\]/.exec(
            request.system,
          )?.[0],
      ),
    ).toEqual(
      requests.map(
        (_request, index) =>
          `[shaped by the plugin at turn 1 step ${index + 1}]`,
      ),
    );
    // What it may not touch: the identity the spend record and the lease hang
    // off.
    for (const request of requests) {
      expect(request.provider).toBe("scripted");
      expect(request.model).toBe("scripted-v1");
      expect(request.requestId).not.toBe("");
    }
    expect(result.providerRequestsJson).toBe(result.loggedRequestsJson);
  });

  test("an agent/request hook cannot redirect the request's model binding", async () => {
    const stub = probe(`request-redirect-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(
      PROBE_REQUEST_REDIRECT_HOOK_SOURCE,
    );

    const result = await stub.runTurn({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      text: "abcd",
      hooks: PROBE_REQUEST_HOOKS,
    });

    // The Turn still completes on the request the Bot's authority resolved.
    expect(result.text).toBe("tool:dcba");
    expect(result.providerRequestsJson).not.toContain("smuggled-connection");
    expect(result.providerRequestsJson).toBe(result.loggedRequestsJson);
    expect(result.durableHookFailures.length).toBeGreaterThan(0);
    for (const failure of result.durableHookFailures) {
      expect(failure.event).toBe("agent/request");
      expect(failure.message).toMatch(/cannot redirect the request/);
    }
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
        // The Turn's deadline is now the budget for the whole hook chain, and
        // the index refuses to start a Plugin with less than its minimum slice
        // left. A deadline under that slice skips every Plugin before it runs,
        // so the failure under test here — the Plugin's own throw, timeout or
        // undecodable value — would never happen. Keep it comfortably above
        // the slice and let the Plugin reach the failure it is named for.
        deadlineMs: 100,
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
      "plugins",
      "userId",
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

  test("the runtime context keys equal the generated self-inspection catalog", async () => {
    const stub = probe(`context-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);

    const result = await stub.callTool({
      userId: "user-1",
      botId: "bot-1",
      artifact,
      tool: "context_keys",
    });

    expect(JSON.parse(result.content)).toEqual(
      [...BOT_ISOLATE_CONTEXT_KEYS_V1].sort(),
    );
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
    expect(first[0]).toMatch(/^plugin-worker:user-1:[0-9a-f]{64}$/);
    expect(second[0]).toMatch(/^plugin-worker:user-1:[0-9a-f]{64}$/);
    expect(first[0]).not.toBe(second[0]);
  });

  test("two plugins share one worker: provider first, its service handed on, hooks chained", async () => {
    const stub = probe(`pair-${crypto.randomUUID()}`);
    const provider = await stub.seedArtifact(PROBE_PROVIDER_SOURCE);
    const consumer = await stub.seedArtifact(PROBE_CONSUMER_SOURCE);

    const result = await stub.probePair({
      userId: `user-${crypto.randomUUID()}`,
      botId: "bot-1",
      provider,
      consumer,
    });

    expect(result.loaderCalls).toBe(1);
    expect(result.pluginOrder).toEqual(["probe-provider", "probe-consumer"]);
    expect(result.serviceRead.isError).toBe(false);
    expect(JSON.parse(result.serviceRead.content)).toEqual({
      services: ["greeting"],
      word: "hello",
      packageId: "probe-consumer",
    });
    expect(result.exposedTools).toEqual(["from_provider", "from_consumer"]);
  });

  test("a plugin this Bot switched off registers no tools at the next mount", async () => {
    const stub = probe(`enable-map-${crypto.randomUUID()}`);
    const provider = await stub.seedArtifact(PROBE_PROVIDER_SOURCE);
    const consumer = await stub.seedArtifact(PROBE_CONSUMER_SOURCE);
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };

    // The User installed both; this Bot switches one off under the fence.
    expect(await stub.switchPluginOff("probe-consumer")).toBe(1);

    const result = await stub.probePair({ ...identity, provider, consumer });

    // It is still in the worker — the worker is per User — but it registers
    // no tools here and wraps no hook.
    expect(result.pluginOrder).toEqual(["probe-provider", "probe-consumer"]);
    expect(result.exposedTools).toEqual(["from_provider"]);
    expect(result.serviceRead.isError).toBe(true);
    expect(result.serviceRead.content).toMatch(/probe-consumer/);
  });

  test("a plugin whose consumed service nobody provides is excluded and named, and its sibling still mounts", async () => {
    const stub = probe(`unmet-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const consumer = await stub.seedArtifact(PROBE_CONSUMER_SOURCE);

    const result = await stub.probeUnmetService({
      userId: `user-${crypto.randomUUID()}`,
      botId: "bot-1",
      artifact,
      consumer,
    });

    // A Plugin fails alone: the generation still mounts.
    expect(result.verified).toBe(true);
    expect(result.pluginFailures).toEqual([
      {
        pluginId: "probe-consumer",
        phase: "resolve",
        message:
          'plugin "probe-consumer" consumes "greeting", which no installed plugin provides',
      },
    ]);
    // The excluded Plugin never reaches the worker, and the sibling still
    // wraps the hook it declared.
    expect(result.pluginOrder).toEqual(["bot-authored"]);
    expect(result.exposedTools).toEqual(["hook_marker"]);
  });

  test("a plugin whose health report differs from its descriptor is excluded while the others mount", async () => {
    const stub = probe(`health-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_PACKAGE_SOURCE);
    const provider = await stub.seedArtifact(PROBE_PROVIDER_SOURCE);
    const consumer = await stub.seedArtifact(PROBE_CONSUMER_SOURCE);

    const result = await stub.probeHealthMismatch({
      userId: `user-${crypto.randomUUID()}`,
      botId: "bot-1",
      artifact,
      provider,
      consumer,
    });

    expect(result.verified).toBe(true);
    expect(result.pluginFailures).toHaveLength(1);
    expect(result.pluginFailures[0]).toMatchObject({
      pluginId: "bot-authored",
      phase: "health",
    });
    expect(result.pluginFailures[0]?.message).toMatch(
      /hooks do not match its declared hooks/,
    );
    // The mismatched Plugin contributes nothing — no `hook_marker` — while the
    // pair beside it still mounts in order and chains.
    expect(result.exposedTools).toEqual(["from_provider", "from_consumer"]);
  });

  test("an app-owned trigger reaches the Plugin that declared it and fires its text", async () => {
    const stub = probe(`trigger-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_TRIGGER_SOURCE);

    const result = await stub.probeTriggers({
      userId: `user-${crypto.randomUUID()}`,
      botId: "bot-1",
      artifact,
      deliveries: [
        {
          trigger: "inbound",
          headers: { "x-probe-signature": "sig-1" },
          body: JSON.stringify({ city: "Wollongong" }),
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.mounted).toEqual([PROBE_TRIGGER_ID]);
    const fired = result.results[0];
    expect(fired?.status).toBe("fire");
    expect(JSON.parse(fired?.status === "fire" ? fired.text : "null")).toEqual({
      packageId: PROBE_TRIGGER_ID,
      botId: "bot-1",
      // A trigger runs outside any Turn: the index synthesises the identity
      // from the routine it was delivered for.
      sessionId: "trigger:routine-1",
      signature: "sig-1",
      city: "Wollongong",
    });
  });

  test.each([
    [
      "names a trigger the Plugin never declared",
      { trigger: "unknown" },
      /did not declare trigger "unknown"/,
    ],
    [
      "is authored as a refusal by the Plugin",
      { trigger: "refuse" },
      /nothing in this delivery is for me/,
    ],
    ["returns no text", { trigger: "silent" }, /returned no text/],
    [
      "is never answered before its deadline",
      { trigger: "wedged", deadlineMs: 50 },
      /deadline/,
    ],
    [
      "fires a body over the contract's byte limit",
      { trigger: "oversized" },
      /over the 1000000 byte limit/,
    ],
    [
      "names a Plugin this worker never mounted",
      { pluginId: "not-installed", trigger: "inbound" },
      /did not mount in this generation/,
    ],
  ])(
    "a trigger that %s is dropped with a reason",
    async (_label, delivery, reason) => {
      const stub = probe(`trigger-drop-${crypto.randomUUID()}`);
      const artifact = await stub.seedArtifact(PROBE_TRIGGER_SOURCE);

      const result = await stub.probeTriggers({
        userId: `user-${crypto.randomUUID()}`,
        botId: "bot-1",
        artifact,
        deliveries: [delivery],
      });

      const dropped = result.results[0];
      expect(dropped?.status).toBe("drop");
      expect(dropped?.status === "drop" ? (dropped.reason ?? "") : "").toMatch(
        reason,
      );
    },
  );

  test("a trigger delivered after the Turn's worker is disposed is dropped, not run", async () => {
    const stub = probe(`trigger-disposed-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_TRIGGER_SOURCE);

    const result = await stub.probeTriggers({
      userId: `user-${crypto.randomUUID()}`,
      botId: "bot-1",
      artifact,
      disposeFirst: true,
      deliveries: [{ trigger: "inbound" }],
    });

    const dropped = result.results[0];
    expect(dropped?.status).toBe("drop");
    expect(dropped?.status === "drop" ? (dropped.reason ?? "") : "").toMatch(
      /no longer mounted/,
    );
  });

  test("a broken package.js fails verification with a diagnostic, not a hang", async () => {
    const stub = probe(`broken-${crypto.randomUUID()}`);
    const artifact = await stub.seedArtifact(PROBE_BROKEN_SOURCE);

    const failure = await stub.verifyFailure({
      userId: "user-1",
      botId: "bot-1",
      artifact,
    });

    expect(failure).toContain("plugin worker failed to mount");
    expect(failure).toMatch(/plugins: bot-authored/);
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
      memory: true,
      workspace: true,
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
