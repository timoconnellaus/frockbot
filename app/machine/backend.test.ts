// The routes, over the real User Contribution and real storage.
//
// The only thing faked here is the gateway itself: `route` and `publicRoute`
// are called the way `apps/cloudflare/src/gateway.ts` calls them, with a
// `userId` for the browser door and nothing at all for the machine's.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  decodeMachineModuleCallResultV1,
  machineRoutePathV1,
  mintMachineTokenV1,
} from "@frockbot/core/machine-protocol";
import {
  createMachineBackendContribution,
  type MachineBackendRouteContribution,
} from "./backend.ts";
import { MachineUserBackendContribution } from "./user.ts";
import { MachineModuleCallsV1 } from "./module-calls.ts";
import { verifyMachinePairingCodeV1 } from "./pairing.ts";
import {
  createMemoryMachineSocketsV1,
  createMemoryMachineStorageV1,
  MachineAgentDriverV1,
  MachineAgentError,
  type MemoryMachineSocketsV1,
} from "./testing.ts";
import type { MachineSocketV1 } from "./device.ts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";

const SECRET = "machine-route-secret-0123456789abcdef";
const USER = "route-user";
const ORIGIN = "https://bot.frockbot.com";

let authority: MachineUserBackendContribution;
let contribution: MachineBackendRouteContribution;
let sockets: MemoryMachineSocketsV1;
/** The socket the host accepted, waiting for the agent's seam to take it. */
let accepted: MachineSocketV1 | undefined;
let now = Date.parse("2026-09-01T00:00:00.000Z");
/** The module artifacts the active generation carries, by the hash stored. */
let modules: Map<string, string>;
let moduleReports: unknown[];
let moduleCalls: MachineModuleCallsV1;

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
  const fetch = async (input: string, requestInit?: RequestInit) => {
    const request = new Request(input, requestInit);
    const url = new URL(request.url);
    return (
      (await contribution.publicRoute?.(request, url, {
        client: "browser",
      })) ??
      (await contribution.route(request, url, { client: "browser" })) ??
      Response.json({ error: "no route" }, { status: 404 })
    );
  };
  return new MachineAgentDriverV1({
    origin: ORIGIN,
    fetch,
    // The upgrade goes through the real gateway door; the host below stands
    // a 200 in for the 101 only workerd can answer, and hands the socket over.
    webSocket: async (url, token) => {
      const target = new URL(url);
      target.protocol = "https:";
      const response = await fetch(target.toString(), {
        headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
      });
      const socket = accepted;
      accepted = undefined;
      if (response.status !== 200 || !socket) {
        throw new MachineAgentError(response.status, await response.text());
      }
      return socket;
    },
    now: () => now,
    ...overrides,
  });
}

beforeEach(() => {
  now = Date.parse("2026-09-01T00:00:00.000Z");
  const storage = createMemoryMachineStorageV1();
  sockets = createMemoryMachineSocketsV1();
  accepted = undefined;
  modules = new Map();
  moduleReports = [];
  authority = new MachineUserBackendContribution({
    storage,
    readSecret: () => SECRET,
    sockets,
    now: () => now,
  });
  moduleCalls = new MachineModuleCallsV1({
    storage,
    candidates: async () =>
      (await authority.list()).machines
        .filter((machine) => machine.connected)
        .map((machine) => machine.machineId),
    push: (machineId, frame) => sockets.push(machineId, frame),
    now: () => now,
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
    openMachineSocket: async (_userId, callInput) => {
      const opened = await authority.connect(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
      );
      accepted = sockets.accept(callInput.machineId, opened.frame);
      return new Response(null, { status: 200 });
    },
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
    loadMachineModule: async (_userId, callInput) => {
      await authority.authorize(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
      );
      const text = modules.get(callInput.contentHash);
      return text === undefined
        ? undefined
        : (new TextEncoder().encode(text).buffer as ArrayBuffer);
    },
    recordMachineModuleReports: async (_userId, callInput) => {
      await authority.authorize(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
      );
      moduleReports.push(...callInput.reports.reports);
      return {
        schemaVersion: 1,
        recorded: callInput.reports.reports.length,
        dropped: 0,
      };
    },
    claimMachineModuleCall: async (_userId, callInput) => {
      await authority.authorize(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
      );
      return moduleCalls.claim(callInput.machineId, callInput.callId);
    },
    recordMachineModuleCallResult: async (_userId, callInput) => {
      await authority.authorize(
        callInput.claims,
        callInput.tokenDigest,
        callInput.machineId,
      );
      return moduleCalls.result(
        callInput.machineId,
        callInput.callId,
        decodeMachineModuleCallResultV1(callInput.result),
      );
    },
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

  test("the registry reports connected while the machine's socket is open", async () => {
    const offer = await pair();
    const driver = agent();
    await driver.enroll(offer.code);
    const list = async () =>
      (await (
        await call("GET", machineRoutePathV1("list"), { userId: USER })
      ).json()) as { machines: Array<{ connected: boolean; label: string }> };
    expect((await list()).machines).toMatchObject([
      { connected: false, label: "Stub-Machine.local" },
    ]);
    await driver.connect();
    expect((await list()).machines).toMatchObject([{ connected: true }]);
    driver.disconnect();
    expect((await list()).machines).toMatchObject([{ connected: false }]);
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

  test("the socket refuses a missing, forged or foreign token", async () => {
    const offer = await pair();
    const driver = agent();
    await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    const socket = machineRoutePathV1("socket", { machineId });
    const upgrade = { headers: { upgrade: "websocket" } };
    expect(await driver.attempt(socket, upgrade)).toBe(401);
    expect(
      await driver.attempt(socket, { ...upgrade, token: "not-a-token" }),
    ).toBe(401);
    // A well-formed token for another machine, signed with the real secret:
    // the path and the claims must agree.
    const foreign = await mintMachineTokenV1(SECRET, {
      u: USER,
      m: crypto.randomUUID(),
      v: 1,
    });
    expect(await driver.attempt(socket, { ...upgrade, token: foreign })).toBe(
      401,
    );
    // …and one signed with another deployment's secret.
    const elsewhere = await mintMachineTokenV1(
      "another-deployment-secret-0123456789",
      { u: USER, m: machineId, v: 1 },
    );
    expect(await driver.attempt(socket, { ...upgrade, token: elsewhere })).toBe(
      401,
    );
    expect(accepted).toBeUndefined();
  });

  test("a live token without an upgrade is told to upgrade", async () => {
    const offer = await pair();
    const driver = agent();
    const token = await driver.enroll(offer.code);
    expect(
      await driver.attempt(
        machineRoutePathV1("socket", { machineId: driver.machineId! }),
        { token },
      ),
    ).toBe(426);
  });

  test("the wrong method and an unknown query parameter are refused", async () => {
    const offer = await pair();
    const driver = agent();
    const token = await driver.enroll(offer.code);
    const machineId = driver.machineId!;
    expect(
      await driver.attempt(machineRoutePathV1("socket", { machineId }), {
        method: "POST",
        token,
      }),
    ).toBe(405);
    expect(
      await driver.attempt(
        `${machineRoutePathV1("socket", { machineId })}?nope=1`,
        {
          token,
        },
      ),
    ).toBe(400);
    expect(
      await driver.attempt(machineRoutePathV1("enroll"), { method: "GET" }),
    ).toBe(405);
  });

  test("a pushed command, a claim, a result and a replay, end to end", async () => {
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
    // The queue is empty: a reconnect is sent nothing.
    driver.disconnect();
    expect(await driver.next()).toEqual([]);
  });

  test("a module's bytes are served only for a hash the account carries, and only as those bytes", async () => {
    const driver = agent();
    await driver.enroll((await pair()).code);
    const code = "export default {};\n";
    const hash = await sha256HexTextV1(code);
    modules.set(hash, code);
    const served = await driver.fetchModule(hash);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/javascript");
    expect(served.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(await served.text()).toBe(code);

    expect((await driver.fetchModule("c".repeat(64))).status).toBe(404);
    expect(
      (
        await call(
          "GET",
          `/api/machines/${driver.machineId!}/modules/NOT-A-HASH`,
          { token: driver.token! },
        )
      ).status,
    ).toBe(404);
    const path = machineRoutePathV1("module", {
      machineId: driver.machineId!,
      contentHash: hash,
    });
    expect((await call("GET", path)).status).toBe(401);
    expect((await call("POST", path, { token: driver.token! })).status).toBe(
      405,
    );

    modules.set(hash, "export default { tampered: true };\n");
    expect((await driver.fetchModule(hash)).status).toBe(502);
  });

  test("module reports are decoded at the door and handed on", async () => {
    const driver = agent();
    await driver.enroll((await pair()).code);
    const report = {
      pluginId: "beeper",
      moduleId: "bridge",
      kind: "state" as const,
      state: "running" as const,
    };
    expect(await driver.reportModules([report])).toEqual({
      schemaVersion: 1,
      recorded: 1,
      dropped: 0,
    });
    expect(moduleReports).toEqual([report]);
    const path = machineRoutePathV1("moduleReports", {
      machineId: driver.machineId!,
    });
    expect(
      (
        await call("POST", path, {
          token: driver.token!,
          body: { reports: [{ ...report, state: "paused" }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", path, { body: { reports: [report] } })).status,
    ).toBe(401);
  });

  test("a module call is claimed and answered through its two routes", async () => {
    const driver = agent();
    await driver.enroll((await pair()).code);
    await driver.next();
    const answered = moduleCalls.call({
      callId: "mc-1",
      botId: "bot-1",
      pluginId: "beeper",
      moduleId: "bridge",
      call: "send",
      input: { text: "hi" },
    });
    const frame = await driver.nextCall();
    expect(frame).toMatchObject({ callId: "mc-1", call: "send" });
    expect(await driver.claimCall("mc-1")).toEqual({
      schemaVersion: 1,
      status: "claimed",
      callId: "mc-1",
    });
    expect((await driver.claimCall("mc-1")).status).toBe("refused");
    expect(await driver.answerCall("mc-1", { ok: true, value: 1 })).toEqual({
      schemaVersion: 1,
      status: "recorded",
      callId: "mc-1",
    });
    expect(await answered).toEqual({ ok: true, value: 1 });
    const path = machineRoutePathV1("moduleCallResult", {
      machineId: driver.machineId!,
      callId: "mc-1",
    });
    expect(
      (await call("POST", path, { token: driver.token!, body: { ok: "yes" } }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", path, { body: { ok: true, value: 1 } })).status,
    ).toBe(401);
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
    expect(
      await driver.attempt(machineRoutePathV1("socket", { machineId }), {
        token,
        headers: { upgrade: "websocket" },
      }),
    ).toBe(401);
    for (const path of [
      machineRoutePathV1("claim", { machineId, commandId: "c" }),
      machineRoutePathV1("result", { machineId, commandId: "c" }),
      machineRoutePathV1("moduleCallClaim", { machineId, callId: "c" }),
      machineRoutePathV1("moduleCallResult", { machineId, callId: "c" }),
    ]) {
      expect(
        await driver.attempt(path, {
          token,
          method: "POST",
          body: JSON.stringify({}),
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
      openMachineSocket: () => {
        throw new Error("unreachable");
      },
      claimMachineCommand: () => {
        throw new Error("unreachable");
      },
      recordMachineResult: () => {
        throw new Error("unreachable");
      },
      loadMachineModule: () => {
        throw new Error("unreachable");
      },
      recordMachineModuleReports: () => {
        throw new Error("unreachable");
      },
      claimMachineModuleCall: () => {
        throw new Error("unreachable");
      },
      recordMachineModuleCallResult: () => {
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
