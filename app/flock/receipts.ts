import {
  FlockDecodeError,
  decodeStoredBotLifecycleReceiptV1,
  decodeStoredFlockReceiptV1,
  type BotLifecycleReceiptV1,
  type FlockReceiptV1,
} from "./shared.js";

/**
 * Reads a User-scoped Flock receipt. The clone is intentional: a replay is a
 * response value, never a mutable view of the durable receipt envelope.
 */
export function readFlockReceiptV1(
  input: unknown | undefined,
  fingerprint: string,
  commandId: string,
): FlockReceiptV1 | undefined {
  if (input === undefined) return undefined;
  const stored = decodeStoredFlockReceiptV1(input);
  if (stored.fingerprint !== fingerprint) {
    throw new FlockDecodeError(`command ID collision: ${commandId}`);
  }
  return structuredClone(stored.receipt);
}

/** Reads a Bot lifecycle receipt with its lifecycle-specific decoder. */
export function readBotLifecycleReceiptV1(
  input: unknown | undefined,
  fingerprint: string,
  commandId: string,
): BotLifecycleReceiptV1 | undefined {
  if (input === undefined) return undefined;
  const stored = decodeStoredBotLifecycleReceiptV1(input);
  if (stored.fingerprint !== fingerprint) {
    throw new FlockDecodeError(`command ID collision: ${commandId}`);
  }
  return structuredClone(stored.receipt);
}
