import { isProtocolValue, type ClientHello } from "@frockbot/protocol-schemas";

export interface NativeSessionRecord {
  schemaVersion: 1;
  userId: string;
  sessionId: string;
  hello: ClientHello;
  expiresAt: number;
  revoked: boolean;
}

export interface NativeSessionStorage {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

export type NativeSessionOperation = {
  schemaVersion: 1;
  userId: string;
  action: "issue" | "read" | "revoke";
  sessionId: string;
  hello: ClientHello;
  expiresAt: number;
};

export function decodeNativeSessionOperation(
  value: unknown,
): NativeSessionOperation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native session");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
      "action,expiresAt,hello,schemaVersion,sessionId,userId" ||
    v.schemaVersion !== 1 ||
    !isProtocolValue("Identifier", v.userId) ||
    !isProtocolValue("Identifier", v.sessionId) ||
    !isProtocolValue("ClientHello", v.hello) ||
    (v.action !== "issue" && v.action !== "read" && v.action !== "revoke") ||
    typeof v.expiresAt !== "number" ||
    !Number.isSafeInteger(v.expiresAt)
  )
    throw new Error("Invalid native session");
  return {
    schemaVersion: 1,
    userId: v.userId,
    sessionId: v.sessionId,
    hello: v.hello,
    action: v.action,
    expiresAt: v.expiresAt,
  };
}

// Called only inside the User DO's synchronous transaction. Bounded, versioned
// records survive eviction; expiry tombstones cannot be evicted by new logins.
export function nativeSessionOperation(
  storage: NativeSessionStorage,
  input: unknown,
  now: number,
): NativeSessionRecord | null {
  const op = decodeNativeSessionOperation(input);
  const key = "native:sessions:v1";
  const stored = storage.get<unknown>(key);
  if (stored !== undefined && !Array.isArray(stored))
    throw new Error("Invalid stored native sessions");
  const records = (stored ?? []) as unknown[];
  const current: NativeSessionRecord[] = records
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid stored native session");
      const { revoked, ...fields } = value as Record<string, unknown>;
      if (typeof revoked !== "boolean")
        throw new Error("Invalid stored native session");
      const decoded = decodeNativeSessionOperation({
        ...fields,
        action: "read",
      });
      const { action: _action, ...record } = decoded;
      return { ...record, revoked };
    })
    .filter((record) => record.expiresAt > now);
  let record = current.find((item) => item.sessionId === op.sessionId);
  if (op.action === "issue") {
    if (record)
      throw new Error("This sign-in has already been used. Sign in again.");
    if (current.length >= 32)
      throw new Error("Too many active sign-ins. Sign out on another device.");
    if (op.expiresAt <= now || op.expiresAt > now + 7 * 86400_000)
      throw new Error("Invalid native session expiry");
    record = {
      schemaVersion: 1,
      userId: op.userId,
      sessionId: op.sessionId,
      hello: op.hello,
      expiresAt: op.expiresAt,
      revoked: false,
    };
    current.push(record);
  } else if (record) {
    if (
      record.userId !== op.userId ||
      record.expiresAt !== op.expiresAt ||
      JSON.stringify(record.hello) !== JSON.stringify(op.hello)
    )
      return null;
    if (op.action === "revoke") record.revoked = true;
  }
  if (op.action !== "read") storage.put(key, current);
  return record && !record.revoked ? record : null;
}
