// The stub device agent, and the in-memory storage the store is tested on.
//
// `MachineAgentDriverV1` is the honest half of "no native binary in slice R".
// It is not a mock of the protocol: it speaks the real wire, over an injected
// `fetch` and an injected socket, against the real routes — pair, enroll,
// socket, claim, result — and decodes every answer and frame with the same
// decoders the desktop agent does. What it
// does *not* do is shell out. So the untested surface is `child_process` and
// nothing else, and the day a real agent lands it can be checked byte for byte
// against this one.
//
// It is deliberately scriptable in the ways a laptop actually fails: a command
// it claims and never answers (the machine slept), one it never claims (the
// frame was lost), one it answers twice (the POST was retried), and one it
// claims twice (two agents, or one agent and its own retry).

import {
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachineModuleReportsReceiptV1,
  decodeMachinePairingOfferV1,
  decodeMachineResultReceiptV1,
  decodeMachineSocketFrameV1,
  machineRoutePathV1,
  type MachineCapabilityV1,
  type MachineClaimReceiptV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineListViewV1,
  type MachineModuleReportV1,
  type MachineModuleReportsReceiptV1,
  type MachineModuleV1,
  type MachinePairingOfferV1,
  type MachinePlatformV1,
  type MachineResultReceiptV1,
  type MachineSocketFrameV1,
} from "@frockbot/core/machine-protocol";
import type { MachineStorageV1, MachineStorageWritesV1 } from "./store.js";
import type { MachineSocketsV1 } from "./user.js";
import {
  machineSocketFromWebSocketV1,
  type MachineSocketV1,
  type MachineWebSocketLikeV1,
} from "./device.js";
import { createTransactionalMapStorageV1 } from "../testkit/transactional-map.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface MemoryMachineStorageV1 extends MachineStorageV1 {
  /** Every key currently held, sorted. Useful for asserting purges. */
  keys(): string[];
}

/** The Durable Object's storage contract and nothing more. */
export function createMemoryMachineStorageV1(): MemoryMachineStorageV1 {
  return createTransactionalMapStorageV1<MachineStorageWritesV1>();
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

export interface MemoryMachineSocketsV1 extends MachineSocketsV1 {
  /**
   * Accept one socket for `machineId`, as the Durable Object does, sending
   * `first` down it. Answers the machine's end.
   */
  accept(machineId: string, first: MachineSocketFrameV1): MachineSocketV1;
}

/** The Durable Object's socket list, in memory, for a test with no workerd. */
export function createMemoryMachineSocketsV1(): MemoryMachineSocketsV1 {
  type Listener = Parameters<MachineWebSocketLikeV1["addEventListener"]>[1];
  interface Held {
    emit(type: "message" | "close", event: Parameters<Listener>[0]): void;
  }
  const held = new Map<string, Set<Held>>();
  const sockets = (machineId: string): Set<Held> => {
    const set = held.get(machineId) ?? new Set<Held>();
    held.set(machineId, set);
    return set;
  };
  return {
    accept(machineId, first) {
      const listeners = new Map<string, Listener[]>();
      const entry: Held = {
        emit: (type, event) => {
          for (const listener of listeners.get(type) ?? []) listener(event);
        },
      };
      const end = (code: number, reason: string): void => {
        if (!sockets(machineId).delete(entry)) return;
        entry.emit("close", { code, reason });
      };
      const client = machineSocketFromWebSocketV1({
        addEventListener: (type, listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        send: (text) => {
          if (text === "ping") entry.emit("message", { data: "pong" });
        },
        close: (code = 1000, reason = "") => end(code, reason),
      });
      sockets(machineId).add(entry);
      entry.emit("message", { data: JSON.stringify(first) });
      return client;
    },
    push(machineId, frame) {
      if (frame.type === "commands" && frame.commands.length === 0) return;
      for (const entry of sockets(machineId)) {
        entry.emit("message", { data: JSON.stringify(frame) });
      }
    },
    connected: (machineId) => sockets(machineId).size > 0,
    close(machineId, code, reason) {
      for (const entry of [...sockets(machineId)]) {
        sockets(machineId).delete(entry);
        entry.emit("close", { code, reason });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The stub agent
// ---------------------------------------------------------------------------

/** What the scripted agent does with one command it was handed. */
export type MachineAgentActionV1 =
  | {
      kind: "result";
      result: Omit<MachineCommandResultV1, "schemaVersion" | "commandId">;
      /** Post the result twice, as a retried POST does. */
      twice?: boolean;
    }
  /** Claim it and never answer: the laptop slept. The lease is what recovers. */
  | { kind: "vanish" }
  /** Claim it twice, as two agents — or one agent and its own retry — would. */
  | {
      kind: "double-claim";
      result: Omit<MachineCommandResultV1, "schemaVersion" | "commandId">;
    }
  /** Leave it queued: the frame was lost before it was acted on. */
  | { kind: "ignore" };

export interface MachineAgentDriverOptionsV1 {
  /** Injected: `SELF.fetch` in workerd, a stub in a unit test. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Injected: the same seam the desktop agent is handed. */
  webSocket(url: string, token: string): Promise<MachineSocketV1>;
  /** How long `next` waits for a frame before failing the test. */
  frameTimeoutMs?: number;
  /** The origin every path is resolved against. */
  origin: string;
  label?: string;
  platform?: MachinePlatformV1;
  agentVersion?: string;
  capabilities?: MachineCapabilityV1[];
  /** What to do with a command. Defaults to exit 0 with empty output. */
  handle?(command: MachineCommandV1): Promise<MachineAgentActionV1>;
  now?(): number;
}

export interface MachineAgentRunSummaryV1 {
  delivered: MachineCommandV1[];
  claimed: string[];
  alreadyClaimed: string[];
  reported: string[];
  replayed: string[];
}

export class MachineAgentError extends Error {
  override readonly name = "MachineAgentError";
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`machine agent request failed with ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * A device agent, in TypeScript, with no `child_process`.
 *
 * It holds exactly what a real one does: its machine id and the token it was
 * handed at enrollment. Both are public here — a test needs to present a
 * revoked token and a forged one — and neither is ever written anywhere.
 */
export class MachineAgentDriverV1 {
  machineId: string | undefined;
  token: string | undefined;
  /** Every command this agent has been delivered, in order. */
  readonly delivered: MachineCommandV1[] = [];

  constructor(private readonly options: MachineAgentDriverOptionsV1) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async call(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    const response = await this.options.fetch(`${this.options.origin}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    if (!response.ok) throw new MachineAgentError(response.status, text);
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  }

  /** The status of a call that is expected to be refused. */
  async attempt(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<number> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    const response = await this.options.fetch(`${this.options.origin}${path}`, {
      ...init,
      headers,
    });
    await response.text();
    return response.status;
  }

  /** Present a pairing code and become a registered machine. */
  async enroll(offer: MachinePairingOfferV1 | string): Promise<string> {
    const code = typeof offer === "string" ? offer : offer.code;
    const receipt = decodeMachineEnrollmentReceiptV1(
      await this.call(machineRoutePathV1("enroll"), {
        method: "POST",
        token: code,
        body: JSON.stringify({
          schemaVersion: 1,
          code,
          label: this.options.label ?? "Stub-Machine.local",
          platform: this.options.platform ?? "macos",
          agentVersion: this.options.agentVersion ?? "0.0.1",
          capabilities: this.options.capabilities ?? ["exec", "files"],
        }),
      }),
    );
    this.machineId = receipt.machineId;
    this.token = receipt.token;
    return receipt.token;
  }

  private identity(): { machineId: string; token: string } {
    if (!this.machineId || !this.token) {
      throw new MachineAgentError(401, "this agent has not enrolled");
    }
    return { machineId: this.machineId, token: this.token };
  }

  private socket: MachineSocketV1 | undefined;

  /** Open the machine's socket. Its first frame is waiting on `next`. */
  async connect(): Promise<void> {
    const { machineId, token } = this.identity();
    const url = new URL(
      machineRoutePathV1("socket", { machineId }),
      this.options.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.held.length = 0;
    this.socket = await this.options.webSocket(url.toString(), token);
  }

  /** Close the socket, as a laptop that quits does. */
  disconnect(): void {
    this.socket?.close(1000, "done");
    this.socket = undefined;
  }

  /** Frames read past while waiting for one of another type. */
  private readonly held: MachineSocketFrameV1[] = [];

  /**
   * The next frame of `type` the backend sends. Fails on a closed socket, and
   * on a frame that never comes, rather than hanging the test.
   */
  private async nextFrame<T extends MachineSocketFrameV1["type"]>(
    type: T,
  ): Promise<Extract<MachineSocketFrameV1, { type: T }>> {
    const heldAt = this.held.findIndex((frame) => frame.type === type);
    if (heldAt !== -1) {
      return this.held.splice(heldAt, 1)[0] as Extract<
        MachineSocketFrameV1,
        { type: T }
      >;
    }
    if (!this.socket) await this.connect();
    const socket = this.socket!;
    const timeoutMs = this.options.frameTimeoutMs ?? 5_000;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const event = await Promise.race([
        socket.receive(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MachineAgentError(0, `no frame within ${timeoutMs}ms`),
              ),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (event.type === "close") {
        this.socket = undefined;
        throw new MachineAgentError(
          event.code,
          `the socket closed: ${event.reason}`,
        );
      }
      if (event.data === "pong") continue;
      const frame = decodeMachineSocketFrameV1(JSON.parse(event.data));
      if (frame.type === type) {
        return frame as Extract<MachineSocketFrameV1, { type: T }>;
      }
      this.held.push(frame);
    }
  }

  /** The commands in the next commands frame the backend sends. */
  async next(): Promise<MachineCommandV1[]> {
    const frame = await this.nextFrame("commands");
    this.delivered.push(...frame.commands);
    return frame.commands;
  }

  /** The module list in the next modules frame the backend sends. */
  async nextModules(): Promise<MachineModuleV1[]> {
    return (await this.nextFrame("modules")).modules;
  }

  /** One module's artifact, as the desktop fetches it. */
  async fetchModule(contentHash: string): Promise<Response> {
    const { machineId, token } = this.identity();
    return this.options.fetch(
      `${this.options.origin}${machineRoutePathV1("module", { machineId, contentHash })}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async reportModules(
    reports: MachineModuleReportV1[],
  ): Promise<MachineModuleReportsReceiptV1> {
    const { machineId } = this.identity();
    return decodeMachineModuleReportsReceiptV1(
      await this.call(machineRoutePathV1("moduleReports", { machineId }), {
        method: "POST",
        token: this.token!,
        body: JSON.stringify({ reports }),
      }),
    );
  }

  async claim(commandId: string): Promise<MachineClaimReceiptV1> {
    const { machineId, token } = this.identity();
    return decodeMachineClaimReceiptV1(
      await this.call(machineRoutePathV1("claim", { machineId, commandId }), {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }),
    );
  }

  async report(
    commandId: string,
    result: Omit<MachineCommandResultV1, "schemaVersion" | "commandId">,
  ): Promise<MachineResultReceiptV1> {
    const { machineId, token } = this.identity();
    return decodeMachineResultReceiptV1(
      await this.call(machineRoutePathV1("result", { machineId, commandId }), {
        method: "POST",
        token,
        body: JSON.stringify({
          schemaVersion: 1,
          commandId,
          ...result,
        }),
      }),
    );
  }

  /** The registry as the browser reads it. Only a test ever calls this. */
  async listMachines(
    fetchAsUser: (path: string) => Promise<Response>,
  ): Promise<MachineListViewV1> {
    const response = await fetchAsUser(machineRoutePathV1("list"));
    const text = await response.text();
    if (!response.ok) throw new MachineAgentError(response.status, text);
    return decodeMachineListViewV1(JSON.parse(text) as unknown);
  }

  /**
   * One turn of the agent's loop: the next frame, then claim, run and answer
   * each command in it the script says to. Connects first if it has to.
   */
  async runOnce(): Promise<MachineAgentRunSummaryV1> {
    const commands = await this.next();
    const summary: MachineAgentRunSummaryV1 = {
      delivered: commands,
      claimed: [],
      alreadyClaimed: [],
      reported: [],
      replayed: [],
    };
    for (const command of commands) {
      const action = this.options.handle
        ? await this.options.handle(command)
        : ({
            kind: "result",
            result: {
              finishedAt: new Date(this.now()).toISOString(),
              outcome: "ok",
              truncated: false,
              exitCode: 0,
              stdout: "",
            },
          } satisfies MachineAgentActionV1);
      if (action.kind === "ignore") continue;
      const claimed = await this.claim(command.commandId);
      (claimed.status === "claimed"
        ? summary.claimed
        : summary.alreadyClaimed
      ).push(command.commandId);
      if (action.kind === "vanish") continue;
      if (action.kind === "double-claim") {
        const second = await this.claim(command.commandId);
        summary.alreadyClaimed.push(second.commandId);
        const receipt = await this.report(command.commandId, action.result);
        (receipt.status === "recorded"
          ? summary.reported
          : summary.replayed
        ).push(command.commandId);
        continue;
      }
      const receipt = await this.report(command.commandId, action.result);
      (receipt.status === "recorded"
        ? summary.reported
        : summary.replayed
      ).push(command.commandId);
      if (action.twice) {
        const replay = await this.report(command.commandId, action.result);
        (replay.status === "recorded"
          ? summary.reported
          : summary.replayed
        ).push(command.commandId);
      }
    }
    return summary;
  }
}

/** The pairing offer a browser fetch answered with, decoded. */
export async function readMachinePairingOfferV1(
  response: Response,
): Promise<MachinePairingOfferV1> {
  const text = await response.text();
  if (!response.ok) throw new MachineAgentError(response.status, text);
  return decodeMachinePairingOfferV1(JSON.parse(text) as unknown);
}
