import type { OperationReceiptV1 } from "@frockbot/core/configuration";

/** The durable envelope written beside a User or Bot configuration receipt. */
export interface StoredConfigurationReceiptV1 {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

/**
 * Answers a replay from its durable receipt, but refuses a command id that was
 * reused for a different configuration command.
 */
export function requireMatchingConfigurationReceiptV1(
  stored: StoredConfigurationReceiptV1,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}
