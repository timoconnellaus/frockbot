// A Plugin tool calls its device module (ADR 0037, step 5), end to end
// through the real Worker: the loopback reaches the Bot, the Bot the User,
// the User the desktop's socket, and the desktop's claim and answer come back
// through the machine routes to become the tool's result. With no desktop the
// call fails at once; a desktop that claims and never answers is `unknown`.
import {
  applyD1Migrations,
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import {
  ISOLATE_CONTRACT_VERSION,
  decodePluginDescriptorV1,
  pluginModuleKeyV1,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import type { MachinePairingOfferV1 } from "@frockbot/core/machine-protocol";
import { fetchUpgradeMachineWebSocketV1 } from "@frockbot/app/machine/device";
import { MachineAgentDriverV1 } from "@frockbot/app/machine/testing";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import worker from "../src/index.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { grantNativeAccess } from "./native-session-fixture.ts";
import { provisionBot } from "./provision-bot.ts";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const ORIGIN = "https://bot.frockbot.com";
const PLUGIN_ID = "beeper";
/** Short, so the Turn that waits out a silent desktop does not wait long. */
const WAIT_MS = 3_000;
const SOURCE = `export const tools = [
  { name: "beeper_send", description: "Sends a message", inputSchema: { type: "object" }, idempotent: false },
  { name: "beeper_wipe", description: "Asks for an undeclared call", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  const call = tool === "beeper_send" ? "send" : "wipe";
  return JSON.stringify({ outcome: await ctx.device.call("bridge", call, input) });
}
`;
const MODULE = `export default { calls: { send: () => ({ sent: true }) } };\n`;

interface Identity {
  userId: string;
  botId: string;
}

interface UserRpc {
  readComposition(
    input: unknown,
  ): Promise<{ current: { generationId: string } }>;
  proposeComposition(input: unknown): Promise<void>;
  setFeatures(input: unknown): Promise<unknown>;
  createMachinePairing(input: unknown): Promise<MachinePairingOfferV1>;
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

async function workerFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(input, init),
    env as unknown as WorkerEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function bot(identity: Identity) {
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as {
    run(command: unknown): Promise<unknown>;
    readPluginEnablement(input: unknown): Promise<{ revision: number }>;
    setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
  };
}

/** The Bot's switch for the Plugin, as the Plugins page flips it. */
async function enablePlugin(identity: Identity): Promise<void> {
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
        pluginId: PLUGIN_ID,
        enabled: true,
        expectedRevision: current.revision,
      },
    }),
  ).toMatchObject({ status: "applied" });
}

let runs = 0;

async function turn(identity: Identity, text: string): Promise<string> {
  runs += 1;
  const runId = `run-${runs}`;
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
  return runId;
}

/** Runs one of the Plugin's tools as a real Turn and returns its outcome. */
async function callTool(
  identity: Identity,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const runId = await turn(
    identity,
    toolCallTriggerPrompt([
      "call_dynamic_tool",
      dynamicToolInputV1({ namespace: PLUGIN_ID, toolName, input }),
    ]),
  );
  const stored = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string }>;
      }>(state.storage),
  );
  const results = (
    stored.find((candidate) => candidate.runId === runId)?.events ?? []
  ).filter((event) => event.type === "tool/result");
  const result = results.find((event) => event.content?.includes("outcome"));
  expect(result, JSON.stringify(results)).toBeDefined();
  const raw = result!.content!;
  const outer = JSON.parse(raw) as { content?: string };
  return (
    JSON.parse(typeof outer.content === "string" ? outer.content : raw) as {
      outcome: Record<string, unknown>;
    }
  ).outcome;
}

async function pinModulePlugin(identity: Identity): Promise<void> {
  const { userId } = identity;
  const parent = (
    await user(userId).readComposition({ schemaVersion: 1, userId })
  ).current;
  const version = "0.0.1";
  const descriptor = decodePluginDescriptorV1({
    id: PLUGIN_ID,
    displayName: "Beeper",
    version,
    contractVersion: ISOLATE_CONTRACT_VERSION,
    tools: [
      {
        name: "beeper_send",
        description: "Sends a message",
        inputSchema: { type: "object" },
      },
      {
        name: "beeper_wipe",
        description: "Asks for an undeclared call",
        inputSchema: { type: "object" },
      },
    ],
    hooks: [],
    grants: ["device"],
    device: {
      abilities: [],
      modules: [
        {
          id: "bridge",
          platforms: ["macos"],
          read: [],
          net: ["localhost:23373"],
          appleEvents: [],
          calls: ["send"],
          events: [],
        },
      ],
    },
    contextKeys: ["user", "bot", "session"],
  });
  const contentHash = await sha256Hex(SOURCE);
  const moduleHash = await sha256Hex(MODULE);
  await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, SOURCE);
  await env.APPLICATION_ARTIFACTS.put(pluginModuleKeyV1(moduleHash), MODULE);
  const createdAt = new Date().toISOString();
  const members: CompositionMemberV1[] = [
    {
      packageId: PLUGIN_ID,
      version,
      descriptor,
      provenance: {
        kind: "bot",
        packageId: PLUGIN_ID,
        version,
        botId: identity.botId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: "run-seed",
        runId: "run-seed",
        authoredAt: createdAt,
      },
      artifact: {
        contentHash,
        size: SOURCE.length,
        mediaType: "application/javascript",
        bundlerVersion: "probe-seed",
      },
      modules: [{ id: "bridge", contentHash: moduleHash, size: MODULE.length }],
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
        runId: "run-seed",
        sessionId: `${userId}:${identity.botId}`,
        turnId: "run-seed",
      },
      members,
      status: "pending",
    },
    pin: true,
    expectedCurrentGenerationId: parent.generationId,
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
});

describe("a Plugin tool's device call", () => {
  test("fails with no desktop, returns the module's answer, and is unknown when claimed and unanswered", async () => {
    const identity = {
      userId: `device-call-${crypto.randomUUID()}`,
      botId: "bot-1",
    };
    await grantNativeAccess(identity.userId);
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
    await runInDurableObject(
      env.USER_CONFIGURATIONS.getByName(identity.userId),
      (instance) => {
        (instance as unknown as { deviceCallWaitMs: number }).deviceCallWaitMs =
          WAIT_MS;
      },
    );
    await turn(identity, "hello");
    await pinModulePlugin(identity);
    await turn(identity, "hello");
    await enablePlugin(identity);

    // No desktop holds a socket: the call fails now, and nothing is queued.
    expect(await callTool(identity, "beeper_send", { text: "hi" })).toEqual({
      ok: false,
      outcome: "failed",
      error: "the computer running this module is not connected",
    });

    // A call the descriptor does not declare is refused before anything.
    expect(await callTool(identity, "beeper_wipe", {})).toEqual({
      ok: false,
      outcome: "failed",
      error: 'device module "bridge" declares no call "wipe"',
    });

    const desktop = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: workerFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(workerFetch),
      label: "Beeper-Mac.local",
      platform: "macos",
    });
    await desktop.enroll(
      await user(identity.userId).createMachinePairing({
        schemaVersion: 1,
        userId: identity.userId,
      }),
    );
    expect(
      (await desktop.nextModules()).map((module) => module.moduleId),
    ).toEqual(["bridge"]);

    // The desktop claims and answers: the answer is the tool's result.
    const answered = callTool(identity, "beeper_send", { text: "hello" });
    const call = await desktop.nextCall();
    expect(call).toMatchObject({
      pluginId: PLUGIN_ID,
      moduleId: "bridge",
      call: "send",
      input: { text: "hello" },
    });
    expect((await desktop.claimCall(call.callId)).status).toBe("claimed");
    expect(
      (await desktop.answerCall(call.callId, { ok: true, value: { sent: 1 } }))
        .status,
    ).toBe("recorded");
    expect(await answered).toEqual({ ok: true, value: { sent: 1 } });

    // Claimed and never answered: it may have gone, so it is unknown, and
    // the answer that comes later is kept and reaches nobody.
    const silent = callTool(identity, "beeper_send", { text: "again" });
    const second = await desktop.nextCall();
    expect(second.callId).not.toBe(call.callId);
    expect((await desktop.claimCall(second.callId)).status).toBe("claimed");
    expect(await silent).toMatchObject({ ok: false, outcome: "unknown" });
    expect(
      (await desktop.answerCall(second.callId, { ok: true, value: "late" }))
        .status,
    ).toBe("late");
    desktop.disconnect();
  });
});
