// The desktop's module host: the process the Mac app starts under its bundled
// Deno (ADR 0037).
//
// It is the device agent with nothing to execute: it pairs, holds the machine
// socket, and runs the account's device modules. The app speaks to it in one
// JSON object per line over stdin and stdout, and holds what the host must not:
// the machine token rests in the app's Keychain, read and written through
// `native` requests, and Apple Events are the app's to send.
//
//   app → host   start, pair, unpair, reply
//   host → app   native, status, error

import { createInterface } from "node:readline";

import {
  MachineDeviceAgentV1,
  decodeMachineEnrollmentStateV1,
  machineSocketFromWebSocketV1,
  type MachineDeviceAgentStatusV1,
  type MachineSecretStoreV1,
  type MachineSocketV1,
  type MachineWebSocketLikeV1,
} from "@frockbot/app/machine/device";

import {
  ModuleHostV1,
  type ModuleHostCredentialV1,
  type ModuleHostEntryV1,
} from "./modules.ts";

/** How often waiting module reports are posted. */
const REPORT_EVERY_MS = 3_000;

function output(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let nextId = 0;

/** Ask the app for something only it holds. */
function native(method: string, value?: unknown): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    output({ type: "native", id, method, value });
  });
}

let agent: MachineDeviceAgentV1 | undefined;
let modules: ModuleHostV1 | undefined;
let credential: ModuleHostCredentialV1 | undefined;
let agentStatus: MachineDeviceAgentStatusV1 | undefined;
let entries: ModuleHostEntryV1[] = [];
let announced = "";

function announce(): void {
  const status = {
    type: "status",
    enrolled: agentStatus?.enrolled ?? false,
    // The agent resets its failures when the socket opens and counts one when
    // it closes, so a running agent with none is connected.
    connected:
      agentStatus !== undefined &&
      agentStatus.enrolled &&
      agentStatus.running &&
      agentStatus.failures === 0 &&
      agentStatus.lastConnectedAt !== undefined,
    modules: entries,
  };
  const text = JSON.stringify(status);
  if (text === announced) return;
  announced = text;
  output(status);
}

/** The module routes need the token the agent keeps; this sees it pass. */
function remember(raw: string | undefined): void {
  try {
    const state = decodeMachineEnrollmentStateV1(JSON.parse(raw ?? ""));
    credential = { machineId: state.machineId, token: state.token };
  } catch {
    credential = undefined;
  }
}

const secrets: MachineSecretStoreV1 = {
  read: async () => {
    const value = await native("read");
    const raw = typeof value === "string" ? value : undefined;
    remember(raw);
    return raw;
  },
  write: async (value) => {
    await native("write", value);
    remember(value);
  },
  clear: async () => {
    credential = undefined;
    modules?.stopAll();
    await native("clear");
  },
};

function webSocket(url: string, token: string): Promise<MachineSocketV1> {
  return new Promise((resolve, reject) => {
    // Deno's WebSocket takes headers, so the token rides in the same header
    // as on every other machine route.
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    const wrapped = machineSocketFromWebSocketV1(
      socket as unknown as MachineWebSocketLikeV1,
    );
    socket.addEventListener("open", () => resolve(wrapped), { once: true });
    socket.addEventListener(
      "close",
      () => reject(new Error("the socket could not open")),
      { once: true },
    );
  });
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function start(input: Record<string, unknown>): Promise<void> {
  if (agent) throw new Error("the module host is already started");
  const origin = new URL(text(input.origin, "origin")).origin;
  const fetchOnce = (url: string, init?: RequestInit) =>
    fetch(url, { ...init, redirect: "error" });
  modules = new ModuleHostV1({
    origin,
    supportDir: text(input.supportDir, "supportDir"),
    deno: text(input.deno, "deno"),
    runtime: text(input.runtime, "runtime"),
    home: text(input.home, "home"),
    fetch: fetchOnce,
    credential: () => credential,
    appleEvents: async (bundleId, script) =>
      String(await native("appleEvents", { bundleId, script })),
    onChange: (next) => {
      entries = next;
      announce();
    },
  });
  agent = new MachineDeviceAgentV1({
    origin,
    fetch: fetchOnce,
    webSocket,
    secrets,
    // This host runs modules and nothing else: it offers no capability, and a
    // command that reaches it anyway is answered, never run.
    runner: {
      run: () =>
        Promise.resolve({
          finishedAt: new Date().toISOString(),
          outcome: "error",
          truncated: false,
          message: "this Mac runs device modules only",
        }),
    },
    label: text(input.label, "label"),
    platform: "macos",
    agentVersion: text(input.version, "version"),
    capabilities: [],
    onStatus: (status) => {
      agentStatus = status;
      if (!status.enrolled) modules?.stopAll();
      announce();
    },
    onModules: (list) => {
      void modules?.sync(list);
    },
    onCall: (call) => {
      void modules?.handleCall(call);
    },
  });
  await agent.paired();
  agent.start();
  setInterval(() => void modules?.flush(), REPORT_EVERY_MS);
}

async function command(input: Record<string, unknown>): Promise<void> {
  if (input.type === "start") {
    await start(input);
    return;
  }
  if (!agent) throw new Error("the module host is not started");
  if (input.type === "pair") {
    await agent.stop();
    try {
      await agent.pair(text(input.code, "code"));
    } finally {
      agent.start();
    }
  } else if (input.type === "unpair") {
    await agent.unpair();
    modules?.stopAll();
    agent.start();
  } else {
    throw new Error(`unknown command "${String(input.type)}"`);
  }
}

let commands = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(line) as Record<string, unknown>;
  } catch {
    output({ type: "error", message: "the app sent a line that is not JSON" });
    return;
  }
  if (input.type === "reply") {
    const request = pending.get(Number(input.id));
    pending.delete(Number(input.id));
    if (typeof input.error === "string")
      request?.reject(new Error(input.error));
    else request?.resolve(input.value ?? undefined);
    return;
  }
  commands = commands
    .then(() => command(input))
    .catch((error: unknown) =>
      output({ type: "error", message: message(error) }),
    );
});
// The app closing stdin is the stop; the modules' own stdin closes with ours.
lines.on("close", () => {
  modules?.stopAll();
  process.exit(0);
});
