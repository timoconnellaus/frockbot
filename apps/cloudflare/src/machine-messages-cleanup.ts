// Disposable pre-user cleanup for first-party Messages (ADR 0037).
//
// Messages left three shapes no decoder accepts any more: a machine record
// that reports the `messages` capability or carries its permission report, a
// queued command whose op is `messages`, and a Bot's intent for one. The User
// object rewrites the records and drops the commands with their requeue
// counters; the Bot drops its intents. A result carries no op, so results stay.
// Each walk runs once per object, in pages.

const USER_RECEIPT = "maintenance:machine-messages:2026-09-25";
const BOT_RECEIPT = "maintenance:machine-messages-intents:2026-09-25";
const MACHINE_PREFIX = "machine:";
const MACHINE_QUEUE_PREFIX = "machine-queue:";
const MACHINE_REQUEUE_PREFIX = "machine-requeue:";
const MACHINE_INTENT_PREFIX = "machine-command:";
const PAGE = 128;

export interface MachineMessagesCleanupStorageV1 {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: {
    prefix: string;
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, T>>;
}

type Stored = Record<string, unknown>;

function record(value: unknown): Stored | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Stored;
}

function isMessagesOp(value: unknown): boolean {
  return record(record(value)?.op)?.kind === "messages";
}

/** The machine record without Messages, or `undefined` to keep it. */
export function withoutMessagesCapabilityV1(
  value: unknown,
): Stored | undefined {
  const machine = record(value);
  if (!machine) return undefined;
  const capabilities = Array.isArray(machine.capabilities)
    ? machine.capabilities
    : undefined;
  const reportsMessages = capabilities?.includes("messages") === true;
  if (!reportsMessages && !Object.hasOwn(machine, "messagesPermissions"))
    return undefined;
  const { messagesPermissions: _retired, ...kept } = machine;
  return reportsMessages
    ? {
        ...kept,
        capabilities: capabilities!.filter((entry) => entry !== "messages"),
      }
    : kept;
}

async function walk(
  storage: MachineMessagesCleanupStorageV1,
  prefix: string,
  visit: (key: string, value: unknown) => Promise<void>,
): Promise<void> {
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix,
      limit: PAGE,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, value] of page) await visit(key, value);
    if (page.size < PAGE) return;
    startAfter = [...page.keys()].at(-1);
  }
}

export async function cleanUserMachineMessagesV1(
  storage: MachineMessagesCleanupStorageV1,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(USER_RECEIPT)) return;
  let machines = 0;
  let commands = 0;
  await walk(storage, MACHINE_PREFIX, async (key, value) => {
    const cleaned = withoutMessagesCapabilityV1(value);
    if (!cleaned) return;
    await storage.put(key, cleaned);
    machines += 1;
  });
  await walk(storage, MACHINE_QUEUE_PREFIX, async (key, value) => {
    if (!isMessagesOp(value)) return;
    await storage.delete(key);
    const commandId = record(value)?.commandId;
    if (typeof commandId === "string") {
      await storage.delete(`${MACHINE_REQUEUE_PREFIX}${commandId}`);
    }
    commands += 1;
  });
  await storage.put(USER_RECEIPT, {
    at: now.toISOString(),
    machines,
    commands,
  });
}

export async function cleanBotMachineMessagesV1(
  storage: MachineMessagesCleanupStorageV1,
  now: Date = new Date(),
): Promise<void> {
  if (await storage.get(BOT_RECEIPT)) return;
  let intents = 0;
  await walk(storage, MACHINE_INTENT_PREFIX, async (key, value) => {
    if (!isMessagesOp(value)) return;
    await storage.delete(key);
    intents += 1;
  });
  await storage.put(BOT_RECEIPT, { at: now.toISOString(), intents });
}
