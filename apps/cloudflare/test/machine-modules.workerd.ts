// A Plugin's device modules reach the desktop, and what they report reaches
// the Bot (ADR 0037, step 3), end to end through the real Worker: the module
// list arrives on connect and again when a Turn activates a new generation,
// the artifact route serves exactly the active generation's bytes, and a
// report the desktop posts is what `plugin_module_reports` reads in a Turn.
import {
  applyD1Migrations,
  createExecutionContext,
  env,
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
import {
  machineRoutePathV1,
  type MachinePairingOfferV1,
} from "@frockbot/core/machine-protocol";
import { fetchUpgradeMachineWebSocketV1 } from "@frockbot/app/machine/device";
import { MachineAgentDriverV1 } from "@frockbot/app/machine/testing";
import worker from "../src/index.ts";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";
import { grantNativeAccess } from "./native-session-fixture.ts";
import { provisionBot } from "./provision-bot.ts";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const ORIGIN = "https://bot.frockbot.com";
const PLUGIN_ID = "beeper";
const SOURCE = `export const tools = [];
export async function execute() {
  throw new Error("no tools");
}
`;
const MODULE = `export default { calls: {} };\n`;

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

/** The deployed Worker's own `fetch`, as a laptop reaches it. */
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

let runs = 0;

async function turn(identity: Identity, text: string) {
  runs += 1;
  return (
    env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    ) as unknown as {
      run(command: unknown): Promise<{
        events: Array<{ type: string; content?: string; isError?: boolean }>;
      }>;
    }
  ).run({
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

/** Pins a generation holding a Plugin with one device module. */
async function pinModulePlugin(identity: Identity): Promise<string> {
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
    tools: [],
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
  return moduleHash;
}

beforeAll(async () => {
  await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
});

describe("a Plugin's device modules", () => {
  test("reach the desktop with their generation, are served by hash, and report back to the Bot", async () => {
    const identity = {
      userId: `modules-${crypto.randomUUID()}`,
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
    await turn(identity, "hello");

    const desktop = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: workerFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(workerFetch),
      label: "Modules-Mac.local",
      platform: "macos",
    });
    await desktop.enroll(
      await user(identity.userId).createMachinePairing({
        schemaVersion: 1,
        userId: identity.userId,
      }),
    );

    // Nothing to run yet: the list follows the empty queue on connect.
    expect(await desktop.next()).toEqual([]);
    expect(await desktop.nextModules()).toEqual([]);

    // A Turn activates the generation carrying the module, and the open
    // socket is sent the new list without reconnecting.
    const moduleHash = await pinModulePlugin(identity);
    await turn(identity, "hello");
    const bridge = {
      pluginId: PLUGIN_ID,
      moduleId: "bridge",
      contentHash: moduleHash,
      size: MODULE.length,
      read: [],
      net: ["localhost:23373"],
      appleEvents: [],
      calls: ["send"],
      events: [],
    };
    expect(await desktop.nextModules()).toEqual([bridge]);

    // A reconnecting desktop is sent it on connect.
    desktop.disconnect();
    expect(await desktop.next()).toEqual([]);
    expect(await desktop.nextModules()).toEqual([bridge]);

    const served = await desktop.fetchModule(moduleHash);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/javascript");
    expect(served.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(await served.text()).toBe(MODULE);
    // Bytes the bucket holds are not the account's to hand out unless the
    // active generation names them.
    const stray = "export default {};\n";
    const strayHash = await sha256Hex(stray);
    await env.APPLICATION_ARTIFACTS.put(pluginModuleKeyV1(strayHash), stray);
    expect((await desktop.fetchModule(strayHash)).status).toBe(404);
    expect(
      await desktop.attempt(
        machineRoutePathV1("module", {
          machineId: desktop.machineId!,
          contentHash: moduleHash,
        }),
      ),
    ).toBe(401);

    expect(
      await desktop.reportModules([
        {
          pluginId: PLUGIN_ID,
          moduleId: "bridge",
          kind: "state",
          state: "starting",
        },
        {
          pluginId: PLUGIN_ID,
          moduleId: "bridge",
          kind: "log",
          level: "error",
          text: "connect ECONNREFUSED localhost:23373",
        },
        {
          pluginId: PLUGIN_ID,
          moduleId: "bridge",
          kind: "state",
          state: "crashed",
          detail: "exited with code 1",
        },
        {
          pluginId: "stranger",
          moduleId: "bridge",
          kind: "state",
          state: "running",
        },
      ]),
    ).toEqual({ schemaVersion: 1, recorded: 3, dropped: 1 });

    const ran = await turn(
      identity,
      frockbotToolCallPrompt("plugin_module_reports", { pluginId: PLUGIN_ID }),
    );
    const result = ran.events.find((event) => event.type === "tool/result");
    expect(result, JSON.stringify(ran.events)).toBeDefined();
    expect(result?.isError).not.toBe(true);
    const lines = (result?.content ?? "").split("\n");
    expect(lines[0]).toBe(
      "beeper's device modules, latest state on each desktop:",
    );
    expect(lines[1]).toMatch(
      /^- bridge on Modules-Mac\.local: crashed since \S+Z\. exited with code 1$/,
    );
    expect(lines[2]).toBe("1 log line(s), newest first:");
    expect(lines[3]).toMatch(
      /Z error \(bridge on Modules-Mac\.local\): connect ECONNREFUSED localhost:23373$/,
    );
    desktop.disconnect();
  });
});
