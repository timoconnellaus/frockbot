// The device agent's loop, proved without a laptop.
//
// The wire is real — every request is built by `machineRoutePathV1` and every
// answer and frame decoded by the shipped decoders — and only the transport is
// a fake. What
// is asserted here is the behaviour the plan calls for in R4: backoff and
// jitter, output bounds and timeouts reaching the result, token load and store
// failure paths, and the two policies that are the agent's own (a 401 or a
// revoked socket forgets the token; a lost claim does not run the command).

import { describe, expect, test } from "bun:test";
import {
  MACHINE_SOCKET_REVOKED_CODE_V1,
  type MachineCommandV1,
  type MachineModuleV1,
} from "@frockbot/core/machine-protocol";
import {
  MACHINE_AGENT_BACKOFF_V1,
  MachineDeviceAgentError,
  MachineDeviceAgentV1,
  createMemoryMachineSecretStoreV1,
  decodeMachineDeviceAgentStatusV1,
  decodeMachineEnrollmentStateV1,
  fetchUpgradeMachineWebSocketV1,
  machineReconnectBackoffV1,
  machineSocketFromWebSocketV1,
  type MachineCommandReportV1,
  type MachineSecretStoreV1,
  type MachineSocketEventV1,
  type MachineSocketV1,
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

/** A socket that plays a script, then stays open with nothing to say. */
function scripted(events: (MachineSocketEventV1 | unknown)[]): {
  socket: MachineSocketV1;
  sent: string[];
  closed: number[];
} {
  const queue = events.map((event) =>
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    (event.type === "close" || event.type === "message")
      ? (event as MachineSocketEventV1)
      : ({ type: "message", data: JSON.stringify(event) } as const),
  );
  const sent: string[] = [];
  const closed: number[] = [];
  return {
    sent,
    closed,
    socket: {
      receive: () => {
        const next = queue.shift();
        return next ? Promise.resolve(next) : new Promise(() => {});
      },
      send: (text) => sent.push(text),
      close: (code = 1000) => closed.push(code),
    },
  };
}

function frame(...commands: MachineCommandV1[]) {
  return {
    type: "commands",
    commands,
    serverTime: "2026-09-01T00:00:00.000Z",
  };
}

interface Opened {
  url: string;
  token: string;
}

function agent(options: {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  webSocket?(url: string, token: string): Promise<MachineSocketV1>;
  opened?: Opened[];
  secrets?: MachineSecretStoreV1;
  run?(command: MachineCommandV1): Promise<MachineCommandReportV1>;
  onModules?(modules: MachineModuleV1[]): void;
}): MachineDeviceAgentV1 {
  return new MachineDeviceAgentV1({
    origin: ORIGIN,
    fetch: options.fetch,
    webSocket: (url, token) => {
      options.opened?.push({ url, token });
      return options.webSocket
        ? options.webSocket(url, token)
        : Promise.reject(new Error("no socket in this test"));
    },
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
    ...(options.onModules ? { onModules: options.onModules } : {}),
  });
}

describe("machine device agent backoff", () => {
  test("a working connection does not wait, and failures grow to a ceiling", () => {
    expect(machineReconnectBackoffV1(0, () => 0.5)).toBe(0);
    // random() of 0.5 is the midpoint of the jitter window: no jitter at all,
    // so the exponential itself is asserted rather than a range.
    expect(machineReconnectBackoffV1(1, () => 0.5)).toBe(
      MACHINE_AGENT_BACKOFF_V1.baseMs,
    );
    expect(machineReconnectBackoffV1(2, () => 0.5)).toBe(2_000);
    expect(machineReconnectBackoffV1(3, () => 0.5)).toBe(4_000);
    expect(machineReconnectBackoffV1(20, () => 0.5)).toBe(
      MACHINE_AGENT_BACKOFF_V1.maxMs,
    );
  });

  test("jitter spreads a delay either side and never below zero", () => {
    expect(machineReconnectBackoffV1(1, () => 0)).toBe(800);
    expect(machineReconnectBackoffV1(1, () => 0.999)).toBe(1_200);
    expect(
      machineReconnectBackoffV1(1, () => 0, {
        baseMs: 10,
        maxMs: 10,
        jitter: 4,
      }),
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
    const backend = server(() => ({}));
    const opened: Opened[] = [];
    const device = agent({ fetch: backend.fetch, secrets, opened });

    const cycle = await device.connectOnce();

    expect(cycle.paired).toBe(false);
    expect(backend.calls).toEqual([]);
    expect(opened).toEqual([]);
    expect(await secrets.read()).toBeUndefined();
  });

  test("an unreadable store leaves the agent unpaired and says why", async () => {
    const secrets: MachineSecretStoreV1 = {
      read: () => Promise.reject(new Error("the keychain is locked")),
      write: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    const backend = server(() => ({}));
    const opened: Opened[] = [];
    const device = agent({ fetch: backend.fetch, secrets, opened });

    const cycle = await device.connectOnce();

    expect(cycle.paired).toBe(false);
    expect(cycle.error).toContain("the keychain is locked");
    expect(device.status().enrolled).toBe(false);
    expect(backend.calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("stored nonsense is discarded rather than presented", async () => {
    const secrets = createMemoryMachineSecretStoreV1("{not json");
    const device = agent({ fetch: server(() => ({})).fetch, secrets });

    expect((await device.connectOnce()).paired).toBe(false);
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

const CLAIMED = {
  json: {
    schemaVersion: 1,
    commandId: "tool-0-1-0",
    status: "claimed",
    leaseExpiresAt: "2026-09-01T00:02:00.000Z",
  },
};

const RECORDED = {
  json: { schemaVersion: 1, commandId: "tool-0-1-0", status: "recorded" },
};

describe("machine device agent connection", () => {
  test("dials the socket, then claims, runs and reports a pushed command in order", async () => {
    const reports: string[] = [];
    const backend = server((call) => {
      if (call.path.endsWith("/claim")) return CLAIMED;
      reports.push(call.body ?? "");
      return RECORDED;
    });
    const opened: Opened[] = [];
    const line = scripted([
      { type: "message", data: "pong" },
      frame(command()),
    ]);
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      opened,
      webSocket: () => Promise.resolve(line.socket),
    });

    const cycle = await device.connectOnce({ frames: 1 });

    expect(opened).toEqual([
      {
        url: "wss://bot.example.com/api/machines/m-1/socket",
        token: "machine-token",
      },
    ]);
    expect(cycle).toMatchObject({
      paired: true,
      frames: 1,
      delivered: 1,
      claimed: 1,
      alreadyClaimed: 0,
      reported: 1,
    });
    expect(cycle.error).toBeUndefined();
    expect(backend.calls.map((call) => call.path)).toEqual([
      "/api/machines/m-1/commands/tool-0-1-0/claim",
      "/api/machines/m-1/commands/tool-0-1-0/result",
    ]);
    expect(backend.calls[0]?.authorization).toBe("Bearer machine-token");
    expect(JSON.parse(reports[0] ?? "{}")).toMatchObject({
      commandId: "tool-0-1-0",
      outcome: "ok",
      exitCode: 0,
      stdout: "hi\n",
    });
    // The connection is closed once the agent is done with it.
    expect(line.closed).toEqual([1000]);
    expect(device.status().lastConnectedAt).toBe("2026-09-01T00:00:02.000Z");
  });

  test("hands each module list to its embedder, and runs nothing for it", async () => {
    const bridge = {
      pluginId: "beeper",
      moduleId: "bridge",
      contentHash: "b".repeat(64),
      size: 42,
      read: [],
      net: ["localhost:23373"],
      appleEvents: [],
      calls: ["send"],
      events: ["message"],
      listening: ["message"],
      lastKeys: {},
    };
    const lists: MachineModuleV1[][] = [];
    const backend = server(() => CLAIMED);
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      webSocket: () =>
        Promise.resolve(
          scripted([
            frame(),
            {
              type: "modules",
              modules: [bridge],
              serverTime: "2026-09-01T00:00:00.000Z",
            },
            {
              type: "modules",
              modules: [],
              serverTime: "2026-09-01T00:00:01.000Z",
            },
          ]).socket,
        ),
      onModules: (modules) => lists.push(modules),
    });

    const cycle = await device.connectOnce({ frames: 3 });

    expect(lists).toEqual([[bridge], []]);
    expect(cycle).toMatchObject({ frames: 3, delivered: 0, claimed: 0 });
    expect(cycle.error).toBeUndefined();
    expect(backend.calls).toEqual([]);
  });

  test("a claim that lost the race does not run the command", async () => {
    let ran = 0;
    const backend = server(() => ({
      json: {
        schemaVersion: 1,
        commandId: "tool-0-1-0",
        status: "already-claimed",
        leaseExpiresAt: "2026-09-01T00:02:00.000Z",
      },
    }));
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      webSocket: () => Promise.resolve(scripted([frame(command())]).socket),
      run: () => {
        ran += 1;
        return Promise.resolve({
          finishedAt: "2026-09-01T00:00:01.000Z",
          outcome: "ok",
          truncated: false,
        });
      },
    });

    const cycle = await device.connectOnce({ frames: 1 });

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
      if (call.path.endsWith("/claim")) return CLAIMED;
      bodies.push(call.body ?? "");
      return RECORDED;
    });
    const device = agent({
      fetch: backend.fetch,
      secrets: pairedStore(),
      webSocket: () => Promise.resolve(scripted([frame(command())]).socket),
      run: () => Promise.reject(new Error("spawn ENOENT")),
    });

    expect((await device.connectOnce({ frames: 1 })).reported).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      outcome: "error",
      message: "spawn ENOENT",
    });
  });

  test("a refused upgrade with a 401 forgets the token and stops the loop", async () => {
    const secrets = pairedStore();
    const device = agent({
      fetch: server(() => ({})).fetch,
      secrets,
      webSocket: () =>
        Promise.reject(
          new MachineDeviceAgentError(401, "machine token is invalid"),
        ),
    });

    const cycle = await device.connectOnce();

    expect(cycle.unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
    expect(device.status()).toMatchObject({
      enrolled: false,
      running: false,
      lastError: "this machine was revoked; pair it again to reconnect",
    });
  });

  test("an opaque refusal is told apart by a plain GET of the same route", async () => {
    const secrets = pairedStore();
    let status = 426;
    const backend = server(() => ({ status, json: { error: "no" } }));
    const device = agent({
      fetch: backend.fetch,
      secrets,
      webSocket: () => Promise.reject(new Error("WebSocket connection failed")),
    });

    // A live token: the socket failed for some other reason, so back off.
    const live = await device.connectOnce();
    expect(live.unenrolled).toBeUndefined();
    expect(live.error).toBe("WebSocket connection failed");
    expect(backend.calls).toMatchObject([
      {
        path: "/api/machines/m-1/socket",
        method: "GET",
        authorization: "Bearer machine-token",
      },
    ]);

    // A dead one: un-enrol.
    status = 401;
    expect((await device.connectOnce()).unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
  });

  test("a socket closed as revoked forgets the token", async () => {
    const secrets = pairedStore();
    const device = agent({
      fetch: server(() => ({})).fetch,
      secrets,
      webSocket: () =>
        Promise.resolve(
          scripted([
            frame(),
            {
              type: "close",
              code: MACHINE_SOCKET_REVOKED_CODE_V1,
              reason: "revoked",
            },
          ]).socket,
        ),
    });

    const cycle = await device.connectOnce();

    expect(cycle.frames).toBe(1);
    expect(cycle.unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
  });

  test("a 401 on a claim forgets the token", async () => {
    const secrets = pairedStore();
    const device = agent({
      fetch: server(() => ({ status: 401, json: { error: "invalid" } })).fetch,
      secrets,
      webSocket: () => Promise.resolve(scripted([frame(command())]).socket),
    });

    expect((await device.connectOnce()).unenrolled).toBe(true);
    expect(await secrets.read()).toBeUndefined();
  });

  test("a dropped socket is one failure; a connection that opens resets the count", async () => {
    const secrets = pairedStore();
    const device = agent({
      fetch: server(() => ({})).fetch,
      secrets,
      webSocket: () =>
        Promise.resolve(
          scripted([{ type: "close", code: 1006, reason: "" }]).socket,
        ),
    });

    const first = await device.connectOnce();
    const second = await device.connectOnce();

    expect(first.error).toBe("the socket closed (1006)");
    expect(second.unenrolled).toBeUndefined();
    expect(device.status().failures).toBe(1);
    expect(await secrets.read()).not.toBeUndefined();
  });

  test("a failure to connect at all is counted each time, not forgotten", async () => {
    const secrets = pairedStore();
    const device = agent({
      fetch: server(() => ({ status: 503, json: { error: "closed" } })).fetch,
      secrets,
      webSocket: () => Promise.reject(new Error("network is down")),
    });

    await device.connectOnce();
    await device.connectOnce();

    expect(device.status().failures).toBe(2);
    expect(await secrets.read()).not.toBeUndefined();
  });

  test("stopping closes the socket without counting a failure", async () => {
    const line = scripted([frame()]);
    const device = agent({
      fetch: server(() => ({})).fetch,
      secrets: pairedStore(),
      webSocket: () => Promise.resolve(line.socket),
    });
    const controller = new AbortController();

    const running = device.connectOnce({ signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const cycle = await running;

    expect(cycle.frames).toBe(1);
    expect(cycle.error).toBeUndefined();
    expect(device.status().failures).toBe(0);
    expect(line.closed).toEqual([1000]);
  });

  test("unpairing clears the token and leaves the registry alone", async () => {
    const secrets = pairedStore();
    const backend = server(() => ({}));
    const device = agent({ fetch: backend.fetch, secrets });

    const status = await device.unpair();

    expect(status.enrolled).toBe(false);
    expect(await secrets.read()).toBeUndefined();
    // Nothing was asked of the backend: revocation is the browser's.
    expect(backend.calls).toEqual([]);
  });
});

describe("machine socket adapters", () => {
  test("a platform socket's frames are read in order, then its close forever", async () => {
    const listeners = new Map<
      string,
      (event: { data?: unknown; code?: number; reason?: string }) => void
    >();
    const socket = machineSocketFromWebSocketV1({
      addEventListener: (type, listener) => listeners.set(type, listener),
      send: () => {},
      close: () => {},
    });
    const waiting = socket.receive();
    listeners.get("message")?.({ data: "one" });
    listeners.get("message")?.({ data: "two" });
    listeners.get("close")?.({ code: 1001, reason: "going away" });
    listeners.get("message")?.({ data: "after" });
    expect(await waiting).toEqual({ type: "message", data: "one" });
    expect(await socket.receive()).toEqual({ type: "message", data: "two" });
    const closed = { type: "close", code: 1001, reason: "going away" } as const;
    expect(await socket.receive()).toEqual(closed);
    expect(await socket.receive()).toEqual(closed);
  });

  test("a fetch upgrade that is refused carries its status", async () => {
    const seen: Headers[] = [];
    const open = fetchUpgradeMachineWebSocketV1((input, init) => {
      expect(input).toBe("https://bot.example.com/api/machines/m-1/socket");
      seen.push(new Headers(init?.headers));
      return Promise.resolve(Response.json({ error: "no" }, { status: 401 }));
    });
    const refused = await open(
      "wss://bot.example.com/api/machines/m-1/socket",
      "machine-token",
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MachineDeviceAgentError);
    expect((refused as MachineDeviceAgentError).status).toBe(401);
    expect(seen[0]?.get("authorization")).toBe("Bearer machine-token");
    expect(seen[0]?.get("upgrade")).toBe("websocket");
  });
});
