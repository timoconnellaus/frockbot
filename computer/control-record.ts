/** The Bot Durable Object's Step 1 record for one human control session. */
export const COMPUTER_CONTROL_RECORD_KEY = "computer:control:v1";

export interface StoredComputerControlV1 {
  version: 1;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Computer control record is corrupt");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is corrupt`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error(`${label} is corrupt`);
  return result;
}

export function decodeStoredComputerControlV1(
  value: unknown,
): StoredComputerControlV1 {
  const candidate = record(value);
  const fields = ["version", "ownerId", "acquiredAt", "expiresAt"];
  if (
    candidate.version !== 1 ||
    fields.some((field) => !Object.hasOwn(candidate, field)) ||
    Object.keys(candidate).some((field) => !fields.includes(field))
  ) {
    throw new Error("Computer control record is corrupt");
  }
  return {
    version: 1,
    ownerId: text(candidate.ownerId, "Computer control ownerId"),
    acquiredAt: timestamp(candidate.acquiredAt, "Computer control acquiredAt"),
    expiresAt: timestamp(candidate.expiresAt, "Computer control expiresAt"),
  };
}

export function isStoredComputerControlFreshV1(
  record: StoredComputerControlV1,
  now: Date,
): boolean {
  return Date.parse(record.expiresAt) > now.getTime();
}
