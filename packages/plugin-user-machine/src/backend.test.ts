// The routes, over the real User Contribution and real storage.
//
// The only thing faked here is the gateway itself: `route` and `publicRoute`
// are called the way `apps/cloudflare/src/gateway.ts` calls them, with a
// `userId` for the browser door and nothing at all for the machine's.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  MACHINE_LIMITS_V1,
  machineRoutePathV1,
  mintMachineTokenV1,
} from "@frockbot/machine-protocol";
import {
  createMachineBackendContribution,
  type MachineBackendRouteContribution,
} from "./backend.ts";
import { MachineUserBackendContribution } from "./user.ts";
import { verifyMachinePairingCodeV1 } from "./pairing.ts";
import {
  createMemoryMachineStorageV1,
  MachineAgentDriverV1,
} from "./testing.ts";

const SECRET = "machine-route-secret-0123456789abcdef";
const USER = "route-user";
const ORIGIN = "https://bot.frockbot.com";

let authority: MachineUserBackendContribution;
let contribution: MachineBackendRouteContribution;
let now = Date.parse("2026-09-01T00:00:00.000Z");

/** One request through whichever door matches, as the gateway routes it. */
async function call(
  method: string,
  path: string,
  init: {
    userId?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const url = new URL(request.url);
  const context = {
    ...(init.userId === undefined ? {} : { userId: init.userId }),
    client: "browser" as const,
  };
  const machineDoor = await contribution.publicRoute?.(request, url, context);
  return (
    machineDoor ??
    (await contribution.route(request, url, context)) ??
    Response.json({ error: "no route" }, { status: 404 })
  );
}

function agent(
  overrides: Partial<
    ConstructorParameters<typeof MachineAgentDriverV1>[0]
  > = {},
) {
  return new MachineAgentDriverV1({
    origin: ORIGIN,
    fetch: async (input, requestInit) => {
      const request = new Request(input, requestInit);
      const url = new URL(request.url);
      return (
        (await contribution.publicRoute?.(request, url, {
          client: "browser",
        })) ??
        (await contribution.route(request, url, { client: "browser" })) ??
        Response.json({ error: "no route" }, { status: 404 })
      );
    },
    now: () => now,
    ...overrides,
  });
}

beforeEach(() => {
  now = Date.parse("2026-09-01T00:00:00.000Z");
  const storage = createMemoryMachineStorageV1();
  authority = new MachineUserBackendContribution({
    storage,
    readSecret: () => SECRET,
    now: () => now,
    sleep: () => Promise.resolve(),
  });
  contribution = createMachineBackendContribution({
    machineTokenSecret: SECRET,
    createMachinePairing: (userId, request) =>
      authority.createPairing(userId, request),
    enrollMachine: async (userId, input) =>
      authority.enroll(
        { userId, machineId: input.machineId, nonce: "n" },
        input.enrollment,
      ),
    pollMachine: (_userId, callInput) =>
      authority.poll(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
        callInput.waitSeconds,
      ),
    claimMachineCommand: (_userId, callInput) =>
      authority.claim(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
        callInput.commandId,
      ),
    recordMachineResult: (_userId, callInput) =>
      authority.recordResult(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
        callInput.commandId,
        callInput.result,
      ),
    listMachines: () => authority.list(),
    revokeMachine: (_userId, machineId) => authority.revoke(machineId),
  });
});

async function pair(): Promise<{ code: string; machineId: string }> {
  const response = await call("POST", machineRoutePathV1("pair"), {
    userId: USER,
    body: {},
  });
  expect(response.status).toBe(200);
  const offer = (await response.json()) as { code: string; machineId: string };
  return offer;
}

describe("the browser door", () => {
  test("pairing mints a one-time code that names its User and machine", async () => {
    const offer = await pair();
    expect(await verifyMachinePairingCodeV1(SECRET, offer.code)).toMatchObject({
      userId: USER,
      machineId: offer.machineId,
    });
  });

  test("an unauthenticated browser route is not this Contribution's", async () => {
    // No `userId` means the gateway has not authenticated anybody; `route`
    // declines rather than answering, and the request falls through.
    expect((await call("GET", machineRoutePathV1("list"))).status).toBe(404);
  });

  test("the wrong method and a stray query parameter are refused", async () => {
    expect(
      (await call("GET", machineRoutePathV1("pair"), { userId: USER })).status,
    ).toBe(405);
    expect(
      (await call("POST", machineRoutePathV1("list"), { userId: USER })).status,
    ).toBe(405);
    expect(
      (await call("GET", `${machineRoutePathV1("list")}?q=1`, { userId: USER }))
        .status,
    ).toBe(400);
  });

  test("the registry reports connected, then not, on the presence TTL alone", async () => {
    const offer = await pair();
    const driver = agent();
    await driver.enroll(offer.code);
    const connected = (await (
      await call("GET", machineRoutePathV1("list"), { userId: USER })
    ).json()) as { machines: Array<{ connected: boolean; label: string }> };
    expect(connected.machines).toMatchObject([
      { connected: true, label: "Stub-Machine.local" },
    ]);
    now += MACHINE_LIMITS_V1.presenceTtlMs + 1;
    const offline = (await (
      await call("GET", machineRoutePathV1("list"), { userId: USER })
    ).json()) as { machines: Array<{ connected: boolean }> };
    expect(offline.machines).toMatchObject([{ connected: false }]);
  });
});

describe("the machine door", () => {
  test("enrollment answers a token, and the code is spent", async () => {
    const offer = await pair();
    const driver = agent();
    const token = await driver.enroll(offer.code);
    expect(token.length).toBeGreaterThan(0);
    // A second enrollment with the same code is refused: the offer is gone.
    expect(
      await agent().attempt(machineRoutePathV1("enroll"), {
        method: "POST",
        token: offer.code,
        body: JSON.stringify({
          schemaVersion: 1,
          code: offer.code,
          label: "second.local",
          platform: "macos",
          agentVersion: "0.0.1",
          capabilities: ["exec"],
        }),
        headers: { "content-type": "application/json" },
      }),
    ).toBe(401);
  });

  test("a code presented in the header but not the body is refused", async () => {
    const offer = await pair();
    const other = await pair();
    expect(
      await agent().attempt(machineRoutePathV1("enroll"), {
        method: "POST",
        token: offer.code,
        body: JSON.stringify({
          schemaVersion: 1,
          code: other.code,
          label: "mismatched.local",
          platform: "macos",
          agentVersion: "0.0.1",
          capabilities: ["exec"],
        }),
        headers: { "content-type": "application/json" },
      }),
    ).toBe(401);
  });

  test("poll, claim and result refuse a missing, forged or foreign token", async () => {
    const offer = await pair();
    const driver = agent();
    await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    const poll = machineRoutePathV1("poll", { machineId });
    expect(await driver.attempt(poll)).toBe(401);
    expect(await driver.attempt(poll, { token: "not-a-token" })).toBe(401);
    // A well-formed token for another machine, signed with the real secret:
    // the path and the claims must agree.
    const foreign = await mintMachineTokenV1(SECRET, {
      u: USER,
      m: crypto.randomUUID(),
      v: 1,
    });
    expect(await driver.attempt(poll, { token: foreign })).toBe(401);
    // …and one signed with another deployment's secret.
    const elsewhere = await mintMachineTokenV1(
      "another-deployment-secret-0123456789",
      { u: USER, m: machineId, v: 1 },
    );
    expect(await driver.attempt(poll, { token: elsewhere })).toBe(401);
  });

  test("the wrong method and an unknown query parameter are refused", async () => {
    const offer = await pair();
    const driver = agent();
    const token = await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    expect(
      await driver.attempt(machineRoutePathV1("poll", { machineId }), {
        method: "POST",
        token,
      }),
    ).toBe(405);
    expect(
      await driver.attempt(
        `${machineRoutePathV1("poll", { machineId })}?nope=1`,
        {
          token,
        },
      ),
    ).toBe(400);
    expect(
      await driver.attempt(machineRoutePathV1("enroll"), { method: "GET" }),
    ).toBe(405);
  });

  test("a poll, a claim, a result and a replay, end to end", async () => {
    const offer = await pair();
    const driver = agent();
    await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    await authority.dispatch({
      schemaVersion: 1,
      commandId: "tool:1:1:0",
      machineId,
      botId: "bot",
      runId: "run",
      turn: 1,
      approvalId: "tool:1:1:0",
      op: {
        kind: "exec",
        command: "git status",
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
      },
      issuedAt: new Date(now).toISOString(),
      status: "queued",
    });
    const summary = await driver.runOnce();
    expect(summary.delivered.map((command) => command.commandId)).toEqual([
      "tool:1:1:0",
    ]);
    expect(summary.claimed).toEqual(["tool:1:1:0"]);
    expect(summary.reported).toEqual(["tool:1:1:0"]);
    expect(await authority.readResult("tool:1:1:0")).toMatchObject({
      outcome: "ok",
      exitCode: 0,
    });
    // The queue is empty, and a second claim of a settled command is a 404.
    expect(await driver.poll()).toEqual([]);
  });

  test("a revoked machine's token fails every machine route", async () => {
    const offer = await pair();
    const driver = agent();
    const token = await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    expect(
      (
        await call("POST", machineRoutePathV1("revoke", { machineId }), {
          userId: USER,
        })
      ).status,
    ).toBe(200);
    for (const path of [
      machineRoutePathV1("poll", { machineId }),
      machineRoutePathV1("claim", { machineId, commandId: "c" }),
      machineRoutePathV1("result", { machineId, commandId: "c" }),
    ]) {
      expect(
        await driver.attempt(path, {
          token,
          method: path.endsWith("poll") ? "GET" : "POST",
          body: path.endsWith("poll") ? undefined : JSON.stringify({}),
        }),
      ).toBe(401);
    }
  });

  test("without the deployment secret the machine door answers 503", async () => {
    contribution = createMachineBackendContribution({
      createMachinePairing: () => {
        throw new Error("unreachable");
      },
      enrollMachine: () => {
        throw new Error("unreachable");
      },
      pollMachine: () => {
        throw new Error("unreachable");
      },
      claimMachineCommand: () => {
        throw new Error("unreachable");
      },
      recordMachineResult: () => {
        throw new Error("unreachable");
      },
      listMachines: () => {
        throw new Error("unreachable");
      },
      revokeMachine: () => {
        throw new Error("unreachable");
      },
    });
    expect(
      (await call("POST", machineRoutePathV1("enroll"), { token: "code" }))
        .status,
    ).toBe(503);
  });
});
