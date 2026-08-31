// The stub device agent, and the in-memory storage the store is tested on.
//
// `MachineAgentDriverV1` is the honest half of "no native binary in slice R".
// It is not a mock of the protocol: it speaks the real wire, over an injected
// `fetch`, against the real routes — pair, enroll, poll, claim, result — and
// decodes every answer with the same decoders the desktop agent will. What it
// does *not* do is shell out. So the untested surface is `child_process` and
// nothing else, and the day a real agent lands it can be checked byte for byte
// against this one.
//
// It is deliberately scriptable in the ways a laptop actually fails: a command
// it claims and never answers (the machine slept), one it never claims (the
// poll was lost), one it answers twice (the POST was retried), and one it
// claims twice (two agents, or one agent and its own retry).

import {
  MACHINE_LIMITS_V1,
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachinePollResultV1,
  decodeMachineResultReceiptV1,
  machineRoutePathV1,
  type MachineCapabilityV1,
  type MachineClaimReceiptV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineListViewV1,
  type MachinePairingOfferV1,
  type MachinePlatformV1,
  type MachineResultReceiptV1,
} from "@frockbot/machine-protocol";
import type { MachineStorageV1, MachineStorageWritesV1 } from "./store.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface MemoryMachineStorageV1 extends MachineStorageV1 {
  /** Every key currently held, sorted. Useful for asserting purges. */
  keys(): string[];
}

function reads(map: Map<string, unknown>): MachineStorageWritesV1 {
  return {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(map.get(key) as T | undefined);
    },
    list<T>(options: {
      prefix: string;
      limit?: number;
    }): Promise<Map<string, T>> {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
      return Promise.resolve(new Map(entries as Array<[string, T]>));
    },
    put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(map.delete(key));
    },
  };
}

/** The Durable Object's storage contract and nothing more. */
export function createMemoryMachineStorageV1(): MemoryMachineStorageV1 {
  const map = new Map<string, unknown>();
  const base = reads(map);
  return {
    ...base,
    keys: () => [...map.keys()].sort(),
    async transaction<T>(
      closure: (transaction: MachineStorageWritesV1) => Promise<T>,
    ): Promise<T> {
      const snapshot = new Map(map);
      try {
        return await closure(base);
      } catch (error) {
        map.clear();
        for (const [key, value] of snapshot) map.set(key, value);
        throw error;
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
  /** Leave it queued: the poll answer was lost before it was acted on. */
  | { kind: "ignore" };

export interface MachineAgentDriverOptionsV1 {
  /** Injected: `SELF.fetch` in workerd, a stub in a unit test. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
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

  /** One long poll. `waitSeconds` of 0 answers immediately. */
  async poll(waitSeconds = 0): Promise<MachineCommandV1[]> {
    const { machineId, token } = this.identity();
    const answered = decodeMachinePollResultV1(
      await this.call(
        machineRoutePathV1("poll", {
          machineId,
          waitSeconds: Math.min(
            waitSeconds,
            MACHINE_LIMITS_V1.pollMaxWaitSeconds,
          ),
        }),
        { token },
      ),
    );
    this.delivered.push(...answered.commands);
    return answered.commands;
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
   * One turn of the agent's loop: poll, then claim, run and answer each
   * command the script says to.
   */
  async runOnce(waitSeconds = 0): Promise<MachineAgentRunSummaryV1> {
    const commands = await this.poll(waitSeconds);
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
