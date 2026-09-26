// The shipped desktop agent, against the real routes and a real Durable
// Object, with only the laptop faked.
//
// R2 proved the registry with `MachineAgentDriverV1`, a stub that scripts its
// answers. R4 ships the agent the Electron shell actually runs, and the claim
// this file makes is the plan's: it behaves identically on the wire. So the
// *same* command is put through both, and the two transcripts are compared —
// same paths, same order, same result recorded — with the only difference
// being that the desktop agent's answer came from a `MachineCommandRunnerV1`
// over a faked `child_process` rather than from a script.
//
// The gateway Contribution is mounted here as production mounts it, over the
// real `UserConfiguration` RPCs, so "the real routes" means the route table,
// the `publicRoute` seam, the token verification, the forwarded upgrade and
// the digest re-check — everything but the HTTP server itself.

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachineResultReceiptV1,
  machineRoutePathV1,
  type MachineCommandV1,
} from "@frockbot/core/machine-protocol";
import {
  createMachineBackendContribution,
  type MachineBackendRouteContribution,
} from "@frockbot/app/machine/backend";
import {
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
  fetchUpgradeMachineWebSocketV1,
} from "@frockbot/app/machine/device";
import { createMachineDeviceRunnerV1 } from "@frockbot/app/machine/device-runner";
import { MachineAgentDriverV1 } from "@frockbot/app/machine/testing";
import { internalMachineSocketRequestV1 } from "../src/machine-socket.ts";

const ORIGIN = "https://bot.frockbot.com";

interface MachineRpc {
  createMachinePairing(input: unknown): Promise<unknown>;
  enrollMachine(input: unknown): Promise<unknown>;
  claimMachineCommand(input: unknown): Promise<unknown>;
  recordMachineResult(input: unknown): Promise<unknown>;
  dispatchMachineCommand(input: unknown): Promise<{ status: string }>;
  readMachineResult(input: unknown): Promise<unknown>;
  listMachines(input: unknown): Promise<unknown>;
  revokeMachine(input: unknown): Promise<unknown>;
}

function machines(userId: string): MachineRpc {
  // SAFETY: USER_CONFIGURATIONS is bound to UserConfiguration; the generated
  // stub type is too deep to instantiate here, so this names only the methods
  // this file calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as MachineRpc;
}

/** A cross-object RPC answer, as JSON, exactly as the gateway takes it. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The gateway Contribution over the real object, wired as production wires it. */
function gateway(userId: string): MachineBackendRouteContribution {
  const rpc = machines(userId);
  return createMachineBackendContribution({
    machineTokenSecret: env.MACHINE_TOKEN_SECRET as string,
    createMachinePairing: async (owner, request) =>
      decodeMachinePairingOfferV1(
        snapshot(
          await rpc.createMachinePairing({
            schemaVersion: 1,
            userId: owner,
            ...(request.label === undefined ? {} : { label: request.label }),
          }),
        ),
      ),
    enrollMachine: async (owner, input) =>
      decodeMachineEnrollmentReceiptV1(
        snapshot(
          await rpc.enrollMachine({
            schemaVersion: 1,
            userId: owner,
            machineId: input.machineId,
            enrollment: input.enrollment,
          }),
        ),
      ),
    openMachineSocket: (owner, call, request) =>
      env.USER_CONFIGURATIONS.getByName(owner).fetch(
        internalMachineSocketRequestV1(owner, call, request),
      ),
    claimMachineCommand: async (owner, call) =>
      decodeMachineClaimReceiptV1(
        snapshot(
          await rpc.claimMachineCommand({
            schemaVersion: 1,
            userId: owner,
            machineId: call.machineId,
            commandId: call.commandId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
          }),
        ),
      ),
    recordMachineResult: async (owner, call) =>
      decodeMachineResultReceiptV1(
        snapshot(
          await rpc.recordMachineResult({
            schemaVersion: 1,
            userId: owner,
            machineId: call.machineId,
            commandId: call.commandId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
            result: call.result,
          }),
        ),
      ),
    // Module sync is covered through the real Worker in
    // `machine-modules.workerd.ts`; nothing here fetches or reports one.
    loadMachineModule: () => Promise.resolve(undefined),
    recordMachineModuleReports: () =>
      Promise.reject(new Error("not used by this suite")),
    // Module calls are covered through the real Worker in
    // `device-call.workerd.ts`.
    claimMachineModuleCall: () =>
      Promise.reject(new Error("not used by this suite")),
    recordMachineModuleCallResult: () =>
      Promise.reject(new Error("not used by this suite")),
    recordMachineModuleEvents: () =>
      Promise.reject(new Error("not used by this suite")),
    listMachines: async (owner) =>
      decodeMachineListViewV1(
        snapshot(await rpc.listMachines({ schemaVersion: 1, userId: owner })),
      ),
    revokeMachine: async (owner, machineId) =>
      decodeMachineListViewV1(
        snapshot(
          await rpc.revokeMachine({
            schemaVersion: 1,
            userId: owner,
            machineId,
          }),
        ),
      ),
  });
}

/**
 * `fetch`, for an agent that has no session.
 *
 * Every request goes through the `publicRoute` seam first — the same order the
 * gateway runs them in — so a machine route reached with no token, or with
 * another machine's, is refused here exactly as it is in production.
 */
function machineFetch(
  contribution: MachineBackendRouteContribution,
  recorded: string[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input);
    recorded.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const request = new Request(input, init);
    const answered = await contribution.publicRoute?.(request, url, {
      client: "browser",
    });
    return answered ?? new Response("not found", { status: 404 });
  };
}

function pair(
  contribution: MachineBackendRouteContribution,
  userId: string,
  label: string,
): Promise<Response> {
  const path = machineRoutePathV1("pair");
  const url = new URL(`${ORIGIN}${path}`);
  return contribution
    .route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      }),
      url,
      { userId, client: "browser" },
    )
    .then((response) => response ?? new Response("not found", { status: 404 }));
}

/** Presence, as the settings surface reads it. */
async function connected(userId: string): Promise<boolean | undefined> {
  const view = decodeMachineListViewV1(
    snapshot(await machines(userId).listMachines({ schemaVersion: 1, userId })),
  );
  return view.machines[0]?.connected;
}

/** Wait, boundedly, for a machine's socket to open. */
async function eventuallyConnected(userId: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await connected(userId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the machine never connected");
}

function command(machineId: string, commandId: string): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId,
    machineId,
    botId: "machine-bot",
    runId: "run-1",
    turn: 1,
    approvalId: commandId,
    op: {
      kind: "exec",
      command: "git status --short",
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    },
    issuedAt: new Date().toISOString(),
    status: "queued",
  };
}

/** A laptop, faked at exactly the seam `apps/desktop` implements for real. */
function fakeHost(stdout: string) {
  const commands: string[] = [];
  return {
    commands,
    host: {
      identity: () => ({
        label: "Desktop-Mac.local",
        platform: "macos" as const,
      }),
      exec: (request: { command: string }) => {
        commands.push(request.command);
        return Promise.resolve({
          exitCode: 0,
          stdout,
          stderr: "",
          truncated: false,
          timedOut: false,
        });
      },
      readFile: () => Promise.resolve({ bytesBase64: "", truncated: false }),
    },
  };
}

describe("the desktop device agent against the real machine routes", () => {
  test("the shipped agent and the stub agent leave the same trace on the wire", async () => {
    const stdout = " M app/machine/desktop.ts\n";

    // ---- the shipped agent -------------------------------------------------
    const desktopUser = `machines-desktop-${crypto.randomUUID()}`;
    const desktopGateway = gateway(desktopUser);
    const desktopCalls: string[] = [];
    const desktopFetch = machineFetch(desktopGateway, desktopCalls);
    const offer = decodeMachinePairingOfferV1(
      await (
        await pair(desktopGateway, desktopUser, "Desktop-Mac.local")
      ).json(),
    );
    const laptop = fakeHost(stdout);
    const agent = new MachineDeviceAgentV1({
      origin: ORIGIN,
      fetch: desktopFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(desktopFetch),
      secrets: createMemoryMachineSecretStoreV1(),
      runner: createMachineDeviceRunnerV1({
        host: laptop.host,
        capabilities: ["exec", "files"],
      }),
      label: "Desktop-Mac.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
    });
    await agent.pair(offer.code);
    // The first frame finds nothing queued and the second lists no modules;
    // the third is the dispatch, pushed down the socket the agent holds.
    const session = agent.connectOnce({ frames: 3 });
    await eventuallyConnected(desktopUser);
    await machines(desktopUser).dispatchMachineCommand({
      schemaVersion: 1,
      userId: desktopUser,
      command: command(offer.machineId, "tool:1:1:0"),
    });
    expect(await session).toMatchObject({
      paired: true,
      frames: 3,
      delivered: 1,
      claimed: 1,
      alreadyClaimed: 0,
      reported: 1,
    });
    expect(laptop.commands).toEqual(["git status --short"]);

    // ---- the stub agent, told to answer the same thing ---------------------
    const stubUser = `machines-stub-${crypto.randomUUID()}`;
    const stubGateway = gateway(stubUser);
    const stubCalls: string[] = [];
    const stubOffer = decodeMachinePairingOfferV1(
      await (await pair(stubGateway, stubUser, "Desktop-Mac.local")).json(),
    );
    const stubFetch = machineFetch(stubGateway, stubCalls);
    const stub = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: stubFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(stubFetch),
      label: "Desktop-Mac.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
      handle: () =>
        Promise.resolve({
          kind: "result",
          result: {
            finishedAt: new Date().toISOString(),
            outcome: "ok",
            truncated: false,
            exitCode: 0,
            stdout,
            stderr: "",
          },
        }),
    });
    await stub.enroll(stubOffer);
    await stub.runOnce();
    await machines(stubUser).dispatchMachineCommand({
      schemaVersion: 1,
      userId: stubUser,
      command: command(stubOffer.machineId, "tool:1:1:0"),
    });
    await stub.runOnce();
    stub.disconnect();

    // ---- the same trace ----------------------------------------------------
    const anonymise = (calls: string[], machineId: string): string[] =>
      calls.map((call) => call.replace(machineId, "<machine>"));
    expect(anonymise(desktopCalls, offer.machineId)).toEqual(
      anonymise(stubCalls, stubOffer.machineId),
    );

    // ---- and the same durable answer --------------------------------------
    type Recorded =
      | {
          outcome: string;
          stdout?: string;
          exitCode?: number;
        }
      | undefined;
    const desktopResult = snapshot(
      await machines(desktopUser).readMachineResult({
        schemaVersion: 1,
        userId: desktopUser,
        commandId: "tool:1:1:0",
      }),
    ) as Recorded;
    const stubResult = snapshot(
      await machines(stubUser).readMachineResult({
        schemaVersion: 1,
        userId: stubUser,
        commandId: "tool:1:1:0",
      }),
    ) as Recorded;
    expect(desktopResult).toMatchObject({
      outcome: "ok",
      exitCode: 0,
      stdout,
    });
    expect(desktopResult?.outcome).toBe(stubResult?.outcome as string);
    expect(desktopResult?.stdout).toBe(stubResult?.stdout);
    expect(desktopResult?.exitCode).toBe(stubResult?.exitCode);
  });

  test("a revoked machine's agent forgets its token instead of retrying forever", async () => {
    const userId = `machines-revoked-${crypto.randomUUID()}`;
    const contribution = gateway(userId);
    const secrets = createMemoryMachineSecretStoreV1();
    const offer = decodeMachinePairingOfferV1(
      await (await pair(contribution, userId, "Doomed-Mac.local")).json(),
    );
    const laptop = fakeHost("");
    const doomedFetch = machineFetch(contribution, []);
    const agent = new MachineDeviceAgentV1({
      origin: ORIGIN,
      fetch: doomedFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(doomedFetch),
      secrets,
      runner: createMachineDeviceRunnerV1({
        host: laptop.host,
        capabilities: ["exec", "files"],
      }),
      label: "Doomed-Mac.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
    });
    await agent.pair(offer.code);
    expect(await secrets.read()).toBeDefined();

    await machines(userId).revokeMachine({
      schemaVersion: 1,
      userId,
      machineId: offer.machineId,
    });

    const cycle = await agent.connectOnce();
    expect(cycle.unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
    expect(agent.status()).toMatchObject({ enrolled: false, running: false });
  });

  test("revoking a connected machine closes its socket, and its agent un-enrols", async () => {
    const userId = `machines-closed-${crypto.randomUUID()}`;
    const contribution = gateway(userId);
    const secrets = createMemoryMachineSecretStoreV1();
    const offer = decodeMachinePairingOfferV1(
      await (await pair(contribution, userId, "Closed-Mac.local")).json(),
    );
    const closedFetch = machineFetch(contribution, []);
    const agent = new MachineDeviceAgentV1({
      origin: ORIGIN,
      fetch: closedFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(closedFetch),
      secrets,
      runner: createMachineDeviceRunnerV1({
        host: fakeHost("").host,
        capabilities: ["exec", "files"],
      }),
      label: "Closed-Mac.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
    });
    await agent.pair(offer.code);
    const session = agent.connectOnce();
    await eventuallyConnected(userId);

    await machines(userId).revokeMachine({
      schemaVersion: 1,
      userId,
      machineId: offer.machineId,
    });

    expect(await session).toMatchObject({ frames: 2, unenrolled: true });
    expect(await secrets.read()).toBeUndefined();
    expect(await connected(userId)).toBe(false);
  });

  test("the socket door refuses a missing token, and a plain GET is told to upgrade", async () => {
    const userId = `machines-door-${crypto.randomUUID()}`;
    const contribution = gateway(userId);
    const offer = decodeMachinePairingOfferV1(
      await (await pair(contribution, userId, "Door-Mac.local")).json(),
    );
    const doorFetch = machineFetch(contribution, []);
    const stub = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: doorFetch,
      webSocket: fetchUpgradeMachineWebSocketV1(doorFetch),
    });
    const token = await stub.enroll(offer);
    const path = machineRoutePathV1("socket", { machineId: offer.machineId });
    expect(
      await stub.attempt(path, { headers: { upgrade: "websocket" } }),
    ).toBe(401);
    expect(await stub.attempt(path, { token })).toBe(426);
    expect(await connected(userId)).toBe(false);
  });
});
