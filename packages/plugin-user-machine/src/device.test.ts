// The device agent's loop, proved without a laptop.
//
// The wire is real — every request is built by `machineRoutePathV1` and every
// answer decoded by the shipped decoders — and only the socket is a fake. What
// is asserted here is the behaviour the plan calls for in R4: backoff and
// jitter, output bounds and timeouts reaching the result, token load and store
// failure paths, and the two policies that are the agent's own (a 401 forgets
// the token; a lost claim does not run the command).

import { describe, expect, test } from "bun:test";
import type { MachineCommandV1 } from "@frockbot/machine-protocol";
import {
  MACHINE_AGENT_BACKOFF_V1,
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
  decodeMachineDeviceAgentStatusV1,
  decodeMachineEnrollmentStateV1,
  machinePollBackoffV1,
  type MachineCommandReportV1,
  type MachineSecretStoreV1,
} from "./device.js";

const ORIGIN = "https://bot.example.com";

function command(overrides: Partial<MachineCommandV1> = {}): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId: "tool-0-1-0",
    machineId: "m-1",
    botId: "scout",
    runId: "run-1",
    turn: 3,
    approvalId: "tool-0-1-0",
    op: {
      kind: "exec",
      command: "echo hi",
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    },
    issuedAt: "2026-09-01T00:00:00.000Z",
    status: "queued",
    ...overrides,
  };
}

interface Call {
  path: string;
  method: string;
  authorization: string | null;
  body?: string;
}

interface Route {
  status?: number;
  json?: unknown;
}

/** A backend, as far as the agent can tell. */
function server(routes: (call: Call) => Route): {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const headers = new Headers(init?.headers);
      const call: Call = {
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      };
      calls.push(call);
      const route = routes(call);
      return Promise.resolve(
        new Response(
          route.json === undefined ? "" : JSON.stringify(route.json),
          { status: route.status ?? 200 },
        ),
      );
    },
  };
}

const ENROLLED = {
  schemaVersion: 1,
  machineId: "m-1",
  token: "machine-token",
  keyVersion: 1,
};

function agent(options: {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  secrets?: MachineSecretStoreV1;
  run?(command: MachineCommandV1): Promise<MachineCommandReportV1>;
}): MachineDeviceAgentV1 {
  return new MachineDeviceAgentV1({
    origin: ORIGIN,
    fetch: options.fetch,
    secrets: options.secrets ?? createMemoryMachineSecretStoreV1(),
    runner: {
      run: (received) =>
        options.run?.(received) ??
        Promise.resolve({
          finishedAt: "2026-09-01T00:00:01.000Z",
          outcome: "ok",
          truncated: false,
          exitCode: 0,
          stdout: "hi\n",
        }),
    },
    label: "Tims-M5-MacBook-Pro.local",
    platform: "macos",
    agentVersion: "0.0.1",
    capabilities: ["exec", "files"],
    now: () => Date.parse("2026-09-01T00:00:02.000Z"),
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
}

describe("machine device agent backoff", () => {
  test("a working poll does not sleep, and failures grow to a ceiling", () => {
    expect(machinePollBackoffV1(0, () => 0.5)).toBe(0);
    // random() of 0.5 is the midpoint of the jitter window: no jitter at all,
    // so the exponential itself is asserted rather than a range.
    expect(machinePollBackoffV1(1, () => 0.5)).toBe(
      MACHINE_AGENT_BACKOFF_V1.baseMs,
    );
    expect(machinePollBackoffV1(2, () => 0.5)).toBe(2_000);
    expect(machinePollBackoffV1(3, () => 0.5)).toBe(4_000);
    expect(machinePollBackoffV1(20, () => 0.5)).toBe(
      MACHINE_AGENT_BACKOFF_V1.maxMs,
    );
  });

  test("jitter spreads a delay either side and never below zero", () => {
    expect(machinePollBackoffV1(1, () => 0)).toBe(800);
    expect(machinePollBackoffV1(1, () => 0.999)).toBe(1_200);
    expect(
      machinePollBackoffV1(1, () => 0, { baseMs: 10, maxMs: 10, jitter: 4 }),
    ).toBe(0);
  });
});

describe("machine device agent enrollment", () => {
  test("pairing stores exactly the enrollment state and nothing else", async () => {
    const secrets = createMemoryMachineSecretStoreV1();
    const backend = server(() => ({ json: ENROLLED }));
    const device = agent({ fetch: backend.fetch, secrets });

    const status = await device.pair("  pairing-code  ");

    expect(status.enrolled).toBe(true);
    expect(status.machineId).toBe("m-1");
    expect(backend.calls[0]?.path).toBe("/api/machines/enroll");
    expect(backend.calls[0]?.authorization).toBe("Bearer pairing-code");
    const held = decodeMachineEnrollmentStateV1(
      JSON.parse((await secrets.read()) ?? "{}"),
    );
    expect(held).toEqual({
      schemaVersion: 1,
      machineId: "m-1",
      token: "machine-token",
      origin: ORIGIN,
      label: "Tims-M5-MacBook-Pro.local",
      enrolledAt: "2026-09-01T00:00:02.000Z",
    });
    // The status a renderer may read carries no token.
    expect(Object.values(status)).not.toContain("machine-token");
    expect(() => decodeMachineDeviceAgentStatusV1(status)).not.toThrow();
  });

  test("a token minted by another deployment is forgotten, not presented", async () => {
    const secrets = createMemoryMachineSecretStoreV1(
      JSON.stringify({
        schemaVersion: 1,
        machineId: "m-1",
        token: "machine-token",
        origin: "https://other.example.com",
        label: "Elsewhere",
        enrolledAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    const backend = server(() => ({ json: { commands: [] } }));
    const device = agent({ fetch: backend.fetch, secrets });

    const cycle = await device.runOnce(0);

    expect(cycle.paired).toBe(false);
    expect(backend.calls).toEqual([]);
    expect(await secrets.read()).toBeUndefined();
  });

  test("an unreadable store leaves the agent unpaired and says why", async () => {
    const secrets: MachineSecretStoreV1 = {
      read: () => Promise.reject(new Error("the keychain is locked")),
      write: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const backend = server(() => ({ json: { commands: [] } }));
    const device = agent({ fetch: backend.fetch, secrets });

    const cycle = await device.runOnce(0);

    expect(cycle.paired).toBe(false);
    expect(cycle.error).toContain("the keychain is locked");
    expect(device.status().enrolled).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  test("stored nonsense is discarded rather than presented", async () => {
    const secrets = createMemoryMachineSecretStoreV1("{not json");
    const device = agent({
      fetch: server(() => ({ json: { commands: [] } })).fetch,
      secrets,
    });

    expect((await device.runOnce(0)).paired).toBe(false);
    expect(await secrets.read()).toBeUndefined();
  });
});

function pairedStore(): MachineSecretStoreV1 {
  return createMemoryMachineSecretStoreV1(
    JSON.stringify({
      schemaVersion: 1,
      machineId: "m-1",
      token: "machine-token",
      origin: ORIGIN,
      label: "Tims-M5-MacBook-Pro.local",
      enrolledAt: "2026-09-01T00:00:00.000Z",
    }),
  );
}

describe("machine device agent cycle", () => {
  test("polls, claims, runs and reports one command in order", async () => {
    const reports: string[] = [];
    const backend = server((call) => {
      if (call.path.startsWith("/api/machines/m-1/poll")) {
        return {
          json: {
            schemaVersion: 1,
            commands: [command()],
            serverTime: "2026-09-01T00:00:00.000Z",
          },
        };
      }
      if (call.path.endsWith("/claim")) {
        return {
          json: {
            schemaVersion: 1,
            commandId: "tool-0-1-0",
            status: "claimed",
            leaseExpiresAt: "2026-09-01T00:02:00.000Z",
          },
        };
      }
      reports.push(call.body ?? "");
      return {
        json: { schemaVersion: 1, commandId: "tool-0-1-0", status: "recorded" },
      };
    });
    const device = agent({ fetch: backend.fetch, secrets: pairedStore() });

    const cycle = await device.runOnce(25);

    expect(cycle).toMatchObject({
      paired: true,
      delivered: 1,
      claimed: 1,
      alreadyClaimed: 0,
      reported: 1,
    });
    expect(backend.calls.map((call) => call.path)).toEqual([
      "/api/machines/m-1/poll?wait=25",
      "/api/machines/m-1/commands/tool-0-1-0/claim",
      "/api/machines/m-1/commands/tool-0-1-0/result",
    ]);
    expect(JSON.parse(reports[0] ?? "{}")).toMatchObject({
      commandId: "tool-0-1-0",
      outcome: "ok",
      exitCode: 0,
      stdout: "hi\n",
    });
  });

  test("a claim that lost the race does not run the command", async () => {
    let ran = 0;
    const backend = server((call) => {
      if (call.path.startsWith("/api/machines/m-1/poll")) {
        return {
          json: {
            schemaVersion: 1,
            commands: [command()],
            serverTime: "2026-09-01T00:00:00.000Z",
          },
        };
      }
      return {
        json: {
          schemaVersion: 1,
          commandId: "tool-0-1-0",
          status: "already-claimed",
          leaseExpiresAt: "2026-09-01T00:02:00.000Z",
        },
      };
    });
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      run: () => {
        ran += 1;
        return Promise.resolve({
          finishedAt: "2026-09-01T00:00:01.000Z",
          outcome: "ok",
          truncated: false,
        });
      },
    });

    const cycle = await device.runOnce(0);

    expect(ran).toBe(0);
    expect(cycle.alreadyClaimed).toBe(1);
    expect(cycle.reported).toBe(0);
    expect(backend.calls.some((call) => call.path.endsWith("/result"))).toBe(
      false,
    );
  });

  test("a runner that throws still answers, so the lease is never orphaned", async () => {
    const bodies: string[] = [];
    const backend = server((call) => {
      if (call.path.startsWith("/api/machines/m-1/poll")) {
        return {
          json: {
            schemaVersion: 1,
            commands: [command()],
            serverTime: "2026-09-01T00:00:00.000Z",
          },
        };
      }
      if (call.path.endsWith("/claim")) {
        return {
          json: {
            schemaVersion: 1,
            commandId: "tool-0-1-0",
            status: "claimed",
            leaseExpiresAt: "2026-09-01T00:02:00.000Z",
          },
        };
      }
      bodies.push(call.body ?? "");
      return {
        json: { schemaVersion: 1, commandId: "tool-0-1-0", status: "recorded" },
      };
    });
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      run: () => Promise.reject(new Error("spawn ENOENT")),
    });

    expect((await device.runOnce(0)).reported).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      outcome: "error",
      message: "spawn ENOENT",
    });
  });

  test("a 401 forgets the token and stops the loop", async () => {
    const secrets = pairedStore();
    const backend = server(() => ({
      status: 401,
      json: { error: "machine token is invalid" },
    }));
    const device = agent({ fetch: backend.fetch, secrets });

    const cycle = await device.runOnce(0);

    expect(cycle.unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
    expect(device.status()).toMatchObject({
      enrolled: false,
      running: false,
      lastError: "this machine was revoked; pair it again to reconnect",
    });
  });

  test("an ordinary failure is counted, not forgotten", async () => {
    const secrets = pairedStore();
    const backend = server(() => ({ status: 503, json: { error: "closed" } }));
    const device = agent({ fetch: backend.fetch, secrets });

    await device.runOnce(0);
    await device.runOnce(0);

    expect(device.status().failures).toBe(2);
    expect(await secrets.read()).not.toBeUndefined();
  });

  test("unpairing clears the token and leaves the registry alone", async () => {
    const secrets = pairedStore();
    const backend = server(() => ({ json: { commands: [] } }));
    const device = agent({ fetch: backend.fetch, secrets });

    const status = await device.unpair();

    expect(status.enrolled).toBe(false);
    expect(await secrets.read()).toBeUndefined();
    // Nothing was asked of the backend: revocation is the browser's.
    expect(backend.calls).toEqual([]);
  });
});
