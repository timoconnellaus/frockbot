// The deployment's Telegram directory: which FrockBot User a Telegram account
// speaks for, and the one-time codes that say so.
//
// Telegram posts every update for the platform bot to one webhook, naming the
// sender only by their Telegram id. The gateway is stateless and a User
// Durable Object is addressed by User, so something deployment-wide has to
// answer "whose is this?" before any User's object is touched. That is this
// directory, kept by the singleton `DeploymentPolicy` object inside one
// synchronous transaction per call. It is an index, not the authority on a
// link: the User's own object holds that, and refuses a message from an
// account it no longer links, so an entry left behind by a failed unlink only
// ever costs a refusal.
//
// A code is stored as its digest, never as itself. It exists once, on the
// receipt the app is handed; whoever sends it to the bot proves they were
// shown it.

/** The synchronous key-value half of SQLite-backed Durable Object storage. */
export interface TelegramDirectoryKvV1 {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
}

const CODE_PREFIX = "telegram:code:v1:";
const PENDING_PREFIX = "telegram:pending:v1:";
const ACCOUNT_PREFIX = "telegram:account:v1:";

interface StoredCodeV1 {
  schemaVersion: 1;
  userId: string;
  expiresAt: string;
  /** Set once claimed, so Telegram redelivering the `/start` claims it again. */
  claimedBy?: string;
  /** The User the account was linked to before, answered again on a replay. */
  previousUserId?: string;
}

interface StoredAccountV1 {
  schemaVersion: 1;
  userId: string;
  linkedAt: string;
}

export type TelegramClaimV1 =
  | { status: "claimed"; userId: string; previousUserId?: string }
  | { status: "invalid" };

/** A claim as it crosses back from the directory's object. */
export function decodeTelegramClaimV1(value: unknown): TelegramClaimV1 {
  const claim = value as Record<string, unknown> | undefined;
  if (claim?.status === "invalid") return { status: "invalid" };
  if (
    claim?.status === "claimed" &&
    typeof claim.userId === "string" &&
    (claim.previousUserId === undefined ||
      typeof claim.previousUserId === "string")
  ) {
    return {
      status: "claimed",
      userId: claim.userId,
      ...(typeof claim.previousUserId === "string"
        ? { previousUserId: claim.previousUserId }
        : {}),
    };
  }
  throw new Error("Telegram link claim is invalid");
}

function storedCode(value: unknown): StoredCodeV1 | undefined {
  const code = value as StoredCodeV1 | undefined;
  return code?.schemaVersion === 1 &&
    typeof code.userId === "string" &&
    typeof code.expiresAt === "string"
    ? code
    : undefined;
}

function storedAccount(value: unknown): StoredAccountV1 | undefined {
  const account = value as StoredAccountV1 | undefined;
  return account?.schemaVersion === 1 && typeof account.userId === "string"
    ? account
    : undefined;
}

/**
 * A new code for this User. Their previous code stops working, claimed or
 * not, which also bounds what the directory holds to one code per User.
 */
export function offerTelegramLinkV1(
  kv: TelegramDirectoryKvV1,
  offer: { userId: string; codeDigest: string; expiresAt: string },
): void {
  const previous = kv.get<string>(PENDING_PREFIX + offer.userId);
  if (typeof previous === "string") kv.delete(CODE_PREFIX + previous);
  kv.put(CODE_PREFIX + offer.codeDigest, {
    schemaVersion: 1,
    userId: offer.userId,
    expiresAt: offer.expiresAt,
  } satisfies StoredCodeV1);
  kv.put(PENDING_PREFIX + offer.userId, offer.codeDigest);
}

/**
 * Spend a code on the Telegram account that sent it.
 *
 * The account is then this User's, whoever it was before: holding the code is
 * the proof. `previousUserId` names the User it moves away from, whose own link
 * the caller must drop. A replay by the same account answers the same.
 */
export function claimTelegramLinkV1(
  kv: TelegramDirectoryKvV1,
  claim: { codeDigest: string; telegramUserId: string; now: number },
): TelegramClaimV1 {
  const key = CODE_PREFIX + claim.codeDigest;
  const code = storedCode(kv.get(key));
  if (!code) return { status: "invalid" };
  if (code.claimedBy !== undefined) {
    return code.claimedBy === claim.telegramUserId
      ? {
          status: "claimed",
          userId: code.userId,
          ...(code.previousUserId
            ? { previousUserId: code.previousUserId }
            : {}),
        }
      : { status: "invalid" };
  }
  if (!(Date.parse(code.expiresAt) > claim.now)) {
    kv.delete(key);
    if (kv.get<string>(PENDING_PREFIX + code.userId) === claim.codeDigest) {
      kv.delete(PENDING_PREFIX + code.userId);
    }
    return { status: "invalid" };
  }
  const before = storedAccount(kv.get(ACCOUNT_PREFIX + claim.telegramUserId));
  const previousUserId =
    before && before.userId !== code.userId ? before.userId : undefined;
  kv.put(ACCOUNT_PREFIX + claim.telegramUserId, {
    schemaVersion: 1,
    userId: code.userId,
    linkedAt: new Date(claim.now).toISOString(),
  } satisfies StoredAccountV1);
  kv.put(key, {
    ...code,
    claimedBy: claim.telegramUserId,
    ...(previousUserId ? { previousUserId } : {}),
  } satisfies StoredCodeV1);
  return {
    status: "claimed",
    userId: code.userId,
    ...(previousUserId ? { previousUserId } : {}),
  };
}

/** The User a Telegram account speaks for, if any. */
export function resolveTelegramAccountV1(
  kv: TelegramDirectoryKvV1,
  telegramUserId: string,
): string | undefined {
  return storedAccount(kv.get(ACCOUNT_PREFIX + telegramUserId))?.userId;
}

/**
 * Forget an account, but only for the User it still names: an unlink that
 * arrives after the account moved to someone else must not unlink them.
 */
export function releaseTelegramAccountV1(
  kv: TelegramDirectoryKvV1,
  release: { userId: string; telegramUserId: string },
): boolean {
  const key = ACCOUNT_PREFIX + release.telegramUserId;
  if (storedAccount(kv.get(key))?.userId !== release.userId) return false;
  kv.delete(key);
  return true;
}
