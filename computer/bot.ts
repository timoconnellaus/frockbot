// The Bot Durable Object side of Computer presence.
//
// Every command first writes an intent keyed by its idempotency key, then calls
// the provider-neutral Computer. Viewer bearer URLs are the deliberate
// exception to durable state: only the session id and expiry are stored, while
// the URL is held in this Contribution instance until a read projects it.
import {
  computerBotPathKeyV1,
  COMPUTER_UNCONFIGURED_MESSAGE_V1,
  ComputerError,
} from "@frockbot/computer/core";
import {
  COMPUTER_DEMONSTRATION_MAX_SECONDS_V1,
  decodeComputerDoctorReportV1,
  type ComputerConnectionProgressV1,
  type ComputerControlLease,
  type ComputerDemonstrationCaptureV1,
  type ComputerHostSessionV1,
  type ComputerViewerSession,
} from "@frockbot/computer/core/host";
import {
  decodeMessageAttachmentsV1,
  durableMessageAttachmentV1,
  type MessageAttachmentV1,
  type WorkspaceFilesV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import {
  computerDemonstrationFilesV1,
  type ComputerDemonstrationFileV1,
} from "./demonstration.js";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { COMPUTER_DOCTOR_ROOT_ID } from "./roots.js";
import {
  captureComputerFrameV1,
  type ComputerProjectionFileKindV1,
} from "./capture.js";
import {
  COMPUTER_FRAME_RECORD_KEY,
  computerFrameSinkV1,
  decodeStoredComputerFrameV1,
  type StoredComputerFrameV1,
} from "./frame.js";
import {
  ComputerProtocolDecodeError,
  computerCommandFingerprintV1,
  computerUpdateLabelV1,
  decodeComputerCommandReceiptV1,
  decodeComputerCommandV1,
  decodeComputerProgressViewV1,
  isComputerScheduledCommandV1,
  type ComputerCommandReceiptV1,
  type ComputerCommandResponse,
  type ComputerCommandV1,
  type ComputerDemonstrationViewV1,
  type ComputerDoctorViewV1,
  type ComputerPhase,
  type ComputerProjectionV1,
  type ComputerProgressViewV1,
  type ComputerProvisioningProgressViewV1,
  type ComputerScreenshotViewV1,
  type ComputerViewerSessionViewV1,
} from "./protocol.js";
import {
  COMPUTER_CHECKPOINT_RECORD_KEY,
  decodeStoredComputerCheckpointV1,
  keepComputerLoginsV1,
  noteComputerCheckpointV1,
  restoreOwedComputerLoginsV1,
  type ComputerLoginVaultV1,
} from "./upkeep.js";
import {
  COMPUTER_CONTROL_RECORD_KEY,
  decodeStoredComputerControlV1,
  isStoredComputerControlFreshV1,
  type StoredComputerControlV1,
} from "./control-record.js";
import { defineBotBackendContribution } from "@frockbot/core/contracts/contributions";

export { COMPUTER_CONTROL_RECORD_KEY } from "./control-record.js";
export type { ComputerDemonstrationFileV1 } from "./demonstration.js";

/** Every demonstration this Bot holds, in one bounded record. */
export const COMPUTER_DEMONSTRATIONS_KEY = "computer:demonstrations:v1";
/** How long a recording may run before it stops by itself. */
export const COMPUTER_DEMONSTRATION_SECONDS =
  COMPUTER_DEMONSTRATION_MAX_SECONDS_V1;
/**
 * How long a kept recording lives when nobody deletes it: long enough for the
 * person to send it and for the Bot's draft to be decided on — an approval
 * waits a day by default and a week at most — and no longer.
 */
export const COMPUTER_DEMONSTRATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * How long after a recording should have stopped the alarm collects it: the
 * Computer's recorder notices a lapsed lease within seconds, so this is only
 * the margin for it to have written everything down.
 */
export const COMPUTER_DEMONSTRATION_COLLECT_GRACE_MS = 60_000;
/** How long a collection or deletion the Computer or the store refused waits. */
export const COMPUTER_DEMONSTRATION_RETRY_MS = 5 * 60_000;
/** Attempts before a recording the Computer never hands back is let go. */
const COMPUTER_DEMONSTRATION_ATTEMPTS = 3;
/** Demonstrations one Bot holds at once; the oldest sent one makes room. */
const COMPUTER_DEMONSTRATION_LIMIT = 8;

/** Why a recording was stopped with nothing in it. */
export const COMPUTER_DEMONSTRATION_EMPTY_MESSAGE =
  "Nothing was recorded. Only what you do in the Computer's browser is recorded.";

/**
 * Where a demonstration's files are kept once it stops: the Bot's uploads,
 * counted against the account's upload space like any file the person
 * attaches, so sending one is sending an ordinary message with files.
 */
export interface ComputerDemonstrationStoreV1 {
  /** Keeps the files and answers the attachments a message names them by. */
  keep(input: {
    userId: string;
    botId: string;
    files: ComputerDemonstrationFileV1[];
  }): Promise<MessageAttachmentV1[]>;
  /** Deletes the files and gives their space back. Idempotent. */
  remove(input: {
    userId: string;
    botId: string;
    uploadIds: string[];
  }): Promise<void>;
}

export const COMPUTER_VIEWER_RECORD_KEY = "computer:viewer:v1";
export const COMPUTER_PROVIDER_RECORD_KEY = "computer:provider:v1";
export const COMPUTER_INTENT_PREFIX = "computer:intent:v1:";
export const COMPUTER_RECEIPT_PREFIX = "computer:receipt:v1:";
/**
 * The one scheduled command this Bot owes. Always a connect in the end: an
 * Update or a Reset is a connect with the whole machine changed in front of
 * it, which is why it is held under the connect's key and settles like one.
 */
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
  ): Promise<ComputerHostSessionV1>;
  /** Where a stopped recording's files go. Absent, and nothing is recorded. */
  demonstrations?: ComputerDemonstrationStoreV1;
  /**
   * Where this User's browser sign-ins are kept, sealed. Absent, and nothing
   * is carried off the Computer: an Update or a Reset then loses them, and
   * says nothing it cannot keep.
   */
  loginVault?(userId: string): ComputerLoginVaultV1 | undefined;
  now?(): Date;
  newId?(): string;
}

/**
 * One demonstration: recording, kept and waiting to be sent, or sent and
 * waiting to be deleted. It names its User and Bot because the alarm that
 * collects or expires it has no command to take them from.
 */
type StoredDemonstrationV1 =
  | {
      id: string;
      userId: string;
      botId: string;
      status: "recording";
      /** The human lease the recording belongs to. */
      ownerId: string;
      startedAt: string;
      endsAt: string;
      /** When the alarm next tries to collect it, after a refusal. */
      retryAt?: string;
      attempts?: number;
    }
  | {
      id: string;
      userId: string;
      botId: string;
      status: "ready" | "sent";
      startedAt: string;
      steps: number;
      attachments: MessageAttachmentV1[];
      expiresAt: string;
    };

interface StoredDemonstrationsV1 {
  version: 1;
  entries: StoredDemonstrationV1[];
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
  /**
   * When an Update or a Reset finished changing the machine. A replay after
   * eviction goes straight to bringing the new machine up: discarding or
   * resetting it a second time would throw away what the first attempt
   * already started.
   */
  machineAt?: string;
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

/**
 * The four steps of an Update and of a Reset, as the card lists them. Both
 * are an `update` in the projection's vocabulary — the machine is changing
 * under every Bot of the User — and the step names say which.
 */
const MACHINE_PROGRESS_STEPS = {
  updateComputer: [
    { id: "keeping-sign-ins", label: "Keeping your browser sign-ins" },
    { id: "replacing", label: "Replacing the machine" },
    { id: "preparing", label: "Setting up the new machine" },
    { id: "restoring-sign-ins", label: "Restoring your browser sign-ins" },
  ],
  resetComputer: [
    { id: "keeping-sign-ins", label: "Keeping your browser sign-ins" },
    { id: "resetting", label: "Resetting to the checkpoint" },
    { id: "preparing", label: "Starting the Computer" },
    { id: "restoring-sign-ins", label: "Restoring your browser sign-ins" },
  ],
} as const;

type MachineCommandTypeV1 = keyof typeof MACHINE_PROGRESS_STEPS;

function machineProjectionRecord(
  type: MachineCommandTypeV1,
  index: number,
  startedAt: string,
  updatedAt: string,
  provisioning?: ComputerProvisioningProgressViewV1,
): StoredProviderAnswerV2 {
  const steps = MACHINE_PROGRESS_STEPS[type];
  return {
    version: 2,
    phase: "updating",
    message: steps[index - 1]?.label ?? steps[0].label,
    recordedAt: updatedAt,
    progress: {
      version: 1,
      kind: "update",
      startedAt,
      updatedAt,
      index,
      total: steps.length,
      ...(provisioning ? { provisioning } : {}),
      steps: steps.map((step, position) => ({
        version: 1,
        ...step,
        status:
          position + 1 < index
            ? ("complete" as const)
            : position + 1 === index
              ? ("active" as const)
              : ("pending" as const),
      })),
    },
  };
}

const COMPUTER_DELETED_BEFORE =
  "The Computer was deleted after this was asked for, so nothing was changed. The next time a Bot uses the Computer, it starts a new one.";
const COMPUTER_DELETED_DURING =
  "The Computer was deleted while this was under way. The next time a Bot uses the Computer, it starts a new one.";

/** A refusal after which the machine is exactly as it was. */
function machineUntouched(error: unknown): boolean {
  return (
    error instanceof ComputerError &&
    (error.code === "human-control-active" ||
      error.code === "not-found" ||
      error.code === "conflict" ||
      error.code === "updating")
  );
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
    ["deferredUntil", "machineAt"],
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
    ...(record.machineAt === undefined
      ? {}
      : {
          machineAt: storedTimestamp(
            record.machineAt,
            "Computer pending connect machineAt",
          ),
        }),
  };
}

function decodeStoredDemonstration(value: unknown): StoredDemonstrationV1 {
  const record = object(value, "Computer demonstration");
  const common = {
    id: storedText(record.id, "Computer demonstration id"),
    userId: storedText(record.userId, "Computer demonstration userId"),
    botId: storedText(record.botId, "Computer demonstration botId"),
    startedAt: storedTimestamp(
      record.startedAt,
      "Computer demonstration startedAt",
    ),
  };
  if (record.status === "recording") {
    exact(
      record,
      ["id", "userId", "botId", "status", "ownerId", "startedAt", "endsAt"],
      ["retryAt", "attempts"],
      "Computer demonstration",
    );
    if (
      record.attempts !== undefined &&
      (!Number.isSafeInteger(record.attempts) ||
        (record.attempts as number) < 0)
    ) {
      throw new Error("Computer demonstration attempts is corrupt");
    }
    return {
      ...common,
      status: "recording",
      ownerId: storedText(record.ownerId, "Computer demonstration ownerId"),
      endsAt: storedTimestamp(record.endsAt, "Computer demonstration endsAt"),
      ...(record.retryAt === undefined
        ? {}
        : {
            retryAt: storedTimestamp(
              record.retryAt,
              "Computer demonstration retryAt",
            ),
          }),
      ...(record.attempts === undefined
        ? {}
        : { attempts: record.attempts as number }),
    };
  }
  if (record.status !== "ready" && record.status !== "sent") {
    throw new Error("Computer demonstration status is corrupt");
  }
  exact(
    record,
    [
      "id",
      "userId",
      "botId",
      "status",
      "startedAt",
      "steps",
      "attachments",
      "expiresAt",
    ],
    [],
    "Computer demonstration",
  );
  if (!Number.isSafeInteger(record.steps) || (record.steps as number) < 1) {
    throw new Error("Computer demonstration steps is corrupt");
  }
  return {
    ...common,
    status: record.status,
    steps: record.steps as number,
    attachments: decodeMessageAttachmentsV1(
      record.attachments,
      "Computer demonstration attachments",
      true,
    ),
    expiresAt: storedTimestamp(
      record.expiresAt,
      "Computer demonstration expiresAt",
    ),
  };
}

function decodeStoredDemonstrations(value: unknown): StoredDemonstrationsV1 {
  const record = object(value, "Computer demonstrations");
  exact(record, ["version", "entries"], [], "Computer demonstrations");
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error("Computer demonstrations are corrupt");
  }
  return {
    version: 1,
    entries: record.entries.map(decodeStoredDemonstration),
  };
}

/** When the alarm owes a demonstration its next step. */
function demonstrationDeadline(
  entry: StoredDemonstrationV1,
  control: StoredComputerControlV1 | undefined,
): number {
  if (entry.status !== "recording") return Date.parse(entry.expiresAt);
  if (entry.retryAt !== undefined) return Date.parse(entry.retryAt);
  // A recording ends at its time cap, or when the person's lease lapses —
  // the Computer stops it then by itself, and the alarm collects it after.
  // A lease that is no longer theirs has already lapsed.
  const lapses =
    control && control.ownerId === entry.ownerId
      ? Date.parse(control.expiresAt)
      : Date.parse(entry.startedAt);
  return (
    Math.min(Date.parse(entry.endsAt), lapses) +
    COMPUTER_DEMONSTRATION_COLLECT_GRACE_MS
  );
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

/**
 * One stored record, or nothing when the codec refuses it.
 *
 * A projection degrades; it does not fail. Losing one record's contribution to
 * the card is better than a Bot whose Computer surface throws forever because
 * a single key holds a shape this version does not know.
 */
function decoded<T>(
  value: unknown,
  decode: (input: unknown) => T,
): T | undefined {
  if (value === undefined) return undefined;
  try {
    return decode(value);
  } catch {
    return undefined;
  }
}

function isFresh(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) > now.getTime();
}

/** The card's view of the Bot's frame: immutable, addressed by its hash. */
function computerFrameViewV1(
  botId: string,
  frame: StoredComputerFrameV1,
): ComputerScreenshotViewV1 {
  return {
    version: 1,
    capturedAt: frame.capturedAt,
    contentHash: frame.contentHash,
    url: `/api/bots/${encodeURIComponent(botId)}/computer/frame/${frame.contentHash}`,
  };
}

export class ComputerBotBackendContribution {
  #liveViewer?: LiveViewer;
  #scheduledConnect?: Promise<void>;
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
    // The frame is read from this object's own storage on every projection,
    // so there is nothing resident to drop for it.
    if (kind === "doctor") {
      this.#doctorCache.delete(this.projectionKey(userId, botId));
    }
  }

  private async admit(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<
    | { replay: ComputerCommandReceiptV1 }
    | { intent: StoredIntentV1; fingerprint: string }
    | { joined: string }
    | { busy: true }
  > {
    const fingerprint = computerCommandFingerprintV1(command);
    const scheduled = isComputerScheduledCommandV1(command.type);
    const startedRecord = (admittedAt: string): StoredProviderAnswerV2 =>
      command.type === "updateComputer" || command.type === "resetComputer"
        ? machineProjectionRecord(command.type, 1, admittedAt, admittedAt)
        : connectProjectionRecord(admittedAt);
    // A second Open during a slow start is the same connect. An Update or a
    // Reset is never folded into whatever is already starting: it would
    // silently not happen.
    const alongside = async (
      storage: ComputerBotTransaction,
      pending: StoredPendingConnectV1,
    ): Promise<{ joined: string } | { busy: true }> =>
      command.type === "connect"
        ? { joined: await this.joinPendingConnect(storage, pending) }
        : { busy: true };
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
        if (scheduled) {
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
              startedRecord(intent.admittedAt),
            );
          } else {
            pending = decodeStoredPendingConnect(pendingValue);
            if (pending.commandId !== command.commandId) {
              return alongside(storage, pending);
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
      const pendingValue = scheduled
        ? await storage.get<unknown>(COMPUTER_PENDING_CONNECT_KEY)
        : undefined;
      const pendingConnect =
        pendingValue === undefined
          ? undefined
          : decodeStoredPendingConnect(pendingValue);
      // No intent for a joined connect: an intent without a receipt is a
      // connect still owed, and this one is owed nothing of its own.
      if (pendingConnect && pendingConnect.commandId !== command.commandId) {
        return alongside(storage, pendingConnect);
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
      if (scheduled) {
        let pending: StoredPendingConnectV1;
        if (pendingConnect !== undefined) {
          pending = pendingConnect;
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
          startedRecord(admittedAt),
        );
      }
      return { intent, fingerprint };
    });
  }

  /**
   * A connect asked for while another is pending is that one. Pressing Open
   * again during a slow start must not be refused, and must not start a second
   * desktop either; an overdue one is only nudged, as its own replay would be.
   */
  private async joinPendingConnect(
    storage: ComputerBotTransaction,
    pending: StoredPendingConnectV1,
  ): Promise<string> {
    if (pendingConnectDeadline(pending) <= this.now().getTime()) {
      await storage.put(COMPUTER_PENDING_CONNECT_KEY, {
        ...pending,
        deferredUntil: new Date(
          this.now().getTime() + COMPUTER_CONNECT_START_DELAY_MS,
        ).toISOString(),
      } satisfies StoredPendingConnectV1);
    }
    return pending.admittedAt;
  }

  private async settle(
    command: ComputerCommandV1,
    fingerprint: string,
    status: "applied" | "rejected",
    failure?: string,
    provider?: StoredProviderAnswerV2,
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
      // With the receipt, never before it: a failure the card can already see
      // while its connect is still pending invites a retry that joins a
      // connect about to settle, and then nothing happens.
      if (provider) await storage.put(COMPUTER_PROVIDER_RECORD_KEY, provider);
      if (isComputerScheduledCommandV1(command.type)) {
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

  /**
   * Opens the Computer for one command. `run` names each host request it
   * makes `<effectId>:<step>`, from the id this derives: a command id is the
   * client's own text, unique only within its Bot, while the Computer and its
   * billing account are the User's.
   */
  private async withComputer<T>(
    userId: string,
    command: ComputerCommandV1,
    run: (computer: ComputerHostSessionV1, effectId: string) => Promise<T>,
  ): Promise<T> {
    const digest = await sha256HexTextV1(
      `${command.botId}\u0000${command.commandId}`,
    );
    const effectId = `computer-command-${digest.slice(0, 32)}`;
    const computer = await this.host.openComputer(
      userId,
      command.botId,
      effectId,
    );
    try {
      return await run(computer, effectId);
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
    // A host with no Computer rejects every command with the same reason,
    // before admission. `connect` in particular must not answer `accepted`:
    // admitting work that provably cannot be done leaves the User watching a
    // projection that will never move, and there is nothing to reconcile
    // later because nothing was ever started.
    if (!this.host.configured) {
      return {
        version: 1,
        commandId: command.commandId,
        type: command.type,
        status: "rejected",
        completedAt: this.now().toISOString(),
        failure: COMPUTER_UNCONFIGURED_MESSAGE_V1,
      };
    }
    const admitted = await this.admit(userId, command);
    if ("replay" in admitted) return admitted.replay;
    if ("busy" in admitted) {
      return {
        version: 1,
        commandId: command.commandId,
        type: command.type,
        status: "rejected",
        completedAt: this.now().toISOString(),
        failure:
          "The Computer is already starting. Try again once it is ready.",
      };
    }
    if ("joined" in admitted) {
      return {
        version: 2,
        commandId: command.commandId,
        type: "connect",
        status: "accepted",
        admittedAt: admitted.joined,
      };
    }
    if (isComputerScheduledCommandV1(command.type)) {
      return {
        version: 2,
        commandId: command.commandId,
        type: command.type,
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
          await this.restoreOwedLogins(userId, command);
          break;
        case "updateComputer":
        case "resetComputer":
          await this.renewMachine(userId, command, command.type);
          break;
        case "saveCheckpoint":
          await this.saveCheckpoint(userId, command);
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
        case "startDemonstration":
          await this.startDemonstration(userId, command);
          break;
        case "stopDemonstration":
          await this.stopDemonstration(userId, command);
          break;
        case "discardDemonstration":
          await this.discardDemonstration(userId, command);
          break;
      }
      return this.settle(command, admitted.fingerprint, "applied");
    } catch (error) {
      const failure = failureText(error);
      // A recording that could not start, or stopped with nothing in it, is
      // an answer to that one gesture. It says nothing about the Computer, so
      // it moves no phase: the receipt carries it to the person.
      if (
        command.type === "startDemonstration" ||
        command.type === "stopDemonstration" ||
        command.type === "discardDemonstration"
      ) {
        return this.settle(command, admitted.fingerprint, "rejected", failure);
      }
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
      return this.settle(command, admitted.fingerprint, "rejected", failure, {
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
      });
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
    const control = decoded(
      await storage.get<unknown>(COMPUTER_CONTROL_RECORD_KEY),
      decodeStoredComputerControlV1,
    );
    const demonstrations = decoded(
      await storage.get<unknown>(COMPUTER_DEMONSTRATIONS_KEY),
      decodeStoredDemonstrations,
    );
    return [
      ...(value === undefined
        ? []
        : [pendingConnectDeadline(decodeStoredPendingConnect(value))]),
      ...(demonstrations?.entries ?? []).map((entry) =>
        demonstrationDeadline(entry, control),
      ),
    ];
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
    try {
      await this.settleScheduledConnect();
    } finally {
      await this.settleDemonstrations();
    }
  }

  private async settleScheduledConnect(): Promise<void> {
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
    if (!isComputerScheduledCommandV1(intent.command.type)) {
      throw new Error("Computer pending connect does not match its Bot");
    }
    await this.executeAdmitted(pending.userId, intent.command, {
      intent,
      fingerprint: intent.fingerprint,
    });
  }

  // Viewer attachment validates the running desktop without preparing it again.
  // It stays on the command path because opening or renewing a viewer is billed.
  private async attach(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<boolean> {
    const storedValue = await this.host.storage.get<unknown>(
      COMPUTER_VIEWER_RECORD_KEY,
    );
    const stored = decoded(storedValue, decodeStoredViewer);
    const fresh =
      stored && isFresh(stored.expiresAt, this.now()) ? stored : undefined;
    let session: ComputerViewerSession | undefined;
    try {
      session = await this.withComputer(
        userId,
        command,
        async (computer, effectId) => {
          if (!computer.viewer) return undefined;
          const options = { effectId: `${effectId}:attach-viewer` };
          return fresh
            ? computer.viewer.renew(fresh.id, options)
            : computer.viewer.open(options);
        },
      );
    } catch (error) {
      // A missing desktop and one that is mid-update are the same answer from
      // here: no running viewer was confirmed. The connect below waits that
      // update out and joins; read as a failure, this refusal would end the
      // User's one gesture on an update that never finishes.
      if (
        error instanceof ComputerError &&
        (error.code === "not-found" || error.code === "updating")
      ) {
        return false;
      }
      throw error;
    }
    if (!session) return false;
    if (!session.expiresAt || !isFresh(session.expiresAt, this.now())) {
      throw new Error(
        "The Computer returned a viewer session with no valid expiry",
      );
    }
    await this.recordViewer({
      id: session.id,
      url: session.url,
      expiresAt: session.expiresAt,
    });
    return true;
  }

  /**
   * Records one live viewer: the session id and its expiry durably, the bearer
   * URL in this instance alone.
   */
  private async recordViewer(viewer: LiveViewer): Promise<void> {
    await this.host.storage.put({
      [COMPUTER_VIEWER_RECORD_KEY]: {
        version: 1,
        id: viewer.id,
        expiresAt: viewer.expiresAt,
      } satisfies StoredViewerV1,
      [COMPUTER_PROVIDER_RECORD_KEY]: {
        version: 2,
        phase: "ready",
        message: "Computer ready",
        recordedAt: this.now().toISOString(),
      } satisfies StoredProviderAnswerV2,
    });
    this.#liveViewer = { ...viewer };
  }

  private async connect(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    if (await this.attach(userId, command)) return;
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
      async (computer, effectId) => {
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
          effectId: `${effectId}:connect`,
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
      async (computer, effectId) => {
        if (!computer.control) {
          throw new Error(
            "The selected Computer does not support human control",
          );
        }
        return computer.control.acquire(
          { scope: "desktop-gui", ownerId: intent.ownerId },
          { effectId: `${effectId}:take-control` },
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
      async (computer, effectId) => {
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
          { effectId: `${effectId}:refresh-control` },
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
      async (computer, effectId) => {
        if (!computer.viewer) {
          throw new Error("The selected Computer does not support a viewer");
        }
        return computer.viewer.renew(current.id, {
          effectId: `${effectId}:refresh-viewer`,
        });
      },
    );
    if (renewed.id !== current.id || !renewed.expiresAt) {
      throw new Error("The Computer returned an invalid viewer renewal");
    }
    await this.recordViewer({
      id: renewed.id,
      url: renewed.url,
      expiresAt: renewed.expiresAt,
    });
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
    try {
      await this.withComputer(userId, command, async (computer, effectId) => {
        if (!computer.control) {
          throw new Error(
            "The selected Computer does not support human control",
          );
        }
        await computer.control.release(
          { id: current.ownerId, expiresAt: current.expiresAt },
          { scope: "desktop-gui", ownerId: current.ownerId },
          { effectId: `${effectId}:release-control` },
        );
      });
    } finally {
      // The durable record goes whatever the provider answered. It is the
      // User-wide `desktop-gui` fence: left behind by a release the Computer
      // could not confirm, it is renewed by the client heartbeat forever, and
      // every Bot of this User loses the Computer with no way back. The
      // provider's own lease expires on its side; this one has no expiry a
      // failing host can be trusted to reach. The failure still reaches the
      // User — it rejects the receipt and records the `error` phase — but it
      // never becomes a lease nobody can drop.
      // Prior art: `releaseDesktopLease` in `@frockbot/app/subagents`.
      await this.host.storage.delete(COMPUTER_CONTROL_RECORD_KEY);
    }
    // Letting go of control ends a recording, so it is collected now rather
    // than on the alarm; the alarm is what tries again if this cannot.
    const recording = (await this.demonstrations()).find(
      (entry) =>
        entry.status === "recording" && entry.ownerId === current.ownerId,
    );
    if (recording?.status === "recording") {
      try {
        await this.collect(recording, (run) =>
          this.withComputer(userId, command, (computer, effectId) =>
            run(computer, `${effectId}:collect-demonstration`),
          ),
        );
      } catch {
        // The release happened; a recording the Computer would not hand back
        // yet is the alarm's to collect.
      }
    }
    // A person who took the desktop over is the likeliest to have just signed
    // in to something, so this is when the sign-ins are worth keeping.
    await this.keepLogins(userId, command);
  }

  // --- demonstrations (parity row 54) --------------------------------------

  private async demonstrations(): Promise<StoredDemonstrationV1[]> {
    return (
      decoded(
        await this.host.storage.get<unknown>(COMPUTER_DEMONSTRATIONS_KEY),
        decodeStoredDemonstrations,
      )?.entries ?? []
    );
  }

  /**
   * Rewrites the one record from what it holds now, in one transaction, and
   * answers whether anything changed. A record no codec reads is taken as
   * empty and replaced, rather than making every recording refuse for ever.
   */
  private async updateDemonstrations(
    change: (entries: StoredDemonstrationV1[]) => StoredDemonstrationV1[],
  ): Promise<boolean> {
    return this.host.storage.transaction(async (storage) => {
      const stored = await storage.get<unknown>(COMPUTER_DEMONSTRATIONS_KEY);
      const current =
        decoded(stored, decodeStoredDemonstrations)?.entries ?? [];
      const next = change(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return false;
      if (next.length === 0) {
        await storage.delete(COMPUTER_DEMONSTRATIONS_KEY);
      } else {
        await storage.put(COMPUTER_DEMONSTRATIONS_KEY, {
          version: 1,
          entries: next,
        } satisfies StoredDemonstrationsV1);
      }
      return true;
    });
  }

  private async demonstrationId(command: ComputerCommandV1): Promise<string> {
    const digest = await sha256HexTextV1(
      `${command.botId}\u0000demonstration\u0000${command.commandId}`,
    );
    return digest.slice(0, 16);
  }

  /** Deletes a kept demonstration's files, then its record. */
  private async forget(entry: StoredDemonstrationV1): Promise<void> {
    if (entry.status !== "recording" && this.host.demonstrations) {
      await this.host.demonstrations.remove({
        userId: entry.userId,
        botId: entry.botId,
        uploadIds: entry.attachments.map((attachment) => attachment.uploadId),
      });
    }
    await this.updateDemonstrations((entries) =>
      entries.filter((candidate) => candidate.id !== entry.id),
    );
  }

  /**
   * Stops a recording on the Computer and keeps what it captured as the
   * files a message carries. `open` supplies the Computer and the effect id
   * the stop is named by, because a command, a release and the alarm each
   * collect under their own.
   */
  private async collect(
    entry: Extract<StoredDemonstrationV1, { status: "recording" }>,
    open: (
      run: (
        computer: ComputerHostSessionV1,
        effectId: string,
      ) => Promise<ComputerDemonstrationCaptureV1 | undefined>,
    ) => Promise<ComputerDemonstrationCaptureV1 | undefined>,
  ): Promise<"kept" | "empty"> {
    const store = this.host.demonstrations;
    const capture = await open(async (computer, effectId) =>
      computer.demonstration?.stop({ effectId }),
    );
    if (!capture || capture.steps.length === 0 || !store) {
      await this.updateDemonstrations((entries) =>
        entries.filter((candidate) => candidate.id !== entry.id),
      );
      return "empty";
    }
    const attachments = (
      await store.keep({
        userId: entry.userId,
        botId: entry.botId,
        files: computerDemonstrationFilesV1(entry.id, capture),
      })
    ).map(durableMessageAttachmentV1);
    const kept = await this.updateDemonstrations((entries) =>
      entries.map((candidate) =>
        candidate.id === entry.id
          ? {
              id: entry.id,
              userId: entry.userId,
              botId: entry.botId,
              status: "ready",
              startedAt: entry.startedAt,
              steps: capture.steps.length,
              attachments,
              expiresAt: new Date(
                this.now().getTime() + COMPUTER_DEMONSTRATION_RETENTION_MS,
              ).toISOString(),
            }
          : candidate,
      ),
    );
    // Discarded while it was being read back: the files it became go too.
    if (!kept) {
      await store.remove({
        userId: entry.userId,
        botId: entry.botId,
        uploadIds: attachments.map((attachment) => attachment.uploadId),
      });
    }
    return "kept";
  }

  /**
   * Starts recording what the person holding control does in the browser.
   *
   * Anything recorded earlier and never sent is replaced: pressing Record
   * again is starting over. The record is written before the Computer is
   * asked, and dropped again if it refuses.
   */
  private async startDemonstration(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const store = this.host.demonstrations;
    if (!store) {
      throw new Error("Recordings can't be kept on this deployment");
    }
    const control = decoded(
      await this.host.storage.get<unknown>(COMPUTER_CONTROL_RECORD_KEY),
      decodeStoredComputerControlV1,
    );
    if (!control || !isStoredComputerControlFreshV1(control, this.now())) {
      throw new Error(
        "Take control of the Computer to record: only what you do while you hold it is recorded.",
      );
    }
    const id = await this.demonstrationId(command);
    const entries = await this.demonstrations();
    if (entries.some((entry) => entry.id === id)) return;
    const unsent = entries.filter((entry) => entry.status !== "sent");
    const sent = entries.filter((entry) => entry.status === "sent");
    const evicted = sent.slice(
      0,
      Math.max(0, sent.length - (COMPUTER_DEMONSTRATION_LIMIT - 1)),
    );
    for (const entry of [...unsent, ...evicted]) {
      if (entry.status !== "recording") {
        await store.remove({
          userId: entry.userId,
          botId: entry.botId,
          uploadIds: entry.attachments.map((attachment) => attachment.uploadId),
        });
      }
    }
    const replaced = new Set([...unsent, ...evicted].map((entry) => entry.id));
    const startedAt = this.now();
    await this.updateDemonstrations((current) => [
      ...current.filter((entry) => !replaced.has(entry.id)),
      {
        id,
        userId,
        botId: command.botId,
        status: "recording",
        ownerId: control.ownerId,
        startedAt: startedAt.toISOString(),
        endsAt: new Date(
          startedAt.getTime() + COMPUTER_DEMONSTRATION_SECONDS * 1_000,
        ).toISOString(),
      },
    ]);
    try {
      await this.withComputer(userId, command, async (computer, effectId) => {
        if (!computer.demonstration) {
          throw new Error("This Computer can't record");
        }
        await computer.demonstration.start(
          { ownerId: control.ownerId, seconds: COMPUTER_DEMONSTRATION_SECONDS },
          { effectId: `${effectId}:start-demonstration` },
        );
      });
    } catch (error) {
      await this.updateDemonstrations((current) =>
        current.filter((entry) => entry.id !== id),
      );
      throw error;
    }
  }

  private async stopDemonstration(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const recording = (await this.demonstrations()).findLast(
      (entry) => entry.status === "recording",
    );
    // Nothing recording: already collected — by a release, the alarm, or
    // this same command before a replay — and that is what Stop asked for.
    if (!recording || recording.status !== "recording") return;
    const outcome = await this.collect(recording, (run) =>
      this.withComputer(userId, command, (computer, effectId) =>
        run(computer, `${effectId}:stop-demonstration`),
      ),
    );
    if (outcome === "empty") {
      throw new Error(COMPUTER_DEMONSTRATION_EMPTY_MESSAGE);
    }
  }

  private async discardDemonstration(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const entry = (await this.demonstrations()).findLast(
      (candidate) => candidate.status !== "sent",
    );
    if (!entry) return;
    if (entry.status === "recording") {
      try {
        await this.withComputer(userId, command, (computer, effectId) =>
          computer.demonstration
            ? computer.demonstration.stop({
                effectId: `${effectId}:discard-demonstration`,
              })
            : Promise.resolve(undefined),
        );
      } catch {
        // What it recorded stays on the Computer only until the next
        // recording starts, which clears it before anything else.
      }
    }
    await this.forget(entry);
  }

  /**
   * A message was admitted carrying these files. A kept recording among them
   * has been sent: the person decided, so it is no longer offered to them.
   */
  async noteDemonstrationSent(uploadIds: readonly string[]): Promise<void> {
    if (uploadIds.length === 0) return;
    const sent = new Set(uploadIds);
    await this.updateDemonstrations((entries) =>
      entries.map((entry) =>
        entry.status === "ready" &&
        entry.attachments.some((attachment) => sent.has(attachment.uploadId))
          ? { ...entry, status: "sent" }
          : entry,
      ),
    );
  }

  /**
   * Deletes a demonstration the person sent this Bot, once its Skill is
   * saved or turned down. Only a sent one: the Bot never saw anything else.
   */
  async deleteDemonstration(
    demonstrationId: string,
  ): Promise<"deleted" | "missing"> {
    const entry = (await this.demonstrations()).find(
      (candidate) => candidate.id === demonstrationId,
    );
    if (!entry || entry.status !== "sent") return "missing";
    await this.forget(entry);
    return "deleted";
  }

  /** Collects what the alarm owes collecting, and deletes what expired. */
  private async settleDemonstrations(): Promise<void> {
    const now = this.now().getTime();
    const control = decoded(
      await this.host.storage.get<unknown>(COMPUTER_CONTROL_RECORD_KEY),
      decodeStoredComputerControlV1,
    );
    for (const entry of await this.demonstrations()) {
      if (demonstrationDeadline(entry, control) > now) continue;
      try {
        if (
          entry.status === "recording" &&
          (await this.host
            .loginVault?.(entry.userId)
            ?.deletedSince(entry.startedAt))
        ) {
          // The User deleted the Computer, and the recording with it. Opening
          // it to ask would start a new one.
          await this.forget(entry);
        } else if (entry.status === "recording") {
          await this.collect(entry, (run) =>
            this.withDemonstrationComputer(entry, run),
          );
        } else {
          await this.forget(entry);
        }
      } catch {
        // Tried again later, never at once: a deadline left in the past
        // would wake this object for ever. A recording the Computer never
        // hands back is let go after a few tries.
        const retry = new Date(now + COMPUTER_DEMONSTRATION_RETRY_MS);
        await this.updateDemonstrations((entries) =>
          entries.flatMap((candidate): StoredDemonstrationV1[] => {
            if (candidate.id !== entry.id) return [candidate];
            if (candidate.status !== "recording") {
              return [{ ...candidate, expiresAt: retry.toISOString() }];
            }
            const attempts = (candidate.attempts ?? 0) + 1;
            return attempts >= COMPUTER_DEMONSTRATION_ATTEMPTS
              ? []
              : [{ ...candidate, attempts, retryAt: retry.toISOString() }];
          }),
        );
      }
    }
  }

  /** The Computer, for work the alarm does with no command to name it. */
  private async withDemonstrationComputer<T>(
    entry: Extract<StoredDemonstrationV1, { status: "recording" }>,
    run: (computer: ComputerHostSessionV1, effectId: string) => Promise<T>,
  ): Promise<T> {
    const digest = await sha256HexTextV1(
      `${entry.botId}\u0000demonstration\u0000${entry.id}\u0000${entry.attempts ?? 0}`,
    );
    const effectId = `computer-demonstration-${digest.slice(0, 32)}`;
    const computer = await this.host.openComputer(
      entry.userId,
      entry.botId,
      effectId,
    );
    try {
      return await run(computer, `${effectId}:collect`);
    } finally {
      await computer.close();
    }
  }

  /**
   * Collects this Bot's stopped recording, if any, before an Update or a
   * Reset discards the files it lives in. Never fails the command: a
   * recording the Computer would not hand back is the alarm's to try again,
   * and gone with the machine it was on.
   */
  private async collectBeforeMachineChanges(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const recording = (await this.demonstrations()).find(
      (entry) => entry.status === "recording",
    );
    if (recording?.status !== "recording") return;
    try {
      await this.collect(recording, (run) =>
        this.withComputer(userId, command, (computer, effectId) =>
          run(computer, `${effectId}:collect-demonstration`),
        ),
      );
    } catch {
      // Left for the alarm.
    }
  }

  /** Captures and keeps the sign-ins. Never fails the command it follows. */
  private async keepLogins(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const vault = this.host.loginVault?.(userId);
    if (!vault) return;
    try {
      await this.withComputer(userId, command, (computer, effectId) =>
        keepComputerLoginsV1({
          computer,
          vault,
          effectId: `${effectId}:keep-sign-ins`,
          now: () => this.now(),
        }),
      );
    } catch {
      // What was kept before stays kept.
    }
  }

  /**
   * Puts the kept sign-ins into a machine that is owed them. The machine an
   * Update or a Reset left behind is owed them until this runs, whichever of
   * the User's Bots opens it first. Never fails the command it follows.
   */
  private async restoreOwedLogins(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const vault = this.host.loginVault?.(userId);
    if (!vault) return;
    try {
      await this.withComputer(userId, command, (computer, effectId) =>
        restoreOwedComputerLoginsV1({
          computer,
          vault,
          effectId: `${effectId}:restore-sign-ins`,
        }),
      );
    } catch {
      // An unpaid debt is paid by the next open.
    }
  }

  private async saveCheckpoint(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const { checkpoint } = await this.withComputer(
      userId,
      command,
      (computer, effectId) => {
        if (!computer.machine) {
          throw new Error("This Computer cannot record checkpoints");
        }
        return computer.machine.checkpoint({
          effectId: `${effectId}:checkpoint`,
        });
      },
    );
    await noteComputerCheckpointV1(this.host.storage, checkpoint);
  }

  /**
   * Update and Reset: keep the sign-ins, change the whole machine, bring the
   * new one up with a viewer, and put the sign-ins back.
   *
   * It runs in the scheduled path, like a connect, because the new machine
   * takes minutes to come up. Every step names its host request after the
   * command, and `machineAt` records the one step that cannot be repeated,
   * so a replay after eviction resumes rather than discarding the machine it
   * already started.
   *
   * "Delete my Computer" outranks it. One asked for before this command ran
   * refuses it before any machine changes, and one that lands while it runs
   * stops it before it opens a new machine: the vault is the fence, because
   * the User's object records the deletion there before the teardown. A
   * replacement the host could not make — there was no machine, or a
   * teardown overtook it — owes the sign-ins to the next open rather than
   * settling them, since the machine that held them is gone.
   */
  private async renewMachine(
    userId: string,
    command: ComputerCommandV1,
    type: MachineCommandTypeV1,
  ): Promise<void> {
    const intentValue = await this.host.storage.get<unknown>(
      `${COMPUTER_INTENT_PREFIX}${command.commandId}`,
    );
    const startedAt =
      intentValue === undefined
        ? this.now().toISOString()
        : decodeStoredIntent(intentValue).admittedAt;
    const report = (
      index: number,
      provisioning?: ComputerProvisioningProgressViewV1,
    ): Promise<void> =>
      this.host.storage.put(
        COMPUTER_PROVIDER_RECORD_KEY,
        machineProjectionRecord(
          type,
          index,
          startedAt,
          this.now().toISOString(),
          provisioning,
        ),
      );
    const vault = this.host.loginVault?.(userId);

    const pendingValue = await this.host.storage.get<unknown>(
      COMPUTER_PENDING_CONNECT_KEY,
    );
    const pending =
      pendingValue === undefined
        ? undefined
        : decodeStoredPendingConnect(pendingValue);
    if (!pending?.machineAt) {
      await report(1);
      if (vault) {
        // Checked before the capture as well as by the debt, so that a
        // Computer the User deleted is not even opened to be captured.
        if (await vault.deletedSince(startedAt)) {
          throw new ComputerError("not-found", COMPUTER_DELETED_BEFORE);
        }
        await this.keepLogins(userId, command);
        // Owed before the machine goes, so that no capture of the browser
        // that replaces it — which holds none of them — is kept instead.
        if ((await vault.owe(startedAt)) === "deleted") {
          throw new ComputerError("not-found", COMPUTER_DELETED_BEFORE);
        }
      }
      // What was recorded is on the machine and nowhere else, so it is
      // collected before the machine changes. A recorder is never running
      // here: the host refuses both while anyone holds control, and the
      // recorder stops when control goes.
      await this.collectBeforeMachineChanges(userId, command);
      await report(2);
      try {
        await this.withComputer(userId, command, async (computer, effectId) => {
          if (!computer.machine) {
            throw new Error("This Computer cannot be reset or replaced");
          }
          if (type === "resetComputer") {
            const checkpoint = await computer.machine.reset({
              effectId: `${effectId}:reset`,
            });
            await noteComputerCheckpointV1(this.host.storage, checkpoint);
          } else {
            await computer.machine.replace({ effectId: `${effectId}:replace` });
            // Its checkpoints went with it.
            await this.host.storage.put(COMPUTER_CHECKPOINT_RECORD_KEY, {
              version: 1,
            });
          }
        });
      } catch (error) {
        const gone =
          error instanceof ComputerError && error.code === "not-found";
        // Refused before anything changed: the machine still holds its
        // sign-ins, so it is owed nothing. A replacement that found no
        // machine is the exception — whatever held them is already gone.
        if (
          vault &&
          machineUntouched(error) &&
          !(gone && type === "updateComputer")
        ) {
          await vault.settle(startedAt).catch(() => undefined);
        }
        // Nothing to reset to is what Reset will find next time too.
        if (gone && type === "resetComputer") {
          await this.host.storage.put(COMPUTER_CHECKPOINT_RECORD_KEY, {
            version: 1,
          });
        }
        throw error;
      }
      // The viewer belonged to the machine that is gone.
      this.#liveViewer = undefined;
      await this.host.storage.delete(COMPUTER_VIEWER_RECORD_KEY);
      if (pending) {
        await this.host.storage.put(COMPUTER_PENDING_CONNECT_KEY, {
          ...pending,
          machineAt: this.now().toISOString(),
        } satisfies StoredPendingConnectV1);
      }
    }

    // The one step that would provision a machine: never for a Computer the
    // User deleted after asking for this.
    if (vault && (await vault.deletedSince(startedAt))) {
      throw new ComputerError("not-found", COMPUTER_DELETED_DURING);
    }
    await report(3);
    const session = await this.withComputer(
      userId,
      command,
      (computer, effectId) => {
        if (!computer.presence) {
          throw new Error("The selected Computer does not support presence");
        }
        return computer.presence.connect({
          effectId: `${effectId}:connect`,
          onProgress: (progress) =>
            report(
              3,
              progress.provisioning
                ? { ...progress.provisioning, version: 1 }
                : undefined,
            ),
        });
      },
    );
    if (!session.expiresAt) {
      throw new Error("The Computer returned a viewer session with no expiry");
    }

    await report(4);
    await this.restoreOwedLogins(userId, command);
    if (type === "updateComputer") {
      // A fresh machine keeps none of the old one's checkpoints; this one is
      // where its first Reset goes.
      try {
        const { checkpoint } = await this.withComputer(
          userId,
          command,
          (computer, effectId) =>
            computer.machine
              ? computer.machine.checkpoint({
                  effectId: `${effectId}:checkpoint`,
                })
              : Promise.reject(new Error("no machine")),
        );
        await noteComputerCheckpointV1(
          this.host.storage,
          checkpoint,
          this.now().toISOString(),
        );
      } catch {
        // The weekly checkpoint at a Turn's end records one later.
      }
    }
    await this.recordViewer({
      id: session.id,
      url: session.url,
      expiresAt: session.expiresAt,
    });
  }

  /**
   * Keeps the frame the User just stopped watching as the card's, without
   * making close depend on a best-effort capture. A resident, fresh viewer is
   * the proof that this command is attaching to an already-watched desktop
   * rather than waking a hibernated Computer.
   */
  private async closeViewer(
    userId: string,
    command: ComputerCommandV1,
  ): Promise<void> {
    const viewerValue = await this.host.storage.get<unknown>(
      COMPUTER_VIEWER_RECORD_KEY,
    );
    if (viewerValue === undefined) return;
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
      await this.withComputer(userId, command, (computer, effectId) =>
        captureComputerFrameV1({
          computer,
          frames: computerFrameSinkV1(this.host.storage),
          effectId: `${effectId}:close-viewer-frame`,
        }),
      );
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
      async (computer, effectId) => {
        if (!computer.doctor) {
          throw new Error("The selected Computer does not support self-checks");
        }
        return computer.doctor.run({
          effectId: `${effectId}:doctor`,
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

  /** Keeps `frame` as the card's: what a subagent's Turn left on screen. */
  async putFrame(frame: StoredComputerFrameV1): Promise<void> {
    await computerFrameSinkV1(this.host.storage).put(frame);
  }

  /**
   * The frame the card asked for, by the hash its projection named. A frame
   * that has since been replaced is gone: the card reads the projection again
   * and asks for the new one.
   */
  async readFrame(
    contentHash: string,
  ): Promise<{ bytes: Uint8Array; mediaType: "image/png" } | undefined> {
    const frame = decoded(
      await this.host.storage.get<unknown>(COMPUTER_FRAME_RECORD_KEY),
      decodeStoredComputerFrameV1,
    );
    if (!frame || frame.contentHash !== contentHash) return undefined;
    return { bytes: frame.bytes, mediaType: frame.mediaType };
  }

  async read(userId: string, botId: string): Promise<ComputerProjectionV1> {
    const now = this.now();
    const [
      viewerValue,
      controlValue,
      providerValue,
      frameValue,
      checkpointValue,
      doctor,
      demonstrations,
    ] = await Promise.all([
      this.host.storage.get<unknown>(COMPUTER_VIEWER_RECORD_KEY),
      this.host.storage.get<unknown>(COMPUTER_CONTROL_RECORD_KEY),
      this.host.storage.get<unknown>(COMPUTER_PROVIDER_RECORD_KEY),
      this.host.storage.get<unknown>(COMPUTER_FRAME_RECORD_KEY),
      this.host.storage.get<unknown>(COMPUTER_CHECKPOINT_RECORD_KEY),
      this.doctor(userId, botId),
      this.demonstrations(),
    ]);
    const checkpoint =
      decodeStoredComputerCheckpointV1(checkpointValue)?.checkpoint;
    // A record the codec refuses is treated as absent, the way `doctor()`
    // above and `ComputerProcessStore.list` already do. These three decoders
    // throw on any unexpected shape — a field a future version adds included —
    // and this is the read behind the card, the overlay and the poll: one bad
    // value made `GET /api/bots/:id/computer` throw for that Bot forever, with
    // nothing in the product able to clear the key.
    const viewer = decoded(viewerValue, decodeStoredViewer);
    const control = decoded(controlValue, decodeStoredComputerControlV1);
    const provider = decoded(providerValue, decodeStoredProvider);
    const frame = decoded(frameValue, decodeStoredComputerFrameV1);
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
      message = COMPUTER_UNCONFIGURED_MESSAGE_V1;
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
        ? "Reconnect to pick up where you left off"
        : "Ready to start";
    }
    const demonstration = demonstrationViewV1(demonstrations);
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
      screenshots: frame ? [computerFrameViewV1(botId, frame)] : [],
      ...(doctor ? { doctor } : {}),
      ...(demonstration ? { demonstration } : {}),
      ...(checkpoint
        ? { checkpoint: { version: 1, createdAt: checkpoint.createdAt } }
        : {}),
    };
  }
}

/**
 * What the person has to decide about: the newest recording that is still
 * running, or kept and not yet sent. A sent one is the Bot's business.
 */
function demonstrationViewV1(
  entries: readonly StoredDemonstrationV1[],
): ComputerDemonstrationViewV1 | undefined {
  const entry = entries.findLast((candidate) => candidate.status !== "sent");
  if (!entry) return undefined;
  if (entry.status === "recording") {
    return {
      version: 1,
      id: entry.id,
      status: "recording",
      startedAt: entry.startedAt,
      endsAt: entry.endsAt,
    };
  }
  return {
    version: 1,
    id: entry.id,
    status: "ready",
    startedAt: entry.startedAt,
    steps: entry.steps,
    attachments: entry.attachments.map(durableMessageAttachmentV1),
  };
}

export function createComputerBotBackendContribution(
  host: ComputerBotBackendHost,
): ComputerBotBackendContribution {
  return new ComputerBotBackendContribution(host);
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
  specifier: "@frockbot/computer/bot",
  mount: (host, lifecycle) =>
    lifecycle.mount(createComputerBotBackendContribution(host.computer)),
});
