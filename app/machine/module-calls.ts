// A Plugin's call to its device module, as the User Durable Object runs it
// (ADR 0037, "Out: a Plugin tool calls its module").
//
// The call is keyed by the tool call it runs inside. Its record is written
// before anything is sent, and it is the answer: a Turn replayed after an
// eviction asks under the same id and is told what the record says, so a
// module call is sent at most once whatever happens to the Turn.
//
// The wait is in memory and only as long as the deadline. A result resolves
// the waiter; a deadline with no result settles the call from what the record
// knows — never claimed is `failed`, claimed and unanswered is `unknown`. A
// result that lands after that is kept on the record and reaches no model.

import {
  DEVICE_CALL_WAIT_MS,
  type MachineModuleCallClaimReceiptV1,
  type MachineModuleCallFrameV1,
  type MachineModuleCallResultReceiptV1,
  type MachineModuleCallResultV1,
} from "@frockbot/core/machine-protocol";
import { MachineRegistryError, type MachineStorageV1 } from "./store.js";

export type DeviceCallOutcomeV1 =
  | { ok: true; value: unknown }
  | { ok: false; outcome: "failed" | "unknown"; error: string };

export interface DeviceCallRequestV1 {
  callId: string;
  botId: string;
  pluginId: string;
  moduleId: string;
  call: string;
  input: unknown;
  /** The machine to run it on; absent, the one connected machine running it. */
  deviceId?: string;
}

export const MODULE_CALL_PREFIX_V1 = "machine:module-call:v1:";
/** Long enough for any Turn to be replayed; a record past it is dropped. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
/** The most calls kept, whatever their age. */
const KEEP_MAX = 500;

export const DEVICE_NOT_CONNECTED_V1 =
  "the computer running this module is not connected";

interface ModuleCallRecordV1 {
  schemaVersion: 1;
  callId: string;
  botId: string;
  pluginId: string;
  moduleId: string;
  call: string;
  /** Absent when no machine could take it. */
  machineId?: string;
  sentAt: number;
  deadline: number;
  claimedAt?: number;
  /** What the Turn was told. Once set it never changes. */
  answer?: DeviceCallOutcomeV1;
  /** The result that set the answer, when one did. */
  result?: MachineModuleCallResultV1;
  /** A result that arrived after the answer was settled. */
  late?: MachineModuleCallResultV1;
}

export interface MachineModuleCallsHostV1 {
  storage: MachineStorageV1;
  /**
   * The connected machines that were sent this module with this call
   * declared, by machine id.
   */
  candidates(request: DeviceCallRequestV1): Promise<string[]>;
  push(machineId: string, frame: MachineModuleCallFrameV1): void;
  now?(): number;
  /** How long a call waits; `DEVICE_CALL_WAIT_MS` unless a test says less. */
  waitMs?: number;
}

function key(callId: string): string {
  return `${MODULE_CALL_PREFIX_V1}${callId}`;
}

function failed(error: string): DeviceCallOutcomeV1 {
  return { ok: false, outcome: "failed", error };
}

/** What a call with no result by its deadline was. */
function expired(record: ModuleCallRecordV1): DeviceCallOutcomeV1 {
  return record.claimedAt === undefined
    ? failed("the computer did not start the call before its deadline")
    : {
        ok: false,
        outcome: "unknown",
        error:
          "the computer started the call and did not answer before its deadline; it may have taken effect",
      };
}

export class MachineModuleCallsV1 {
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(private readonly host: MachineModuleCallsHostV1) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  /** Run one call, or answer it from its record. */
  async call(request: DeviceCallRequestV1): Promise<DeviceCallOutcomeV1> {
    const prior = await this.host.storage.get<ModuleCallRecordV1>(
      key(request.callId),
    );
    if (prior) return this.settle(prior);
    const candidates = await this.host.candidates(request);
    let machineId: string | undefined;
    let refusal: string | undefined;
    if (request.deviceId !== undefined) {
      if (candidates.includes(request.deviceId)) machineId = request.deviceId;
      else refusal = DEVICE_NOT_CONNECTED_V1;
    } else if (candidates.length === 1) {
      machineId = candidates[0];
    } else {
      refusal =
        candidates.length === 0
          ? DEVICE_NOT_CONNECTED_V1
          : `more than one connected computer runs this module; name one with deviceId: ${candidates.join(", ")}`;
    }
    const now = this.now();
    const record: ModuleCallRecordV1 = {
      schemaVersion: 1,
      callId: request.callId,
      botId: request.botId,
      pluginId: request.pluginId,
      moduleId: request.moduleId,
      call: request.call,
      ...(machineId === undefined ? {} : { machineId }),
      sentAt: now,
      deadline: now + (this.host.waitMs ?? DEVICE_CALL_WAIT_MS),
      ...(refusal === undefined ? {} : { answer: failed(refusal) }),
    };
    const written = await this.host.storage.transaction(async (storage) => {
      const raced = await storage.get<ModuleCallRecordV1>(key(request.callId));
      if (raced) return raced;
      await storage.put(key(request.callId), record);
      return undefined;
    });
    if (written) return this.settle(written);
    await this.prune(now);
    if (machineId !== undefined) {
      this.host.push(machineId, {
        type: "call",
        callId: request.callId,
        pluginId: request.pluginId,
        moduleId: request.moduleId,
        call: request.call,
        input: request.input,
        deadline: new Date(record.deadline).toISOString(),
        serverTime: new Date(now).toISOString(),
      });
    }
    return this.settle(record);
  }

  /** The record's answer, waiting out its deadline for one if it has none. */
  private async settle(
    record: ModuleCallRecordV1,
  ): Promise<DeviceCallOutcomeV1> {
    if (record.answer) return record.answer;
    const remaining = record.deadline - this.now();
    if (remaining > 0) await this.wait(record.callId, remaining);
    return this.host.storage.transaction(async (storage) => {
      const current = await storage.get<ModuleCallRecordV1>(key(record.callId));
      if (!current) return failed("the call's record is gone");
      if (current.answer) return current.answer;
      const answer = expired(current);
      await storage.put(key(record.callId), { ...current, answer });
      return answer;
    });
  }

  private wait(callId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(callId) ?? new Set();
      this.#waiters.set(callId, waiters);
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.#waiters.delete(callId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  private wake(callId: string): void {
    for (const done of [...(this.#waiters.get(callId) ?? [])]) done();
  }

  /** The desktop starting a call. Only one claim, before the deadline, wins. */
  async claim(
    machineId: string,
    callId: string,
  ): Promise<MachineModuleCallClaimReceiptV1> {
    const now = this.now();
    const claimed = await this.host.storage.transaction(async (storage) => {
      const record = await storage.get<ModuleCallRecordV1>(key(callId));
      if (
        !record ||
        record.machineId !== machineId ||
        record.answer !== undefined ||
        record.claimedAt !== undefined ||
        now >= record.deadline
      ) {
        return false;
      }
      await storage.put(key(callId), { ...record, claimedAt: now });
      return true;
    });
    return {
      schemaVersion: 1,
      status: claimed ? "claimed" : "refused",
      callId,
    };
  }

  /**
   * The desktop's answer. On time, it is the Turn's answer; after the
   * deadline it is kept as `late` and nobody is told.
   */
  async result(
    machineId: string,
    callId: string,
    result: MachineModuleCallResultV1,
  ): Promise<MachineModuleCallResultReceiptV1> {
    const now = this.now();
    const status = await this.host.storage.transaction(async (storage) => {
      const record = await storage.get<ModuleCallRecordV1>(key(callId));
      if (!record || record.machineId !== machineId) {
        throw new MachineRegistryError(404, "module call was not found");
      }
      if (record.result !== undefined || record.late !== undefined) {
        return "replayed" as const;
      }
      if (record.answer !== undefined || now >= record.deadline) {
        await storage.put(key(callId), {
          ...record,
          answer: record.answer ?? expired(record),
          late: result,
        });
        return "late" as const;
      }
      const answer: DeviceCallOutcomeV1 = result.ok
        ? { ok: true, value: result.value }
        : failed(result.error);
      await storage.put(key(callId), { ...record, answer, result });
      return "recorded" as const;
    });
    if (status === "recorded") this.wake(callId);
    return { schemaVersion: 1, status, callId };
  }

  /** The call a late result belongs to, for the Plugin's reports. */
  async describe(
    callId: string,
  ): Promise<{ pluginId: string; moduleId: string; call: string } | undefined> {
    const record = await this.host.storage.get<ModuleCallRecordV1>(key(callId));
    return record
      ? {
          pluginId: record.pluginId,
          moduleId: record.moduleId,
          call: record.call,
        }
      : undefined;
  }

  /** Drop what no Turn can still replay. */
  private async prune(now: number): Promise<void> {
    const stored = await this.host.storage.list<ModuleCallRecordV1>({
      prefix: MODULE_CALL_PREFIX_V1,
    });
    const records = [...stored].sort(
      ([, left], [, right]) => right.sentAt - left.sentAt,
    );
    for (const [index, [name, record]] of records.entries()) {
      if (index >= KEEP_MAX || record.sentAt < now - KEEP_MS) {
        await this.host.storage.delete(name);
      }
    }
  }
}
