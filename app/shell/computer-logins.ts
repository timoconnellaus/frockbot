// Where a User's browser sign-ins are kept: sealed under the credential
// keyring, in the User's Durable Object, and nowhere else.
//
// Two halves, one per object. The Bot's Durable Object holds the capture in
// the clear for as long as one command or one Turn's end takes, seals it with
// the keyring, and hands the User's object only the envelope; the User's
// object holds the one envelope, the debt an Update or a Reset records, when
// the User last deleted the Computer, and the rules for all three. The plaintext never crosses between the two, and it
// never reaches the Workspace, a durable root, a log, or a model request.
//
// The capture is compressed before it is sealed, because a browser's cookie
// jar is highly repetitive text and has to fit one Durable Object value.
import {
  decodeCredentialEnvelopeV1,
  openCredentialV1,
  parseCredentialKeyringV1,
  sealCredentialV1,
  type CredentialEnvelopeV1,
} from "@frockbot/core/connection";
import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";
import type {
  ComputerLoginsKeepOutcomeV1,
  ComputerLoginsKeptV1,
  ComputerLoginVaultV1,
} from "@frockbot/computer/upkeep";
import { rpcJsonSnapshotV1 } from "@frockbot/app/durable-rpc";

/** The User Durable Object key the one kept capture and its debt live under. */
export const COMPUTER_LOGINS_RECORD_KEY = "computer:browser-logins:v1";

/**
 * The most sealed ciphertext kept, in base64url characters. A Durable Object
 * value holds 2 MiB; this leaves the envelope and the record room.
 */
export const COMPUTER_LOGINS_SEALED_MAX_CHARACTERS = 1_500_000;

/**
 * What the keyring's authenticated data binds a capture to. Opening it under
 * any other User, or as any other kind of credential, fails.
 */
function sealContext(userId: string, capturedAt: string) {
  return {
    accountId: userId,
    connectionId: "computer:browser-logins",
    packageId: "computer",
    credentialGeneration: capturedAt,
  };
}

/** One sealed capture, as the User's object keeps it. */
export interface SealedComputerLoginsV1 {
  envelope: CredentialEnvelopeV1;
  count: number;
  capturedAt: string;
}

export interface StoredComputerLoginsV1 {
  version: 1;
  kept?: SealedComputerLoginsV1;
  /** Set by an Update or a Reset, cleared once the sign-ins are back. */
  owedSince?: string;
  /** When the User last deleted the Computer: the fence every rule checks. */
  deletedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function time(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function decodeSealedComputerLoginsV1(
  value: unknown,
): SealedComputerLoginsV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "capturedAt,count,envelope"
  ) {
    throw new Error("Sealed sign-ins are invalid");
  }
  const envelope = decodeCredentialEnvelopeV1(value.envelope);
  if (envelope.ciphertext.length > COMPUTER_LOGINS_SEALED_MAX_CHARACTERS) {
    throw new Error("Sealed sign-ins are too large");
  }
  if (!Number.isSafeInteger(value.count) || (value.count as number) < 0) {
    throw new Error("Sealed sign-ins count is invalid");
  }
  const capturedAt = time(value.capturedAt, "Sealed sign-ins capturedAt");
  if (envelope.credentialGeneration !== capturedAt) {
    throw new Error("Sealed sign-ins are not the capture they name");
  }
  return { envelope, count: value.count as number, capturedAt };
}

export function decodeStoredComputerLoginsV1(
  value: unknown,
): StoredComputerLoginsV1 {
  if (value === undefined) return { version: 1 };
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "kept", "owedSince", "deletedAt"].includes(key),
    )
  ) {
    throw new Error("Stored sign-ins are invalid");
  }
  return {
    version: 1,
    ...(value.kept === undefined
      ? {}
      : { kept: decodeSealedComputerLoginsV1(value.kept) }),
    ...(value.owedSince === undefined
      ? {}
      : { owedSince: time(value.owedSince, "Stored sign-ins owedSince") }),
    ...(value.deletedAt === undefined
      ? {}
      : { deletedAt: time(value.deletedAt, "Stored sign-ins deletedAt") }),
  };
}

/** Whether `deletedAt` is at or after `at`. */
function deletedSince(deletedAt: string | undefined, at: string): boolean {
  return deletedAt !== undefined && Date.parse(deletedAt) >= Date.parse(at);
}

/** The storage the User's object hands the ledger. */
export interface ComputerLoginsStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * The User's object's half: one kept capture, the debt, and the rules.
 *
 * Each method is one read and at most one write with nothing awaited
 * between them but storage, which a Durable Object's input gate keeps whole.
 */
export class ComputerLoginsLedgerV1 {
  constructor(private readonly storage: ComputerLoginsStorageV1) {}

  async read(): Promise<StoredComputerLoginsV1> {
    return decodeStoredComputerLoginsV1(
      await this.storage.get<unknown>(COMPUTER_LOGINS_RECORD_KEY),
    );
  }

  /**
   * What a caller asked for: the debt and the deletion always, the capture
   * only if asked.
   */
  async answer(capture: boolean): Promise<StoredComputerLoginsV1> {
    const stored = await this.read();
    return capture
      ? stored
      : {
          version: 1,
          ...(stored.owedSince ? { owedSince: stored.owedSince } : {}),
          ...(stored.deletedAt ? { deletedAt: stored.deletedAt } : {}),
        };
  }

  /**
   * Keeps a newer capture. Refused while a machine is owed the kept one: its
   * browser has none of them, so its capture would replace the real ones
   * with nothing. A capture made before the User deleted the Computer is
   * stale: keeping it would keep what they asked to have deleted.
   */
  async keep(value: unknown): Promise<ComputerLoginsKeepOutcomeV1> {
    let sealed: SealedComputerLoginsV1;
    try {
      sealed = decodeSealedComputerLoginsV1(value);
    } catch (error) {
      if (error instanceof Error && error.message.includes("too large")) {
        return "too-large";
      }
      throw error;
    }
    const stored = await this.read();
    if (stored.owedSince) return "owed";
    if (deletedSince(stored.deletedAt, sealed.capturedAt)) return "stale";
    if (
      stored.kept &&
      Date.parse(stored.kept.capturedAt) >= Date.parse(sealed.capturedAt)
    ) {
      return "stale";
    }
    await this.storage.put(COMPUTER_LOGINS_RECORD_KEY, {
      ...stored,
      kept: sealed,
    } satisfies StoredComputerLoginsV1);
    return "kept";
  }

  /**
   * The oldest unpaid debt stands; a second owe does not move it. An Update
   * or a Reset asked for before the User deleted the Computer owes nothing:
   * it must not run at all.
   */
  async owe(at: string): Promise<"owed" | "deleted"> {
    const asked = time(at, "Sign-ins owed at");
    const stored = await this.read();
    if (deletedSince(stored.deletedAt, asked)) return "deleted";
    if (stored.owedSince) return "owed";
    await this.storage.put(COMPUTER_LOGINS_RECORD_KEY, {
      ...stored,
      owedSince: asked,
    } satisfies StoredComputerLoginsV1);
    return "owed";
  }

  /** Settles the debt that was read, and never a newer one. */
  async settle(owedSince: string): Promise<void> {
    const stored = await this.read();
    if (stored.owedSince !== owedSince) return;
    const { owedSince: _settled, ...rest } = stored;
    await this.storage.put(COMPUTER_LOGINS_RECORD_KEY, {
      ...rest,
    } satisfies StoredComputerLoginsV1);
  }

  /**
   * "Delete my Computer": the kept sign-ins and any debt go, and `at` is
   * remembered so that nothing asked for or captured before it brings them
   * back. The User's object calls this on both sides of the teardown — before
   * it, so that an Update under way stops before it opens a new machine, and
   * after it, so that a capture that landed in between is dropped too.
   */
  async forget(at: string): Promise<void> {
    const stored = await this.read();
    const deletedAt = deletedSince(stored.deletedAt, at)
      ? stored.deletedAt!
      : time(at, "Sign-ins deleted at");
    await this.storage.put(COMPUTER_LOGINS_RECORD_KEY, {
      version: 1,
      deletedAt,
    } satisfies StoredComputerLoginsV1);
  }
}

/** The User's object, as the Bot's side of the vault calls it. */
export interface ComputerLoginsUserRpcV1 {
  /** `capture: false` answers the debt alone, so no capture travels. */
  readComputerLogins(input: {
    schemaVersion: 1;
    userId: string;
    capture: boolean;
  }): Promise<object>;
  keepComputerLogins(input: {
    schemaVersion: 1;
    userId: string;
    kept: object;
  }): Promise<object>;
  oweComputerLogins(input: {
    schemaVersion: 1;
    userId: string;
    at: string;
  }): Promise<object>;
  settleComputerLogins(input: {
    schemaVersion: 1;
    userId: string;
    owedSince: string;
  }): Promise<void>;
}

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const piped = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const KEEP_OUTCOMES: readonly ComputerLoginsKeepOutcomeV1[] = [
  "kept",
  "stale",
  "owed",
  "too-large",
];

/**
 * The Bot's object's half: seal on the way in, open on the way out.
 *
 * Absent without a keyring. A deployment that cannot seal the sign-ins does
 * not keep them, and an Update or a Reset there loses them rather than
 * leaving them in the clear.
 */
export function createComputerLoginVaultV1(input: {
  userId: string;
  keyring: string | undefined;
  user: ComputerLoginsUserRpcV1;
}): ComputerLoginVaultV1 | undefined {
  if (!input.keyring) return undefined;
  const keyring = parseCredentialKeyringV1(input.keyring);
  const { userId, user } = input;
  const read = async (capture: boolean) =>
    decodeStoredComputerLoginsV1(
      rpcJsonSnapshotV1(
        await user.readComputerLogins({ schemaVersion: 1, userId, capture }),
      ),
    );
  return {
    owed: async () => (await read(false)).owedSince,
    async kept(): Promise<ComputerLoginsKeptV1 | undefined> {
      const { kept } = await read(true);
      if (!kept) return undefined;
      const opened = await openCredentialV1({
        keyring,
        context: sealContext(userId, kept.capturedAt),
        envelope: kept.envelope,
      });
      return {
        state: await transform(
          base64urlDecodeV1(opened),
          new DecompressionStream("gzip"),
        ),
        count: kept.count,
        capturedAt: kept.capturedAt,
      };
    },
    async keep(capture) {
      const compressed = await transform(
        capture.state,
        new CompressionStream("gzip"),
      );
      const envelope = await sealCredentialV1({
        keyring,
        context: sealContext(userId, capture.capturedAt),
        plaintext: base64urlEncodeV1(compressed),
        createdAt: capture.capturedAt,
      });
      if (envelope.ciphertext.length > COMPUTER_LOGINS_SEALED_MAX_CHARACTERS) {
        return "too-large";
      }
      const answer = rpcJsonSnapshotV1(
        await user.keepComputerLogins({
          schemaVersion: 1,
          userId,
          kept: {
            envelope,
            count: capture.count,
            capturedAt: capture.capturedAt,
          } satisfies SealedComputerLoginsV1,
        }),
      ) as { outcome?: unknown };
      const outcome = KEEP_OUTCOMES.find((known) => known === answer.outcome);
      if (!outcome) throw new Error("The kept sign-ins answer is invalid");
      return outcome;
    },
    async owe(at) {
      const answer = rpcJsonSnapshotV1(
        await user.oweComputerLogins({ schemaVersion: 1, userId, at }),
      ) as { outcome?: unknown };
      if (answer.outcome !== "owed" && answer.outcome !== "deleted") {
        throw new Error("The owed sign-ins answer is invalid");
      }
      return answer.outcome;
    },
    settle: (owedSince) =>
      user.settleComputerLogins({ schemaVersion: 1, userId, owedSince }),
    deletedSince: async (at) => deletedSince((await read(false)).deletedAt, at),
  };
}
