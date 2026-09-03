// The Bot Durable Object side of Computer presence.
//
// Every command first writes an intent keyed by its idempotency key, then calls
// the provider-neutral Computer. Viewer bearer URLs are the deliberate
// exception to durable state: only the session id and expiry are stored, while
// the URL is held in this Contribution instance until a read projects it.
import {
  computerBotPathKeyV1,
  ComputerError,
  decodeComputerDoctorReportV1,
  type ComputerConnectionProgressV1,
  type ComputerControlLease,
  type ComputerHandle,
} from "@frockbot/computer-core";
import type {
  WorkspaceFilesV1,
  WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  COMPUTER_DOCTOR_ROOT_ID,
  COMPUTER_SCREENSHOTS_ROOT_ID,
  COMPUTER_SCREENSHOT_RETENTION,
} from "./roots.js";
import {
  fileComputerScreenshotV1,
  type ComputerProjectionFileKindV1,
} from "./capture.js";
import {
  ComputerProtocolDecodeError,
  computerCommandFingerprintV1,
  computerUpdateLabelV1,
  decodeComputerCommandReceiptV1,
  decodeComputerCommandV1,
  decodeComputerProgressViewV1,
  type ComputerCommandReceiptV1,
  type ComputerCommandResponse,
  type ComputerCommandV1,
  type ComputerDoctorViewV1,
  type ComputerPhase,
  type ComputerProjectionV1,
  type ComputerProgressViewV1,
  type ComputerScreenshotViewV1,
  type ComputerViewerSessionViewV1,
} from "./protocol.js";
import {
  COMPUTER_CONTROL_RECORD_KEY,
  decodeStoredComputerControlV1,
  isStoredComputerControlFreshV1,
  type StoredComputerControlV1,
} from "./control-record.js";
import { defineBotBackendContribution } from "@frockbot/kernel-contracts/contributions";

export { COMPUTER_CONTROL_RECORD_KEY } from "./control-record.js";

export const COMPUTER_VIEWER_RECORD_KEY = "computer:viewer:v1";
export const COMPUTER_PROVIDER_RECORD_KEY = "computer:provider:v1";
export const COMPUTER_INTENT_PREFIX = "computer:intent:v1:";
export const COMPUTER_RECEIPT_PREFIX = "computer:receipt:v1:";
export const COMPUTER_PENDING_CONNECT_KEY = "computer:pending-connect:v1";
/** Keep a freshly armed alarm pending past the command's output gate. */
export const COMPUTER_CONNECT_START_DELAY_MS = 1_000;
export const COMPUTER_CONNECT_DEFERRAL_MS = 15_000;
export const COMPUTER_CONNECT_WATCHDOG_MS = 60_000;
/**
 * Known writes invalidate immediately; thirty seconds only bounds how long an
 * out-of-band Workspace/sync write can remain hidden.
 */
export const COMPUTER_PROJECTION_FILE_CACHE_TTL_MS = 30_000;

export interface ComputerBotTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface ComputerBotStorage extends ComputerBotTransaction {
  transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ComputerBotBackendHost {
  storage: ComputerBotStorage;
  workspace?: WorkspaceFilesV1;
  providerLabel: string;
  configured: boolean;
  openComputer(
    userId: string,
    botId: string,
    effectId: string,
  ): Promise<ComputerHandle>;
  now?(): Date;
  newId?(): string;
}

interface StoredViewerV1 {
  version: 1;
  id: string;
  expiresAt: string;
}

type StoredProviderPhase =
  "provisioning" | "updating" | "ready" | "disconnected" | "error";

interface StoredProviderAnswerV2 {
  version: 2;
  phase: StoredProviderPhase;
  message: string;
  recordedAt: string;
  progress?: ComputerProgressViewV1;
}

interface StoredIntentV1 {
  version: 1;
  fingerprint: string;
  command: ComputerCommandV1;
  admittedAt: string;
  ownerId?: string;
  acquiredAt?: string;
}

interface StoredReceiptV1 {
  version: 1;
  fingerprint: string;
  receipt: ComputerCommandReceiptV1;
}

interface StoredPendingConnectV1 {
  version: 1;
  userId: string;
  commandId: string;
  admittedAt: string;
  deferredUntil?: string;
}

interface LiveViewer {
  id: string;
  url: string;
  expiresAt: string;
}

interface ProjectionFileCacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is corrupt`);
  }
  return value;
}

function storedText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} is corrupt`);
  return value;
}

function storedTimestamp(value: unknown, label: string): string {
  const result = storedText(value, label);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error(`${label} is corrupt`);
  return result;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} is corrupt`);
  }
}

function decodeStoredViewer(value: unknown): StoredViewerV1 {
  const record = object(value, "Computer viewer record");
  exact(record, ["version", "id", "expiresAt"], [], "Computer viewer record");
  if (record.version !== 1)
    throw new Error("Computer viewer record is corrupt");
  return {
    version: 1,
    id: storedText(record.id, "Computer viewer id"),
    expiresAt: storedTimestamp(record.expiresAt, "Computer viewer expiresAt"),
  };
}

/** Migrates the released V1 shape at the storage read seam. */
function decodeStoredProvider(value: unknown): StoredProviderAnswerV2 {
  const record = object(value, "Computer provider record");
  if (record.version === 1) {
    exact(
      record,
      ["version", "phase", "message", "recordedAt"],
      [],
      "Computer provider record",
    );
  } else {
    exact(
      record,
      ["version", "phase", "message", "recordedAt"],
      ["progress"],
      "Computer provider record",
    );
  }
  if (
    (record.version !== 1 && record.version !== 2) ||
    (record.phase !== "provisioning" &&
      record.phase !== "updating" &&
      record.phase !== "ready" &&
      record.phase !== "disconnected" &&
      record.phase !== "error")
  ) {
    throw new Error("Computer provider record is corrupt");
  }
  return {
    version: 2,
    phase: record.phase,
    message: storedText(record.message, "Computer provider message"),
    recordedAt: storedTimestamp(
      record.recordedAt,
      "Computer provider recordedAt",
    ),
    ...(record.version === 2 && record.progress !== undefined
      ? { progress: decodeComputerProgressViewV1(record.progress) }
      : {}),
  };
}

const CONNECT_PROGRESS_STEPS = [
  { id: "waking", label: "Waking the Computer" },
  { id: "attaching", label: "Attaching the Bot" },
  { id: "starting-desktop", label: "Starting the desktop" },
  { id: "minting-viewer", label: "Minting the secure viewer" },
  { id: "connecting", label: "Connecting to the desktop" },
] as const;

function projectedProgress(
  progress: ComputerConnectionProgressV1,
  startedAt: string,
  updatedAt: string,
): ComputerProgressViewV1 {
  const provisioning = progress.provisioning
    ? { provisioning: { ...progress.provisioning } }
    : {};
  if (progress.kind === "update") {
    return {
      version: 1,
      kind: "update",
      startedAt,
      updatedAt,
      index: progress.index,
      total: progress.total,
      ...provisioning,
      steps: [
        {
          version: 1,
          id: progress.step,
          label: progress.label,
          status: "active",
        },
      ],
    };
  }
  return {
    version: 1,
    kind: "connect",
    startedAt,
    updatedAt,
    index: progress.index,
    total: progress.total,
    ...provisioning,
    steps: CONNECT_PROGRESS_STEPS.map((step, index) => ({
      version: 1,
      ...step,
      status:
        index + 1 < progress.index
          ? ("complete" as const)
          : index + 1 === progress.index
            ? ("active" as const)
            : ("pending" as const),
    })),
  };
}

function connectProjectionRecord(startedAt: string): StoredProviderAnswerV2 {
  const progress = projectedProgress(
    {
      version: 1,
      kind: "connect",
      step: "waking",
      label: "Waking the Computer",
      index: 1,
      total: CONNECT_PROGRESS_STEPS.length,
    },
    startedAt,
    startedAt,
  );
  return {
    version: 2,
    phase: "provisioning",
    message: "Waking and preparing the Computer…",
    recordedAt: startedAt,
    progress,
  };
}

function decodeStoredIntent(value: unknown): StoredIntentV1 {
  const record = object(value, "Computer intent");
  exact(
    record,
    ["version", "fingerprint", "command", "admittedAt"],
    ["ownerId", "acquiredAt"],
    "Computer intent",
  );
  if (record.version !== 1) throw new Error("Computer intent is corrupt");
  const command = decodeComputerCommandV1(record.command);
  return {
    version: 1,
    fingerprint: storedText(record.fingerprint, "Computer intent fingerprint"),
    command,
    admittedAt: storedTimestamp(
      record.admittedAt,
      "Computer intent admittedAt",
    ),
    ...(record.ownerId === undefined
      ? {}
      : { ownerId: storedText(record.ownerId, "Computer intent ownerId") }),
    ...(record.acquiredAt === undefined
      ? {}
      : {
          acquiredAt: storedTimestamp(
            record.acquiredAt,
            "Computer intent acquiredAt",
          ),
        }),
  };
}

function decodeStoredReceipt(value: unknown): StoredReceiptV1 {
  const record = object(value, "Computer receipt record");
  exact(
    record,
    ["version", "fingerprint", "receipt"],
    [],
    "Computer receipt record",
  );
  if (record.version !== 1)
    throw new Error("Computer receipt record is corrupt");
  return {
    version: 1,
    fingerprint: storedText(record.fingerprint, "Computer receipt fingerprint"),
    receipt: decodeComputerCommandReceiptV1(record.receipt),
  };
}

function decodeStoredPendingConnect(value: unknown): StoredPendingConnectV1 {
  const record = object(value, "Computer pending connect");
  exact(
    record,
    ["version", "userId", "commandId", "admittedAt"],
    ["deferredUntil"],
    "Computer pending connect",
  );
  if (record.version !== 1) {
    throw new Error("Computer pending connect is corrupt");
  }
  return {
    version: 1,
    userId: storedText(record.userId, "Computer pending connect userId"),
    commandId: storedText(
      record.commandId,
      "Computer pending connect commandId",
    ),
    admittedAt: storedTimestamp(
      record.admittedAt,
      "Computer pending connect admittedAt",
    ),
    ...(record.deferredUntil === undefined
      ? {}
      : {
          deferredUntil: storedTimestamp(
            record.deferredUntil,
            "Computer pending connect deferredUntil",
          ),
        }),
  };
}

function pendingConnectDeadline(pending: StoredPendingConnectV1): number {
  return Math.max(
    Date.parse(pending.admittedAt),
    pending.deferredUntil === undefined ? 0 : Date.parse(pending.deferredUntil),
  );
}

function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1024,
  );
}

function isFresh(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) > now.getTime();
}

export class ComputerBotBackendContribution {
  #liveViewer?: LiveViewer;
  #scheduledConnect?: Promise<void>;
  readonly #screenshotsCache = new Map<
    string,
    ProjectionFileCacheEntry<ComputerScreenshotViewV1[]>
  >();
  readonly #doctorCache = new Map<
    string,
    ProjectionFileCacheEntry<ComputerDoctorViewV1 | undefined>
  >();

  constructor(private readonly host: ComputerBotBackendHost) {}

  private now(): Date {
    return this.host.now?.() ?? new Date();
  }

  private newId(): string {
    return this.host.newId?.() ?? crypto.randomUUID();
  }

  private projectionKey(userId: string, botId: string): string {
    return `${userId}\u0000${botId}`;
  }

  private cachedProjectionFile<T>(
    cache: Map<string, ProjectionFileCacheEntry<T>>,
    userId: string,
    botId: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const key = this.projectionKey(userId, botId);
    const now = this.now().getTime();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = load();
    const entry: ProjectionFileCacheEntry<T> = {
      expiresAt: now + COMPUTER_PROJECTION_FILE_CACHE_TTL_MS,
      value,
    };
    entry.value = value.catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    return entry.value;
  }

  /** Drops only this Bot/User's resident performance cache after a known write. */
  invalidateProjectionFile(
    userId: string,
    botId: string,
    kind: ComputerProjectionFileKindV1,
  ): void {
    const key = this.projectionKey(userId, botId);
    if (kind === "screenshots") this.#screenshotsCache.delete(key);
    else this.#doctorCache.delete(key);
  }

  private async admit(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<
    | { replay: ComputerCommandReceiptV1 }
    | { intent: StoredIntentV1; fingerprint: string }
  > {
    const fingerprint = computerCommandFingerprintV1(command);
    return this.host.storage.transaction(async (storage) => {
      const receiptValue = await storage.get<unknown>(
        `${COMPUTER_RECEIPT_PREFIX}${command.commandId}`,
      );
      if (receiptValue !== undefined) {
        const stored = decodeStoredReceipt(receiptValue);
        if (stored.fingerprint !== fingerprint) {
          throw new ComputerProtocolDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        }
        return { replay: structuredClone(stored.receipt) };
      }
      const intentKey = `${COMPUTER_INTENT_PREFIX}${command.commandId}`;
      const intentValue = await storage.get<unknown>(intentKey);
      if (intentValue !== undefined) {
        const intent = decodeStoredIntent(intentValue);
        if (intent.fingerprint !== fingerprint) {
          throw new ComputerProtocolDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        }
        if (command.type === "connect") {
          const pendingValue = await storage.get<unknown>(
            COMPUTER_PENDING_CONNECT_KEY,
          );
          let pending: StoredPendingConnectV1;
          if (pendingValue === undefined) {
            // Migration from the held-request implementation: an admitted
            // connect with no receipt is owed durable scheduled work.
            pending = {
              version: 1,
              userId,
              commandId: command.commandId,
              admittedAt: intent.admittedAt,
              deferredUntil: new Date(
                this.now().getTime() + COMPUTER_CONNECT_START_DELAY_MS,
              ).toISOString(),
            };
            await storage.put(COMPUTER_PENDING_CONNECT_KEY, pending);
            await storage.put(
              COMPUTER_PROVIDER_RECORD_KEY,
              connectProjectionRecord(intent.admittedAt),
            );
          } else {
            pending = decodeStoredPendingConnect(pendingValue);
            if (pending.commandId !== command.commandId) {
              throw new ComputerProtocolDecodeError(
                "another Computer connect is already pending",
              );
            }
            if (pendingConnectDeadline(pending) <= this.now().getTime()) {
              pending = {
                ...pending,
                deferredUntil: new Date(
                  this.now().getTime() + COMPUTER_CONNECT_START_DELAY_MS,
                ).toISOString(),
              };
              await storage.put(COMPUTER_PENDING_CONNECT_KEY, pending);
            }
          }
        }
        return { intent, fingerprint };
      }
      const admittedAt = this.now().toISOString();
      const intent = {
        version: 1,
        fingerprint,
        command,
        admittedAt,
        ...(command.type === "takeControl"
          ? { ownerId: `human:${this.newId()}`, acquiredAt: admittedAt }
          : {}),
      } satisfies StoredIntentV1;
      // The durable intent is committed by this transaction before the
      // provider-neutral Computer can be asked to perform an effect.
      await storage.put(intentKey, intent);
      if (command.type === "connect") {
        const pendingValue = await storage.get<unknown>(
          COMPUTER_PENDING_CONNECT_KEY,
        );
        let pending: StoredPendingConnectV1;
        if (pendingValue !== undefined) {
          pending = decodeStoredPendingConnect(pendingValue);
          if (pending.commandId !== command.commandId) {
            throw new ComputerProtocolDecodeError(
              "another Computer connect is already pending",
            );
          }
          if (pendingConnectDeadline(pending) <= this.now().getTime()) {
            pending = {
              ...pending,
              deferredUntil: new Date(
                this.now().getTime() + COMPUTER_CONNECT_START_DELAY_MS,
              ).toISOString(),
            };
            await storage.put(COMPUTER_PENDING_CONNECT_KEY, pending);
          }
        } else {
          pending = {
            version: 1,
            userId,
            commandId: command.commandId,
            admittedAt,
            deferredUntil: new Date(
              this.now().getTime() + COMPUTER_CONNECT_START_DELAY_MS,
            ).toISOString(),
          };
          await storage.put(COMPUTER_PENDING_CONNECT_KEY, pending);
        }
        await storage.put(
          COMPUTER_PROVIDER_RECORD_KEY,
          connectProjectionRecord(admittedAt),
        );
      }
      return { intent, fingerprint };
    });
  }

  private async settle(
    command: ComputerCommandV1,
    fingerprint: string,
    status: "applied" | "rejected",
    failure?: string,
  ): Promise<ComputerCommandReceiptV1> {
    const key = `${COMPUTER_RECEIPT_PREFIX}${command.commandId}`;
    return this.host.storage.transaction(async (storage) => {
      const existingValue = await storage.get<unknown>(key);
      if (existingValue !== undefined) {
        const existing = decodeStoredReceipt(existingValue);
        if (existing.fingerprint !== fingerprint) {
          throw new ComputerProtocolDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        }
        return structuredClone(existing.receipt);
      }
      const common = {
        version: 1 as const,
        commandId: command.commandId,
        type: command.type,
        completedAt: this.now().toISOString(),
      };
      const receipt: ComputerCommandReceiptV1 =
        status === "applied"
          ? { ...common, status }
          : {
              ...common,
              status,
              failure: failure ?? "Computer command failed",
            };
      await storage.put(key, {
        version: 1,
        fingerprint,
        receipt,
      } satisfies StoredReceiptV1);
      if (command.type === "connect") {
        const pendingValue = await storage.get<unknown>(
          COMPUTER_PENDING_CONNECT_KEY,
        );
        if (
          pendingValue !== undefined &&
          decodeStoredPendingConnect(pendingValue).commandId ===
            command.commandId
        ) {
          await storage.delete(COMPUTER_PENDING_CONNECT_KEY);
        }
      }
      return receipt;
    });
  }

  private async withComputer<T>(
    userId: string,
    command: ComputerCommandV1,
    run: (computer: ComputerHandle) => Promise<T>,
  ): Promise<T> {
    const computer = await this.host.openComputer(
      userId,
      command.botId,
      `computer:${command.commandId}`,
    );
    try {
      return await run(computer);
    } finally {
      await computer.close();
    }
  }

  async execute(
    userId: string,
    botId: string,
    input: unknown,
  ): Promise<ComputerCommandResponse> {
    const command = decodeComputerCommandV1(input);
    if (command.botId !== botId) {
      throw new ComputerProtocolDecodeError(
        "Computer command does not match Bot registration",
      );
    }
    const admitted = await this.admit(userId, command);
    if ("replay" in admitted) return admitted.replay;
    if (command.type === "connect") {
      return {
        version: 2,
        commandId: command.commandId,
        type: "connect",
        status: "accepted",
        admittedAt: admitted.intent.admittedAt,
      };
    }
    return this.executeAdmitted(userId, command, admitted);
  }

  private async executeAdmitted(
    userId: string,
    command: ComputerCommandV1,
    admitted: { intent: StoredIntentV1; fingerprint: string },
  ): Promise<ComputerCommandReceiptV1> {
    try {
      switch (command.type) {
        case "connect":
          await this.connect(userId, command);
          break;
        case "takeControl":
          await this.takeControl(userId, command, admitted.intent);
          break;
        case "refreshControl":
          await this.refreshControl(userId, command);
          break;
        case "refreshViewer":
          await this.refreshViewer(userId, command);
          break;
        case "closeViewer":
          await this.closeViewer(userId, command);
          break;
        case "releaseControl":
          await this.releaseControl(userId, command);
          break;
        case "runDoctor":
          await this.runDoctor(userId, command);
          break;
      }
      return this.settle(command, admitted.fingerprint, "applied");
    } catch (error) {
      const failure = failureText(error);
      const updating =
        command.type === "connect" &&
        error instanceof ComputerError &&
        error.code === "updating";
      if (command.type === "refreshViewer") {
        this.#liveViewer = undefined;
        await this.host.storage.delete(COMPUTER_VIEWER_RECORD_KEY);
      }
      const recorded = updating
        ? await this.host.storage.get<unknown>(COMPUTER_PROVIDER_RECORD_KEY)
        : undefined;
      const previousProgress =
        recorded === undefined
          ? undefined
          : decodeStoredProvider(recorded).progress;
      const recordedAt = this.now().toISOString();
      const updateLabel = computerUpdateLabelV1(failure) ?? failure;
      const progress = updating
        ? previousProgress?.kind === "update"
          ? previousProgress
          : projectedProgress(
              {
                version: 1,
                kind: "update",
                step: "updating",
                label: updateLabel,
                index: 1,
                total: 1,
              },
              previousProgress?.startedAt ?? recordedAt,
              recordedAt,
            )
        : undefined;
      await this.host.storage.put(COMPUTER_PROVIDER_RECORD_KEY, {
        version: 2,
        phase:
          command.type === "refreshViewer"
            ? "disconnected"
            : updating
              ? "updating"
              : "error",
        message:
          command.type === "refreshViewer"
            ? `Viewer disconnected: ${failure}`
            : updating
              ? updateLabel
              : failure,
        recordedAt,
        ...(updating && progress ? { progress } : {}),
      } satisfies StoredProviderAnswerV2);
      return this.settle(command, admitted.fingerprint, "rejected", failure);
    }
  }

  private async initializeConnectProjection(startedAt: string): Promise<void> {
    await this.host.storage.put(
      COMPUTER_PROVIDER_RECORD_KEY,
      connectProjectionRecord(startedAt),
    );
  }

  async scheduledDeadlines(storage: ComputerBotTransaction): Promise<number[]> {
    const value = await storage.get<unknown>(COMPUTER_PENDING_CONNECT_KEY);
    if (value === undefined) return [];
    return [pendingConnectDeadline(decodeStoredPendingConnect(value))];
  }

  async deferScheduledWork(storage: ComputerBotTransaction): Promise<void> {
    const value = await storage.get<unknown>(COMPUTER_PENDING_CONNECT_KEY);
    if (value === undefined) return;
    const pending = decodeStoredPendingConnect(value);
    await storage.put(COMPUTER_PENDING_CONNECT_KEY, {
      ...pending,
      deferredUntil: new Date(
        this.now().getTime() + COMPUTER_CONNECT_DEFERRAL_MS,
      ).toISOString(),
    } satisfies StoredPendingConnectV1);
  }

  scheduledWorkInFlight(): boolean {
    return this.#scheduledConnect !== undefined;
  }

  async settleScheduledWork(): Promise<void> {
    if (this.#scheduledConnect) return this.#scheduledConnect;
    const activity = this.armScheduledConnectWatchdog()
      .then(() => this.runScheduledConnect())
      .finally(() => {
        if (this.#scheduledConnect === activity)
          this.#scheduledConnect = undefined;
      });
    this.#scheduledConnect = activity;
    return activity;
  }

  private async armScheduledConnectWatchdog(): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const value = await storage.get<unknown>(COMPUTER_PENDING_CONNECT_KEY);
      if (value === undefined) return;
      const pending = decodeStoredPendingConnect(value);
      await storage.put(COMPUTER_PENDING_CONNECT_KEY, {
        ...pending,
        deferredUntil: new Date(
          this.now().getTime() + COMPUTER_CONNECT_WATCHDOG_MS,
        ).toISOString(),
      } satisfies StoredPendingConnectV1);
    });
  }

  private async runScheduledConnect(): Promise<void> {
    const pendingValue = await this.host.storage.get<unknown>(
      COMPUTER_PENDING_CONNECT_KEY,
    );
    if (pendingValue === undefined) return;
    const pending = decodeStoredPendingConnect(pendingValue);
    const intentValue = await this.host.storage.get<unknown>(
      `${COMPUTER_INTENT_PREFIX}${pending.commandId}`,
    );
    if (intentValue === undefined) {
      throw new Error("Computer pending connect has no durable intent");
    }
    const intent = decodeStoredIntent(intentValue);
    if (intent.command.type !== "connect") {
      throw new Error("Computer pending connect does not match its Bot");
    }
    await this.executeAdmitted(pending.userId, intent.command, {
      intent,
      fingerprint: intent.fingerprint,
    });
  }

  private async connect(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const intentValue = await this.host.storage.get<unknown>(
      `${COMPUTER_INTENT_PREFIX}${command.commandId}`,
    );
    const startedAt =
      intentValue === undefined
        ? this.now().toISOString()
        : decodeStoredIntent(intentValue).admittedAt;
    let progress = projectedProgress(
      {
        version: 1,
        kind: "connect",
        step: "waking",
        label: "Waking the Computer",
        index: 1,
        total: CONNECT_PROGRESS_STEPS.length,
      },
      startedAt,
      startedAt,
    );
    await this.initializeConnectProjection(startedAt);
    const session = await this.withComputer(
      userId,
      command,
      async (computer) => {
        if (!computer.presence) {
          throw new Error("The selected Computer does not support presence");
        }
        const report = async (
          next: ComputerConnectionProgressV1,
        ): Promise<void> => {
          const updatedAt = this.now().toISOString();
          progress = projectedProgress(next, startedAt, updatedAt);
          await this.host.storage.put(COMPUTER_PROVIDER_RECORD_KEY, {
            version: 2,
            phase: next.kind === "update" ? "updating" : "provisioning",
            message: next.label,
            recordedAt: updatedAt,
            progress,
          } satisfies StoredProviderAnswerV2);
        };
        return computer.presence.connect({
          effectId: `computer:${command.commandId}:connect`,
          onProgress: report,
        });
      },
    );
    if (!session.expiresAt) {
      throw new Error("The Computer returned a viewer session with no expiry");
    }
    const stored = {
      version: 1,
      id: session.id,
      expiresAt: session.expiresAt,
    } satisfies StoredViewerV1;
    const updateLabel = computerUpdateLabelV1(session.message);
    const recordedAt = this.now().toISOString();
    if (updateLabel && progress.kind !== "update") {
      progress = projectedProgress(
        {
          version: 1,
          kind: "update",
          step: "updating",
          label: updateLabel,
          index: 1,
          total: 1,
        },
        startedAt,
        recordedAt,
      );
    }
    await this.host.storage.put({
      [COMPUTER_VIEWER_RECORD_KEY]: stored,
      [COMPUTER_PROVIDER_RECORD_KEY]: {
        version: 2,
        phase: updateLabel ? "updating" : "ready",
        message: updateLabel ?? "Computer ready",
        recordedAt,
        ...(updateLabel && progress.kind === "update" ? { progress } : {}),
      } satisfies StoredProviderAnswerV2,
    });
    this.#liveViewer = {
      id: session.id,
      url: session.url,
      expiresAt: session.expiresAt,
    };
  }

  private async takeControl(
    userId: string,
    command: ComputerCommandV1,
    intent: StoredIntentV1,
  ): Promise<void> {
    const currentValue = await this.host.storage.get<unknown>(
      COMPUTER_CONTROL_RECORD_KEY,
    );
    if (currentValue !== undefined) {
      const current = decodeStoredComputerControlV1(currentValue);
      if (isStoredComputerControlFreshV1(current, this.now())) return;
    }
    if (!intent.ownerId || !intent.acquiredAt) {
      throw new Error("Computer control intent has no durable owner");
    }
    const acquired = await this.withComputer(
      userId,
      command,
      async (computer) => {
        if (!computer.control) {
          throw new Error(
            "The selected Computer does not support human control",
          );
        }
        return computer.control.acquire(
          { scope: "desktop-gui", ownerId: intent.ownerId },
          { effectId: `computer:${command.commandId}:take-control` },
        );
      },
    );
    await this.host.storage.put(COMPUTER_CONTROL_RECORD_KEY, {
      version: 1,
      ownerId: intent.ownerId,
      acquiredAt: intent.acquiredAt,
      expiresAt: acquired.expiresAt,
    } satisfies StoredComputerControlV1);
  }

  private async refreshControl(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const currentValue = await this.host.storage.get<unknown>(
      COMPUTER_CONTROL_RECORD_KEY,
    );
    if (currentValue === undefined)
      throw new Error("No control lease is active");
    const current = decodeStoredComputerControlV1(currentValue);
    const renewed = await this.withComputer(
      userId,
      command,
      async (computer) => {
        if (!computer.control) {
          throw new Error(
            "The selected Computer does not support human control",
          );
        }
        const lease: ComputerControlLease = {
          id: current.ownerId,
          expiresAt: current.expiresAt,
        };
        return computer.control.renew(
          lease,
          { scope: "desktop-gui", ownerId: current.ownerId },
          { effectId: `computer:${command.commandId}:refresh-control` },
        );
      },
    );
    await this.host.storage.put(COMPUTER_CONTROL_RECORD_KEY, {
      ...current,
      expiresAt: renewed.expiresAt,
    } satisfies StoredComputerControlV1);
  }

  private async refreshViewer(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const currentValue = await this.host.storage.get<unknown>(
      COMPUTER_VIEWER_RECORD_KEY,
    );
    if (currentValue === undefined)
      throw new Error("No viewer session is active");
    const current = decodeStoredViewer(currentValue);
    const renewed = await this.withComputer(
      userId,
      command,
      async (computer) => {
        if (!computer.viewer) {
          throw new Error("The selected Computer does not support a viewer");
        }
        return computer.viewer.renew(current.id, {
          effectId: `computer:${command.commandId}:refresh-viewer`,
        });
      },
    );
    if (renewed.id !== current.id || !renewed.expiresAt) {
      throw new Error("The Computer returned an invalid viewer renewal");
    }
    await this.host.storage.put({
      [COMPUTER_VIEWER_RECORD_KEY]: {
        version: 1,
        id: renewed.id,
        expiresAt: renewed.expiresAt,
      } satisfies StoredViewerV1,
      [COMPUTER_PROVIDER_RECORD_KEY]: {
        version: 2,
        phase: "ready",
        message: "Computer ready",
        recordedAt: this.now().toISOString(),
      } satisfies StoredProviderAnswerV2,
    });
    this.#liveViewer = {
      id: renewed.id,
      url: renewed.url,
      expiresAt: renewed.expiresAt,
    };
  }

  private async releaseControl(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const currentValue = await this.host.storage.get<unknown>(
      COMPUTER_CONTROL_RECORD_KEY,
    );
    if (currentValue === undefined) return;
    const current = decodeStoredComputerControlV1(currentValue);
    await this.withComputer(userId, command, async (computer) => {
      if (!computer.control) {
        throw new Error("The selected Computer does not support human control");
      }
      await computer.control.release(
        { id: current.ownerId, expiresAt: current.expiresAt },
        { scope: "desktop-gui", ownerId: current.ownerId },
        { effectId: `computer:${command.commandId}:release-control` },
      );
    });
    await this.host.storage.delete(COMPUTER_CONTROL_RECORD_KEY);
  }

  /**
   * Files the frame the User just stopped watching without making close
   * depend on a best-effort capture. A resident, fresh viewer is the proof
   * that this command is attaching to an already-watched desktop rather than
   * waking a hibernated Computer.
   */
  private async closeViewer(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const viewerValue = await this.host.storage.get<unknown>(
      COMPUTER_VIEWER_RECORD_KEY,
    );
    if (viewerValue === undefined || !this.host.workspace) return;
    const viewer = decodeStoredViewer(viewerValue);
    if (
      this.#liveViewer?.id !== viewer.id ||
      !isFresh(viewer.expiresAt, this.now())
    ) {
      return;
    }
    const controlValue = await this.host.storage.get<unknown>(
      COMPUTER_CONTROL_RECORD_KEY,
    );
    if (controlValue !== undefined) {
      const control = decodeStoredComputerControlV1(controlValue);
      if (isStoredComputerControlFreshV1(control, this.now())) return;
    }
    try {
      await this.withComputer(userId, command, async (computer) => {
        const root = this.root(userId, COMPUTER_SCREENSHOTS_ROOT_ID);
        const botKey = computerBotPathKeyV1(command.botId);
        await fileComputerScreenshotV1({
          computer,
          workspace: this.host.workspace!,
          path: { root, path: `${botKey}/user-${command.commandId}.png` },
          writer: { kind: "user", userId },
          botKey,
          effectId: `computer:${command.commandId}:close-viewer-screenshot`,
        });
      });
      this.invalidateProjectionFile(userId, command.botId, "screenshots");
    } catch {
      // Closing the viewer is never held open by an opportunistic capture.
      // In particular, the provider's human-control refusal stays a refusal.
    }
  }

  private async runDoctor(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const report = await this.withComputer(
      userId,
      command,
      async (computer) => {
        if (!computer.doctor) {
          throw new Error("The selected Computer does not support self-checks");
        }
        return computer.doctor.run({
          effectId: `computer:${command.commandId}:doctor`,
        });
      },
    );
    if (!this.host.workspace) {
      throw new Error("The Computer Workspace is unavailable");
    }
    const root = this.root(userId, COMPUTER_DOCTOR_ROOT_ID);
    const path = `${computerBotPathKeyV1(command.botId)}/latest.json`;
    const existing = await this.host.workspace.stat({ root, path });
    const written = await this.host.workspace.write({
      path: { root, path },
      bytes: new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
      writer: { kind: "user", userId },
      expectedGenerationId:
        existing.status === "ok"
          ? existing.entry.generation.generationId
          : null,
      mediaType: "application/json",
    });
    if (written.status !== "ok") {
      throw new Error(
        `The doctor report could not be filed: ${written.reason}`,
      );
    }
    this.invalidateProjectionFile(userId, command.botId, "doctor");
  }

  private root(userId: string, rootId: string): WorkspaceRootV1 {
    return {
      kind: "package-declared",
      userId,
      packageId: "computer",
      rootId,
    };
  }

  private async screenshots(
    userId: string,
    botId: string,
  ): Promise<ComputerScreenshotViewV1[]> {
    return this.cachedProjectionFile(
      this.#screenshotsCache,
      userId,
      botId,
      () => this.loadScreenshots(userId, botId),
    );
  }

  private async loadScreenshots(
    userId: string,
    botId: string,
  ): Promise<ComputerScreenshotViewV1[]> {
    if (!this.host.workspace) return [];
    const root = this.root(userId, COMPUTER_SCREENSHOTS_ROOT_ID);
    const listed = await this.host.workspace.list({
      root,
      prefix: computerBotPathKeyV1(botId),
      limit: COMPUTER_SCREENSHOT_RETENTION,
    });
    if (listed.status !== "ok") return [];
    return listed.entries
      .toSorted((left, right) =>
        right.generation.writtenAt.localeCompare(left.generation.writtenAt),
      )
      .map((entry) => {
        const path = entry.path.path;
        return {
          version: 1,
          path,
          capturedAt: entry.generation.writtenAt,
          contentHash: entry.generation.contentHash,
          url: `/api/bots/${encodeURIComponent(botId)}/workspace/file?path=${encodeURIComponent(
            JSON.stringify({ root, path }),
          )}`,
        };
      });
  }

  private async doctor(
    userId: string,
    botId: string,
  ): Promise<ComputerDoctorViewV1 | undefined> {
    return this.cachedProjectionFile(this.#doctorCache, userId, botId, () =>
      this.loadDoctor(userId, botId),
    );
  }

  private async loadDoctor(
    userId: string,
    botId: string,
  ): Promise<ComputerDoctorViewV1 | undefined> {
    if (!this.host.workspace) return undefined;
    const root = this.root(userId, COMPUTER_DOCTOR_ROOT_ID);
    const read = await this.host.workspace.read({
      root,
      path: `${computerBotPathKeyV1(botId)}/latest.json`,
    });
    if (read.status !== "ok") return undefined;
    try {
      const report = decodeComputerDoctorReportV1(
        JSON.parse(new TextDecoder().decode(read.file.bytes)),
      );
      if (!report) return undefined;
      return {
        version: 1,
        capturedAt: report.capturedAt,
        summary: report.summary,
        checks: report.checks.map((check) => ({ version: 1, ...check })),
      };
    } catch {
      return undefined;
    }
  }

  async read(userId: string, botId: string): Promise<ComputerProjectionV1> {
    const now = this.now();
    const [viewerValue, controlValue, providerValue, screenshots, doctor] =
      await Promise.all([
        this.host.storage.get<unknown>(COMPUTER_VIEWER_RECORD_KEY),
        this.host.storage.get<unknown>(COMPUTER_CONTROL_RECORD_KEY),
        this.host.storage.get<unknown>(COMPUTER_PROVIDER_RECORD_KEY),
        this.screenshots(userId, botId),
        this.doctor(userId, botId),
      ]);
    const viewer =
      viewerValue === undefined ? undefined : decodeStoredViewer(viewerValue);
    const control =
      controlValue === undefined
        ? undefined
        : decodeStoredComputerControlV1(controlValue);
    const provider =
      providerValue === undefined
        ? undefined
        : decodeStoredProvider(providerValue);
    const liveViewer =
      viewer &&
      this.#liveViewer?.id === viewer.id &&
      isFresh(viewer.expiresAt, now)
        ? this.#liveViewer
        : undefined;
    const activeControl =
      control && isStoredComputerControlFreshV1(control, now)
        ? control
        : undefined;
    let phase: ComputerPhase;
    let message: string;
    if (!this.host.configured) {
      phase = "unconfigured";
      message = "No Computer provider is configured for this host";
    } else if (provider?.phase === "disconnected") {
      phase = "disconnected";
      message = provider.message;
    } else if (activeControl) {
      phase = "human-control";
      message = "You have control. Release when finished with private data.";
    } else if (provider?.phase === "error") {
      phase = "error";
      message = provider.message;
    } else if (provider?.phase === "provisioning") {
      phase = "provisioning";
      message = provider.message;
    } else if (provider?.phase === "updating") {
      phase = "updating";
      message = provider.message;
    } else if (liveViewer) {
      phase = "ready";
      message = "Computer ready";
    } else {
      phase = "idle";
      message = viewer
        ? "Reconnect to mint a fresh viewer session"
        : "Persistent Computer available";
    }
    const viewerSession: ComputerViewerSessionViewV1 | undefined = liveViewer
      ? {
          version: 1,
          id: liveViewer.id,
          url: liveViewer.url,
          expiresAt: liveViewer.expiresAt,
        }
      : undefined;
    return {
      version: 1,
      botId,
      providerLabel: this.host.providerLabel,
      phase,
      message,
      ...(provider?.progress &&
      (phase === "provisioning" || phase === "updating")
        ? { progress: provider.progress }
        : {}),
      ...(viewerSession ? { viewerSession } : {}),
      ...(activeControl
        ? {
            controlLease: {
              version: 1,
              ownerId: activeControl.ownerId,
              acquiredAt: activeControl.acquiredAt,
              expiresAt: activeControl.expiresAt,
            },
          }
        : {}),
      screenshots,
      ...(doctor ? { doctor } : {}),
    };
  }
}

export function createComputerBotBackendContribution(
  host: ComputerBotBackendHost,
): ComputerBotBackendContribution {
  return new ComputerBotBackendContribution(host);
}

export function createComputerBotBackendPlugin(
  host: ComputerBotBackendHost,
  lifecycle: { mount(value: ComputerBotBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createComputerBotBackendContribution(host));
}

/**
 * What an application hands this Contribution: the Bot's view of its User's Computer, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface ComputerBotApplicationHostV1 {
  computer: ComputerBotBackendHost;
}

/**
 * The manifest's `bot` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const botContribution = defineBotBackendContribution<
  ComputerBotApplicationHostV1,
  ComputerBotBackendContribution
>({
  specifier: "@frockbot/plugin-computer/bot",
  create: (host, lifecycle) =>
    createComputerBotBackendPlugin(host.computer, lifecycle),
});
