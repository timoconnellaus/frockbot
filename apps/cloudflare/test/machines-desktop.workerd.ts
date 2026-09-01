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
// the `publicRoute` seam, the token verification and the digest re-check —
// everything but the HTTP server itself.

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachinePollResultV1,
  decodeMachineResultReceiptV1,
  machineRoutePathV1,
  type MachineCommandV1,
} from "@frockbot/machine-protocol";
import {
  createMachineBackendContribution,
  type MachineBackendRouteContribution,
} from "@frockbot/plugin-user-machine/backend";
import {
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
} from "@frockbot/plugin-user-machine/device";
import { createMachineDeviceRunnerV1 } from "@frockbot/plugin-user-machine/device-runner";
import { MachineAgentDriverV1 } from "@frockbot/plugin-user-machine/testing";

const ORIGIN = "https://bot.frockbot.com";

interface MachineRpc {
  createMachinePairing(input: unknown): Promise<unknown>;
  enrollMachine(input: unknown): Promise<unknown>;
  pollMachine(input: unknown): Promise<unknown>;
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
    pollMachine: async (owner, call) =>
      decodeMachinePollResultV1(
        snapshot(
          await rpc.pollMachine({
            schemaVersion: 1,
            userId: owner,
            machineId: call.machineId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
            waitSeconds: call.waitSeconds,
          }),
        ),
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
    const stdout = " M packages/plugin-user-machine/src/desktop.ts\n";

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
    // Nothing queued: an agent that polls an empty queue reports an empty
    // cycle and does not claim anything.
    expect(await agent.runOnce(0)).toMatchObject({
      paired: true,
      delivered: 0,
      claimed: 0,
      reported: 0,
    });
    await machines(desktopUser).dispatchMachineCommand({
      schemaVersion: 1,
      userId: desktopUser,
      command: command(offer.machineId, "tool:1:1:0"),
    });
    expect(await agent.runOnce(0)).toMatchObject({
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
    const stub = new MachineAgentDriverV1({
      origin: ORIGIN,
      fetch: machineFetch(stubGateway, stubCalls),
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
    await stub.runOnce(0);
    await machines(stubUser).dispatchMachineCommand({
      schemaVersion: 1,
      userId: stubUser,
      command: command(stubOffer.machineId, "tool:1:1:0"),
    });
    await stub.runOnce(0);

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
    const agent = new MachineDeviceAgentV1({
      origin: ORIGIN,
      fetch: machineFetch(contribution, []),
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

    const cycle = await agent.runOnce(0);
    expect(cycle.unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
    expect(agent.status()).toMatchObject({ enrolled: false, running: false });
  });
});
