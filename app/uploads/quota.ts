// How much an account holds in uploads, across its Bots.
//
// Kept by the User Durable Object, because the bound is the account's and the
// Bots each hold only their own files. One entry per Bot and upload, so
// sending the same file to the same Bot twice counts once, and a retried
// upload never counts twice; the total beside them is what a new upload is
// checked against. A Bot's entries go when the Bot does.
import {
  isUploadIdV1,
  UPLOAD_ACCOUNT_QUOTA_BYTES_V1,
  UPLOAD_MAX_BYTES_V1,
} from "@frockbot/core/contracts";

export const UPLOAD_QUOTA_TOTAL_KEY_V1 = "uploads:total";
export const UPLOAD_QUOTA_ENTRY_PREFIX_V1 = "uploads:entry:";

function entryPrefix(botId: string): string {
  return `${UPLOAD_QUOTA_ENTRY_PREFIX_V1}${botId}:`;
}

export interface UploadQuotaStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

export type UploadQuotaAnswerV1 =
  | { status: "reserved"; usedBytes: number }
  | { status: "full"; usedBytes: number; quotaBytes: number };

function total(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : 0;
}

/**
 * Counts one upload against the account, once. Run inside the User object's
 * transaction so two uploads cannot both fit into the last gigabyte.
 */
export async function reserveUploadQuotaV1(
  storage: UploadQuotaStorageV1,
  input: { botId: string; uploadId: string; bytes: number },
  quotaBytes = UPLOAD_ACCOUNT_QUOTA_BYTES_V1,
): Promise<UploadQuotaAnswerV1> {
  if (
    !isUploadIdV1(input.uploadId) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > UPLOAD_MAX_BYTES_V1
  ) {
    throw new Error("upload quota request is invalid");
  }
  const key = `${entryPrefix(input.botId)}${input.uploadId}`;
  const used = total(await storage.get<number>(UPLOAD_QUOTA_TOTAL_KEY_V1));
  if ((await storage.get<number>(key)) !== undefined) {
    return { status: "reserved", usedBytes: used };
  }
  if (used + input.bytes > quotaBytes) {
    return { status: "full", usedBytes: used, quotaBytes };
  }
  await storage.put(key, input.bytes);
  await storage.put(UPLOAD_QUOTA_TOTAL_KEY_V1, used + input.bytes);
  return { status: "reserved", usedBytes: used + input.bytes };
}

/**
 * Gives back one page of a deleted Bot's uploads. Answers whether more
 * remain, so a caller repeats until none do; each page is its own
 * transaction, and a repeat after a crash finds only what is still counted.
 */
export async function releaseBotUploadQuotaV1(
  storage: UploadQuotaStorageV1,
  botId: string,
  pageSize = 128,
): Promise<{ released: number; more: boolean }> {
  const page = await storage.list<number>({
    prefix: entryPrefix(botId),
    limit: pageSize,
  });
  if (page.size === 0) return { released: 0, more: false };
  let released = 0;
  for (const bytes of page.values()) released += total(bytes);
  const used = total(await storage.get<number>(UPLOAD_QUOTA_TOTAL_KEY_V1));
  await storage.delete([...page.keys()]);
  await storage.put(UPLOAD_QUOTA_TOTAL_KEY_V1, Math.max(0, used - released));
  return { released, more: page.size === pageSize };
}
