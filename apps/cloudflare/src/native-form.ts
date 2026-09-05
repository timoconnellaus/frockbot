import { isProtocolValue } from "@frockbot/protocol-schemas";
import type { NativeSessionStorage } from "./native-sessions.js";

/** A deterministic qualification fixture, never an enabled production Package. */
export function saveNativeQualificationForm(
  storage: NativeSessionStorage,
  userId: string,
  input: unknown,
) {
  if (
    !isProtocolValue("Identifier", userId) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw new Error("Invalid form action");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
      "commandId,input,revision,schemaVersion,surfaceId" ||
    v.schemaVersion !== 1 ||
    v.surfaceId !== "qualification" ||
    v.revision !== 1 ||
    !isProtocolValue("Identifier", v.commandId)
  )
    throw new Error("This form has changed. Please reopen it.");
  if (!v.input || typeof v.input !== "object" || Array.isArray(v.input))
    throw new Error("Invalid form input");
  const fields = v.input as Record<string, unknown>;
  if (
    Object.keys(fields).join() !== "name" ||
    typeof fields.name !== "string" ||
    fields.name.trim().length === 0 ||
    fields.name.length > 120
  )
    throw new Error("Please enter a name.");
  const fingerprint = JSON.stringify({ revision: 1, name: fields.name });
  const key = "native:qualification-form:v1";
  const stored = storage.get<{
    schemaVersion: 1;
    userId: string;
    name: string;
    receipts: Record<
      string,
      {
        fingerprint: string;
        receipt: { schemaVersion: 1; commandId: string; status: "saved" };
      }
    >;
  }>(key);
  if (
    stored &&
    (stored.schemaVersion !== 1 ||
      stored.userId !== userId ||
      typeof stored.name !== "string" ||
      !stored.receipts)
  )
    throw new Error("Invalid stored form");
  const prior = stored?.receipts[v.commandId];
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new Error("That save was already used for a different value.");
    return prior.receipt;
  }
  if (Object.keys(stored?.receipts ?? {}).length >= 64)
    throw new Error("This preview has reached its save limit.");
  const receipt = {
    schemaVersion: 1 as const,
    commandId: v.commandId,
    status: "saved" as const,
  };
  storage.put(key, {
    schemaVersion: 1,
    userId,
    name: fields.name,
    receipts: { ...stored?.receipts, [v.commandId]: { fingerprint, receipt } },
  });
  return receipt;
}
