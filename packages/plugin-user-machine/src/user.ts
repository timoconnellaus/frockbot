// The User backend Contribution: the machine registry's authority.
//
// It is mounted into the User Durable Object's Cordis root beside Settings,
// Credentials, Flock and the rest, and it owns four things and no more — the
// registry rows, the pairing offers, the command queue with its leases, and
// the results. "The User's Durable Object is the authority for everything
// User-scoped", and a machine is a User asset: a Bot reaches one only through
// a ready Connection the Bot holds, and (from R3) a per-call human approval.
//
// Three seams it does not own:
//
//  * **The secret.** `MACHINE_TOKEN_SECRET` is read from the host, never
//    stored, and used only to mint. The token is handed back exactly once, on
//    the enrollment response; what stays here is `SHA-256(token)`.
//  * **The clock.** Injected, so presence arithmetic and lease expiry are
//    testable without waiting ninety seconds.
//  * **The transport.** Nothing here is an HTTP response. The gateway
//    Contribution turns these answers into one.
//
// The long poll is the one place this object holds something in memory: a set
// of waiters, so an enqueue can cut a hold short. That memory is a latency
// optimisation and never a fact — an evicted object simply drops the hold, the
// agent's request fails, and its next poll finds the same queue. "Client
// disconnect detaches an observer."

import {
  MACHINE_LIMITS_V1,
  MachineTokenError,
  decodeMachineEnrollmentV1,
  machineListEntryV1,
  machineTokenDigestV1,
  machineTokenMatchesRecordV1,
  mintMachineTokenV1,
  type MachineClaimReceiptV1,
  type MachineCommandResultV1,
  type MachineEnrollmentReceiptV1,
  type MachineListViewV1,
  type MachinePairingOfferV1,
  type MachinePollResultV1,
  type MachineRecordV1,
  type MachineResultReceiptV1,
  type MachineTokenClaimsV1,
} from "@frockbot/machine-protocol";
import type { Plugin } from "cordis";
import {
  machinePairingCodeDigestV1,
  machinePairingNonceV1,
  mintMachinePairingCodeV1,
  type MachinePairingClaimsV1,
} from "./pairing.js";
import {
  decodeMachineResultDeliveryV1,
  machineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "./delivery.js";
import {
  MACHINE_DELIVERY_PREFIX,
  machineDeliveryKeyV1,
} from "./storage-keys.js";
import type { MachineTargetViewV1 } from "./target.js";
import {
  claimMachineCommandV1,
  dispatchMachineCommandV1,
  enrollMachineV1,
  listMachineRecordsV1,
  machineListViewV1,
  machineQuotaSnapshotV1,
  pendingMachineCommandsV1,
  readMachineRecordV1,
  readMachineResultV1,
  recordMachineResultV1,
  revokeMachineV1,
  sweepMachineLeasesV1,
  touchMachineV1,
  writeMachinePairingV1,
  MachineRegistryError,
  type MachineDispatchOutcomeV1,
  type MachineStorageV1,
} from "./store.js";

export interface MachineUserBackendHost {
  /** The User Durable Object's own storage. */
  storage: MachineStorageV1;
  /**
   * The deployment secret every machine token and pairing code is signed with.
   * Absent closes the door: a pairing is refused rather than offered under a
   * signature nothing could verify.
   */
  readSecret(name: "MACHINE_TOKEN_SECRET"): string | undefined;
  /** Injected so presence and leases are testable without real time. */
  now?(): number;
  /** Injected so a test can drive a hold without waiting twenty-five seconds. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class MachineUserBackendContribution {
  readonly packageId = "user-machine";
  /** One set of waiting long polls per machine. Memory, never a fact. */
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(private readonly host: MachineUserBackendHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private secret(): string {
    const secret = this.host.readSecret("MACHINE_TOKEN_SECRET");
    if (!secret) {
      throw new MachineRegistryError(
        503,
        "machine registration is not configured for this deployment",
      );
    }
    return secret;
  }

  /**
   * The machine a presented token is for, or a refusal.
   *
   * The edge already proved the token was minted here. This is the second
   * check, and the authoritative one: the digest must be this machine's, at
   * this key version, and the machine must not be revoked. Revocation bumps
   * the key version, so every token issued before it dies here.
   */
  private async authorize(
    claims: MachineTokenClaimsV1,
    presentedDigest: string,
    machineId: string,
  ): Promise<MachineRecordV1> {
    if (claims.m !== machineId) {
      throw new MachineTokenError(401, "machine token is invalid");
    }
    const record = await readMachineRecordV1(this.host.storage, machineId);
    if (
      !record ||
      !machineTokenMatchesRecordV1(record, claims, presentedDigest)
    ) {
      throw new MachineTokenError(401, "machine token is invalid");
    }
    return record;
  }

  /**
   * A pairing offer, from the authenticated settings surface.
   *
   * The browser is handed the code and the machine id it names; the backend
   * keeps only the digest. Five minutes, one use.
   */
  async createPairing(
    userId: string,
    request: { label?: string } = {},
  ): Promise<MachinePairingOfferV1> {
    const secret = this.secret();
    const now = this.now();
    const registered = await listMachineRecordsV1(this.host.storage);
    if (
      registered.filter((record) => record.revokedAt === undefined).length >=
      MACHINE_LIMITS_V1.maxMachinesPerUser
    ) {
      throw new MachineRegistryError(
        429,
        `Refused: this account holds ${MACHINE_LIMITS_V1.maxMachinesPerUser} registered machines, which is the quota.`,
      );
    }
    const machineId = crypto.randomUUID();
    const code = await mintMachinePairingCodeV1(secret, {
      userId,
      machineId,
      nonce: machinePairingNonceV1(),
    });
    const record = await writeMachinePairingV1(this.host.storage, {
      userId,
      machineId,
      ...(request.label === undefined ? {} : { label: request.label }),
      codeDigest: await machinePairingCodeDigestV1(code),
      now,
    });
    return {
      schemaVersion: 1,
      code,
      machineId,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Enrollment. The offer is spent, the row is written, and the token exists
   * outside this object exactly once — in the response.
   */
  async enroll(
    claims: MachinePairingClaimsV1,
    input: unknown,
  ): Promise<MachineEnrollmentReceiptV1> {
    const secret = this.secret();
    const enrollment = decodeMachineEnrollmentV1(input);
    const token = await mintMachineTokenV1(secret, {
      u: claims.userId,
      m: claims.machineId,
      v: 1,
    });
    const record = await enrollMachineV1(this.host.storage, {
      userId: claims.userId,
      machineId: claims.machineId,
      enrollment,
      codeDigest: await machinePairingCodeDigestV1(enrollment.code),
      tokenDigest: await machineTokenDigestV1(token),
      now: this.now(),
    });
    return {
      schemaVersion: 1,
      machineId: record.machineId,
      token,
      keyVersion: record.keyVersion,
    };
  }

  /**
   * One bounded long poll.
   *
   * Presence is refreshed first, so a machine that is holding a poll is
   * connected for as long as it holds it. The hold ends on the first of: a
   * command being queued, the wait elapsing, or the object being evicted —
   * and the last of those costs nothing, because the queue is durable and the
   * agent polls again.
   */
  async poll(
    claims: MachineTokenClaimsV1,
    tokenDigest: string,
    machineId: string,
    waitSeconds: number,
  ): Promise<MachinePollResultV1> {
    await this.authorize(claims, tokenDigest, machineId);
    await touchMachineV1(this.host.storage, machineId, this.now());
    await sweepMachineLeasesV1(this.host.storage, machineId, this.now());
    let commands = await pendingMachineCommandsV1(this.host.storage, machineId);
    const wait = Math.min(
      Math.max(waitSeconds, 0),
      MACHINE_LIMITS_V1.pollMaxWaitSeconds,
    );
    if (commands.length === 0 && wait > 0) {
      await this.hold(machineId, wait * 1_000);
      commands = await pendingMachineCommandsV1(this.host.storage, machineId);
    }
    return {
      schemaVersion: 1,
      commands,
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  private async hold(machineId: string, ms: number): Promise<void> {
    const sleep = this.host.sleep ?? defaultSleep;
    let wake: (() => void) | undefined;
    const waiters = this.waiting.get(machineId) ?? new Set<() => void>();
    this.waiting.set(machineId, waiters);
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
      waiters.add(resolve);
    });
    try {
      await Promise.race([sleep(ms), woken]);
    } finally {
      if (wake) waiters.delete(wake);
      if (waiters.size === 0) this.waiting.delete(machineId);
    }
  }

  private notify(machineId: string): void {
    const waiters = this.waiting.get(machineId);
    if (!waiters) return;
    for (const wake of [...waiters]) wake();
  }

  async claim(
    claims: MachineTokenClaimsV1,
    tokenDigest: string,
    machineId: string,
    commandId: string,
  ): Promise<MachineClaimReceiptV1> {
    await this.authorize(claims, tokenDigest, machineId);
    const now = this.now();
    await touchMachineV1(this.host.storage, machineId, now);
    await sweepMachineLeasesV1(this.host.storage, machineId, now);
    return claimMachineCommandV1(this.host.storage, machineId, commandId, now);
  }

  async recordResult(
    claims: MachineTokenClaimsV1,
    tokenDigest: string,
    machineId: string,
    commandId: string,
    input: unknown,
  ): Promise<MachineResultReceiptV1> {
    await this.authorize(claims, tokenDigest, machineId);
    const now = this.now();
    await touchMachineV1(this.host.storage, machineId, now);
    const decoded = input as { commandId?: unknown };
    if (
      typeof decoded?.commandId === "string" &&
      decoded.commandId !== commandId
    ) {
      throw new MachineRegistryError(
        400,
        "machine result does not match the request path",
      );
    }
    const { receipt, result, command } = await recordMachineResultV1(
      this.host.storage,
      machineId,
      input,
      now,
    );
    // Only the write that recorded it is delivered. A replayed POST answers
    // `replayed` and tells nobody a second time — "recovery never silently
    // duplicates" applied to a laptop that retried.
    if (receipt.status === "recorded" && command) {
      await this.host.storage.put(
        machineDeliveryKeyV1(result.commandId),
        machineResultDeliveryV1(command, result),
      );
    }
    return receipt;
  }

  /** The `ListMachines` projection, and what the settings section renders. */
  async list(): Promise<MachineListViewV1> {
    return machineListViewV1(
      await listMachineRecordsV1(this.host.storage),
      this.now(),
    );
  }

  async revoke(machineId: string): Promise<MachineListViewV1> {
    await revokeMachineV1(this.host.storage, machineId, this.now());
    // A revoked machine's waiting poll is woken so it stops holding a request
    // it will never be answered on; its next poll is a 401.
    this.notify(machineId);
    return this.list();
  }

  /**
   * Put one approved command on a machine's queue.
   *
   * R3's approval settlement is the caller that matters. It is here in R2
   * because the queue, its quota and its idempotency are this object's rules,
   * and the stub agent has to have something to poll for.
   */
  async dispatch(command: unknown): Promise<MachineDispatchOutcomeV1> {
    const outcome = await dispatchMachineCommandV1(
      this.host.storage,
      command,
      this.now(),
    );
    if (outcome.status === "queued") this.notify(outcome.command.machineId);
    return outcome;
  }

  /**
   * Take every finished command waiting to be told to a Bot.
   *
   * Drained by the Worker that just answered the machine, because the Bot
   * Durable Object namespace is the adapter's and a Durable Object that holds
   * a reference to another one cannot be evicted while it does. Taking is
   * removing: at most once, and losing one costs a preamble line and no
   * durable fact, since the result itself stays readable.
   */
  async takeDeliveries(): Promise<MachineResultDeliveryV1[]> {
    const stored = await this.host.storage.list<unknown>({
      prefix: MACHINE_DELIVERY_PREFIX,
    });
    const taken: MachineResultDeliveryV1[] = [];
    for (const [key, value] of stored) {
      await this.host.storage.delete(key);
      try {
        taken.push(decodeMachineResultDeliveryV1(value, "machine delivery"));
      } catch {
        // A record this Package cannot read is dropped rather than kept
        // forever: the result it points at is still the durable answer.
      }
    }
    return taken;
  }

  /** The full result of one command, read on demand rather than pushed. */
  async readResult(
    commandId: string,
  ): Promise<MachineCommandResultV1 | undefined> {
    return readMachineResultV1(this.host.storage, commandId);
  }

  /** One registry row, for a caller that already knows which machine it wants. */
  async readMachine(machineId: string): Promise<MachineRecordV1 | undefined> {
    return readMachineRecordV1(this.host.storage, machineId);
  }

  /**
   * One machine and the counters a control tool checks its quota against, in
   * one read.
   *
   * A tool has five things to establish before it may ask a person anything,
   * and resolving them one at a time would be four round trips answering
   * against four different instants.
   */
  async describeTarget(machineId: string): Promise<MachineTargetViewV1> {
    const now = this.now();
    const record = await readMachineRecordV1(this.host.storage, machineId);
    const counters = await machineQuotaSnapshotV1(
      this.host.storage,
      machineId,
      now,
    );
    return {
      schemaVersion: 1,
      machineId,
      ...(record === undefined
        ? {}
        : { entry: machineListEntryV1(record, now) }),
      queuedCommands: counters.queuedCommands,
      commandsToday: counters.commandsToday,
      serverTime: new Date(now).toISOString(),
    };
  }

  /** Presence, as the tool and the settings section see it. */
  async describe(machineId: string) {
    const record = await readMachineRecordV1(this.host.storage, machineId);
    return record === undefined
      ? undefined
      : machineListEntryV1(record, this.now());
  }
}

export function createMachineUserBackendPlugin(
  host: MachineUserBackendHost,
  lifecycle: { mount(value: MachineUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(new MachineUserBackendContribution(host));
}
