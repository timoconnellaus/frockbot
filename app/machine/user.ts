// The User backend Contribution: the machine registry's authority.
//
// It is mounted in the User Durable Object beside Settings,
// Credentials, Flock and the rest, and it owns four things and no more — the
// registry rows, the pairing offers, the command queue with its leases, and
// the results. "The User's Durable Object is the authority for everything
// User-scoped", and a machine is a User asset: a Bot reaches one only through
// an enabled Capability, and (from R3) a per-call human approval.
//
// Three seams it does not own:
//
//  * **The secret.** `MACHINE_TOKEN_SECRET` is read from the host, never
//    stored, and used only to mint. The token is handed back exactly once, on
//    the enrollment response; what stays here is `SHA-256(token)`.
//  * **The clock.** Injected, so lease expiry is testable without waiting two
//    minutes.
//  * **The transport.** Nothing here is an HTTP response or a socket. The
//    gateway Contribution turns these answers into a response, and the
//    Durable Object owns the hibernating sockets a machine holds, handing this
//    Contribution only `push`, `connected` and `close`. A socket is never a
//    fact: the queue is durable, so a machine that reconnects is sent the same
//    commands it would have been sent before the drop.

import {
  MACHINE_LIMITS_V1,
  MACHINE_SOCKET_REVOKED_CODE_V1,
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
  type MachineCommandV1,
  type MachineRecordV1,
  type MachineResultReceiptV1,
  type MachineSocketFrameV1,
  type MachineTokenClaimsV1,
} from "@frockbot/core/machine-protocol";
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
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";

/**
 * The sockets registered machines hold to the User Durable Object, tagged by
 * machine. Implemented by the Durable Object, which is the only thing that
 * can see them.
 */
export interface MachineSocketsV1 {
  /** Send one frame to every open socket this machine holds. */
  push(machineId: string, frame: MachineSocketFrameV1): void;
  /** Whether this machine holds any open socket. This is presence. */
  connected(machineId: string): boolean;
  /** Close every socket this machine holds. */
  close(machineId: string, code: number, reason: string): void;
}

export interface MachineUserBackendHost {
  /** The User Durable Object's own storage. */
  storage: MachineStorageV1;
  /**
   * The deployment secret every machine token and pairing code is signed with.
   * Absent closes the door: a pairing is refused rather than offered under a
   * signature nothing could verify.
   */
  readSecret(name: "MACHINE_TOKEN_SECRET"): string | undefined;
  sockets: MachineSocketsV1;
  /** Injected so leases are testable without real time. */
  now?(): number;
}

export class MachineUserBackendContribution {
  readonly packageId = "user-machine";

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
   * the key version, so every token issued before it dies here. Public for
   * the machine routes the Durable Object answers itself: a module's bytes
   * and its reports.
   */
  async authorize(
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
   * A machine opening its socket.
   *
   * Authorized exactly as a claim is, and answered with every command still
   * waiting — including any whose lease lapsed while the machine was away —
   * for the Durable Object to send once the socket is accepted.
   */
  async connect(
    claims: MachineTokenClaimsV1,
    tokenDigest: string,
    machineId: string,
  ): Promise<{ record: MachineRecordV1; frame: MachineSocketFrameV1 }> {
    await this.authorize(claims, tokenDigest, machineId);
    const now = this.now();
    const record = await touchMachineV1(this.host.storage, machineId, now);
    await sweepMachineLeasesV1(this.host.storage, machineId, now);
    return {
      record,
      frame: this.frame(
        await pendingMachineCommandsV1(this.host.storage, machineId),
      ),
    };
  }

  /** A socket closed: the moment is kept as `lastSeenAt`. */
  async disconnected(machineId: string): Promise<void> {
    if ((await readMachineRecordV1(this.host.storage, machineId)) === undefined)
      return;
    await touchMachineV1(this.host.storage, machineId, this.now());
  }

  private frame(commands: MachineCommandV1[]): MachineSocketFrameV1 {
    return {
      type: "commands",
      commands,
      serverTime: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Expire this machine's lapsed leases and offer what was re-queued to its
   * open sockets, so a command whose agent stalled is offered again without
   * the machine having to reconnect.
   */
  private async sweep(machineId: string, now: number): Promise<void> {
    const { requeued } = await sweepMachineLeasesV1(
      this.host.storage,
      machineId,
      now,
    );
    if (requeued.length === 0) return;
    const pending = await pendingMachineCommandsV1(
      this.host.storage,
      machineId,
    );
    this.host.sockets.push(
      machineId,
      this.frame(
        pending.filter((command) => requeued.includes(command.commandId)),
      ),
    );
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
    await this.sweep(machineId, now);
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
      (machineId) => this.host.sockets.connected(machineId),
    );
  }

  async revoke(machineId: string): Promise<MachineListViewV1> {
    await revokeMachineV1(this.host.storage, machineId, this.now());
    // Its token is already dead, so the socket it holds is closed rather than
    // left to receive nothing; its next connect is a 401.
    this.host.sockets.close(
      machineId,
      MACHINE_SOCKET_REVOKED_CODE_V1,
      "revoked",
    );
    return this.list();
  }

  /**
   * Put one approved command on a machine's queue.
   *
   * R3's approval settlement is the caller that matters. It is here in R2
   * because the queue, its quota and its idempotency are this object's rules.
   * A queued command is pushed down the machine's socket at once; a machine
   * with none is sent it when it next connects.
   */
  async dispatch(command: unknown): Promise<MachineDispatchOutcomeV1> {
    const now = this.now();
    const outcome = await dispatchMachineCommandV1(
      this.host.storage,
      command,
      now,
    );
    if (outcome.status === "queued") {
      const machineId = outcome.command.machineId;
      this.host.sockets.push(machineId, this.frame([outcome.command]));
      await this.sweep(machineId, now);
    }
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
        : {
            entry: machineListEntryV1(
              record,
              this.host.sockets.connected(machineId),
            ),
          }),
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
      : machineListEntryV1(record, this.host.sockets.connected(machineId));
  }
}

/**
 * What an application hands this Contribution: the User's registered machines, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface MachineUserApplicationHostV1 {
  machines: MachineUserBackendHost;
}

/**
 * The manifest's `user` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const userContribution = defineUserBackendContribution<
  MachineUserApplicationHostV1,
  MachineUserBackendContribution
>({
  specifier: "@frockbot/app/machine/user",
  mount: (host, lifecycle) =>
    lifecycle.mount(new MachineUserBackendContribution(host.machines)),
});
