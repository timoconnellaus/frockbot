// The deployment's inbound email directory: which User and Bot an address
// token names.
//
// Email Routing hands every message for the deployment's domain to one
// handler, naming only the recipient. A User Durable Object is addressed by
// User, so something deployment-wide has to answer "whose is this?" first.
// That is this directory, kept by the singleton `DeploymentPolicy` object
// inside one synchronous transaction per call. It is an index, not the
// authority: the User's own object holds each Bot's address and checks the
// token again, so an entry this directory kept too long only ever costs a
// refusal.
//
// A token is stored as its digest, never as itself.

/** The synchronous key-value half of SQLite-backed Durable Object storage. */
export interface InboundEmailDirectoryKvV1 {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
}

const ADDRESS_PREFIX = "email:address:v1:";
/**
 * Each Bot's digest the other way round, so a rotation can retire the old
 * one and a deleted account's entries can be found by User. A User id may
 * hold `:`, never `/`.
 */
const BOT_PREFIX = "email:bot:v1:";

interface StoredAddressV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
}

function userPrefix(userId: string): string {
  return `${BOT_PREFIX}${userId}/`;
}

function botKey(userId: string, botId: string): string {
  return `${userPrefix(userId)}${botId}`;
}

function storedAddress(value: unknown): StoredAddressV1 | undefined {
  const address = value as StoredAddressV1 | undefined;
  return address?.schemaVersion === 1 &&
    typeof address.userId === "string" &&
    typeof address.botId === "string"
    ? address
    : undefined;
}

/** This Bot's address is now this digest; the one before it stops working. */
export function registerInboundAddressV1(
  kv: InboundEmailDirectoryKvV1,
  entry: { userId: string; botId: string; tokenDigest: string },
): void {
  releaseInboundAddressV1(kv, entry);
  kv.put(ADDRESS_PREFIX + entry.tokenDigest, {
    schemaVersion: 1,
    userId: entry.userId,
    botId: entry.botId,
  } satisfies StoredAddressV1);
  kv.put(botKey(entry.userId, entry.botId), entry.tokenDigest);
}

/** This Bot has no address any more. */
export function releaseInboundAddressV1(
  kv: InboundEmailDirectoryKvV1,
  entry: { userId: string; botId: string },
): boolean {
  const key = botKey(entry.userId, entry.botId);
  const digest = kv.get<string>(key);
  if (typeof digest !== "string") return false;
  const held = storedAddress(kv.get(ADDRESS_PREFIX + digest));
  if (held?.userId === entry.userId && held.botId === entry.botId) {
    kv.delete(ADDRESS_PREFIX + digest);
  }
  kv.delete(key);
  return true;
}

/** The User and Bot a token's digest names, if any. */
export function resolveInboundAddressV1(
  kv: InboundEmailDirectoryKvV1,
  tokenDigest: string,
): { userId: string; botId: string } | undefined {
  const held = storedAddress(kv.get(ADDRESS_PREFIX + tokenDigest));
  return held ? { userId: held.userId, botId: held.botId } : undefined;
}

/**
 * Everything the directory holds for a User. Deleting an account ends here,
 * so a deleted User's addresses are simply addresses nobody has.
 */
export function forgetInboundEmailUserV1(
  kv: InboundEmailDirectoryKvV1,
  userId: string,
): void {
  const keys = [...kv.list<string>({ prefix: userPrefix(userId) })];
  for (const [key, digest] of keys) {
    if (typeof digest === "string") {
      const held = storedAddress(kv.get(ADDRESS_PREFIX + digest));
      if (held?.userId === userId) kv.delete(ADDRESS_PREFIX + digest);
    }
    kv.delete(key);
  }
}
