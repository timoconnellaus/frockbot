import { showClientNotificationV1 } from "@frockbot/plugin-shell/client/notify";
import type { VoicePendingAnswerV1 } from "../shared.js";

const DELIVERED_KEY_V1 = "frockbot.voice.delivered-answers.v1";
const DELIVERED_LIMIT_V1 = 200;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorageV1(): WritableStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readIdsV1(storage: WritableStorage): string[] {
  try {
    const value: unknown = JSON.parse(
      storage.getItem(DELIVERED_KEY_V1) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function claimV1(answerId: string, storage: WritableStorage | undefined) {
  if (!storage) return true;
  try {
    const ids = readIdsV1(storage);
    if (ids.includes(answerId)) return false;
    storage.setItem(
      DELIVERED_KEY_V1,
      JSON.stringify([...ids, answerId].slice(-DELIVERED_LIMIT_V1)),
    );
    return true;
  } catch {
    return true;
  }
}

function releaseV1(answerId: string, storage: WritableStorage | undefined) {
  if (!storage) return;
  try {
    storage.setItem(
      DELIVERED_KEY_V1,
      JSON.stringify(readIdsV1(storage).filter((id) => id !== answerId)),
    );
  } catch {
    // A denied store cannot silence a later notification attempt.
  }
}

/** Shows each pending answer once per browser while durable Voice is off. */
export async function deliverPendingVoiceNotificationsV1(
  answers: readonly VoicePendingAnswerV1[],
  options: {
    storage?: WritableStorage;
    notify?: typeof showClientNotificationV1;
  } = {},
): Promise<number> {
  const storage = options.storage ?? browserStorageV1();
  const notify = options.notify ?? showClientNotificationV1;
  let delivered = 0;
  for (const answer of answers) {
    if (!claimV1(answer.answerId, storage)) continue;
    const result = await notify({
      title: `${answer.botName} answered`,
      body: answer.answer,
    });
    if (result === "unavailable") {
      releaseV1(answer.answerId, storage);
      continue;
    }
    delivered += 1;
  }
  return delivered;
}
