import type { Plugin } from "cordis";
import {
  PackagePublisherConflictError,
  PackagePublisherDecodeError,
  decodePackagePublicationReceiptV1,
  decodePackageRevisionHistoryV1,
  decodePublishPackageCommandV1,
  type PackageCandidateV1,
  type PackagePublicationReceiptV1,
  type PackageRevisionHistoryV1,
  type PublishPackageCommandV1,
  type RollbackPackageCommandV1,
} from "./shared.js";

const STATE_KEY = "package-publisher:state:v1";
const RECEIPT_PREFIX = "package-publisher:receipt:";

interface PendingPublication {
  userId: string;
  commandId: string;
  fingerprint: string;
  packageRevision: number;
  applicationHash: string;
  publishedAt: string;
  candidate: PackageCandidateV1;
}

interface StoredState extends PackageRevisionHistoryV1 {
  pending?: PendingPublication;
}

interface StoredReceipt {
  fingerprint: string;
  receipt: PackagePublicationReceiptV1;
}

export interface PackagePublisherTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction?<T>(
    callback: (storage: PackagePublisherTransaction) => Promise<T>,
  ): Promise<T>;
}

interface PackagePublisherStorage extends PackagePublisherTransaction {
  transaction<T>(
    callback: (storage: PackagePublisherTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PackagePublisherUserHost {
  storage: PackagePublisherStorage;
  hash(candidate: PackageCandidateV1): Promise<string>;
  storeAndVerify(input: {
    userId: string;
    applicationHash: string;
    candidate: PackageCandidateV1;
  }): Promise<void>;
  scheduleRecovery?(): Promise<void>;
  now?: () => Date;
}

function initialState(): StoredState {
  return { schemaVersion: 1, revision: 0, revisions: [] };
}

function storedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackagePublisherDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function storedExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new PackagePublisherDecodeError(
      `${label} has unknown or missing fields`,
    );
  }
}

function decodeStoredState(value: unknown): StoredState {
  const state = storedRecord(value, "stored publication state");
  storedExactKeys(
    state,
    ["schemaVersion", "revision", "revisions"],
    ["activePackageRevision", "pending"],
    "stored publication state",
  );
  const history = decodePackageRevisionHistoryV1({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    revisions: state.revisions,
    ...(state.activePackageRevision === undefined
      ? {}
      : { activePackageRevision: state.activePackageRevision }),
  });
  if (
    history.activePackageRevision !== undefined &&
    !history.revisions.some(
      (revision) => revision.packageRevision === history.activePackageRevision,
    )
  ) {
    throw new PackagePublisherDecodeError(
      "active package revision was not published",
    );
  }
  if (state.pending === undefined) return history;
  const pending = storedRecord(state.pending, "pending publication");
  storedExactKeys(
    pending,
    [
      "userId",
      "commandId",
      "fingerprint",
      "packageRevision",
      "applicationHash",
      "publishedAt",
      "candidate",
    ],
    [],
    "pending publication",
  );
  if (
    typeof pending.userId !== "string" ||
    typeof pending.fingerprint !== "string" ||
    pending.fingerprint.length < 1 ||
    typeof pending.applicationHash !== "string" ||
    !pending.applicationHash.startsWith("sha256:") ||
    typeof pending.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(pending.publishedAt)) ||
    !Number.isSafeInteger(pending.packageRevision) ||
    (pending.packageRevision as number) < 1
  ) {
    throw new PackagePublisherDecodeError("pending publication is invalid");
  }
  const decoded = decodePublishPackageCommandV1({
    schemaVersion: 1,
    commandId: pending.commandId,
    expectedRevision: history.revision,
    candidate: pending.candidate,
  });
  if (decoded.candidate.checks.some((check) => check.status !== "passed")) {
    throw new PackagePublisherDecodeError(
      "pending publication contains failed checks",
    );
  }
  return {
    ...history,
    pending: {
      userId: pending.userId,
      commandId: decoded.commandId,
      fingerprint: pending.fingerprint,
      packageRevision: pending.packageRevision as number,
      applicationHash: pending.applicationHash,
      publishedAt: pending.publishedAt,
      candidate: decoded.candidate,
    },
  };
}

function decodeStoredReceipt(value: unknown): StoredReceipt {
  const stored = storedRecord(value, "stored publication receipt");
  storedExactKeys(
    stored,
    ["fingerprint", "receipt"],
    [],
    "stored publication receipt",
  );
  if (typeof stored.fingerprint !== "string" || stored.fingerprint.length < 1) {
    throw new PackagePublisherDecodeError(
      "stored publication receipt fingerprint is invalid",
    );
  }
  return {
    fingerprint: stored.fingerprint,
    receipt: decodePackagePublicationReceiptV1(stored.receipt),
  };
}

async function readState(
  storage: PackagePublisherTransaction,
): Promise<StoredState> {
  const value = await storage.get<unknown>(STATE_KEY);
  return value === undefined ? initialState() : decodeStoredState(value);
}

async function readReceipt(
  storage: PackagePublisherTransaction,
  commandId: string,
): Promise<StoredReceipt | undefined> {
  const value = await storage.get<unknown>(`${RECEIPT_PREFIX}${commandId}`);
  return value === undefined ? undefined : decodeStoredReceipt(value);
}

function cloneHistory(state: StoredState): PackageRevisionHistoryV1 {
  return structuredClone({
    schemaVersion: 1,
    revision: state.revision,
    ...(state.activePackageRevision === undefined
      ? {}
      : { activePackageRevision: state.activePackageRevision }),
    revisions: state.revisions,
  });
}

export class PackagePublisherUserContribution {
  constructor(private readonly host: PackagePublisherUserHost) {}

  async read(): Promise<PackageRevisionHistoryV1> {
    return cloneHistory(await readState(this.host.storage));
  }

  async activeApplicationHash(): Promise<string | undefined> {
    const history = await this.read();
    return history.revisions.find(
      (revision) => revision.packageRevision === history.activePackageRevision,
    )?.applicationHash;
  }

  async publish(
    userId: string,
    command: PublishPackageCommandV1,
  ): Promise<PackagePublicationReceiptV1> {
    if (command.candidate.checks.some((check) => check.status !== "passed")) {
      throw new PackagePublisherDecodeError(
        "all required checks must pass before publication",
      );
    }
    const fingerprint = JSON.stringify(command);
    const applicationHash = await this.host.hash(command.candidate);
    const pending = await this.host.storage.transaction(async (storage) => {
      const receipt = await readReceipt(storage, command.commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new PackagePublisherDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        }
        return receipt.receipt;
      }
      const state = await readState(storage);
      if (state.pending) {
        if (
          state.pending.commandId !== command.commandId ||
          state.pending.fingerprint !== fingerprint
        ) {
          throw new PackagePublisherConflictError(state.revision);
        }
        return state.pending;
      }
      if (state.revision !== command.expectedRevision) {
        throw new PackagePublisherConflictError(state.revision);
      }
      const publication: PendingPublication = {
        userId,
        commandId: command.commandId,
        fingerprint,
        packageRevision:
          Math.max(0, ...state.revisions.map((item) => item.packageRevision)) +
          1,
        applicationHash,
        publishedAt: (this.host.now?.() ?? new Date()).toISOString(),
        candidate: structuredClone(command.candidate),
      };
      await storage.put(STATE_KEY, { ...state, pending: publication });
      return publication;
    });
    if ("status" in pending) return structuredClone(pending);
    return this.executePending(pending);
  }

  async recover(): Promise<PackagePublicationReceiptV1 | undefined> {
    const state = await readState(this.host.storage);
    if (!state.pending) return undefined;
    return this.executePending(state.pending);
  }

  private async executePending(
    pending: PendingPublication,
  ): Promise<PackagePublicationReceiptV1> {
    try {
      await this.host.scheduleRecovery?.();
      await this.host.storeAndVerify({
        userId: pending.userId,
        applicationHash: pending.applicationHash,
        candidate: pending.candidate,
      });
      return await this.finishPublication(pending);
    } catch (error) {
      return await this.failPublication(
        pending,
        error instanceof Error
          ? error.message
          : "candidate verification failed",
      );
    }
  }

  private finishPublication(
    pending: PendingPublication,
  ): Promise<PackagePublicationReceiptV1> {
    return this.host.storage.transaction(async (storage) => {
      const state = await readState(storage);
      if (state.pending?.commandId !== pending.commandId) {
        const stored = await readReceipt(storage, pending.commandId);
        if (stored?.fingerprint === pending.fingerprint) {
          return structuredClone(stored.receipt);
        }
        throw new PackagePublisherConflictError(state.revision);
      }
      const nextRevision = state.revision + 1;
      const receipt: PackagePublicationReceiptV1 = {
        schemaVersion: 1,
        commandId: pending.commandId,
        status: "active",
        revision: nextRevision,
        packageRevision: pending.packageRevision,
        applicationHash: pending.applicationHash,
      };
      const nextState: StoredState = {
        schemaVersion: 1,
        revision: nextRevision,
        activePackageRevision: pending.packageRevision,
        revisions: [
          ...state.revisions,
          {
            packageRevision: pending.packageRevision,
            applicationHash: pending.applicationHash,
            publishedAt: pending.publishedAt,
            checks: structuredClone(pending.candidate.checks),
          },
        ],
      };
      await storage.put(STATE_KEY, nextState);
      await storage.put(`${RECEIPT_PREFIX}${pending.commandId}`, {
        fingerprint: pending.fingerprint,
        receipt,
      } satisfies StoredReceipt);
      return structuredClone(receipt);
    });
  }

  private failPublication(
    pending: PendingPublication,
    failure: string,
  ): Promise<PackagePublicationReceiptV1> {
    return this.host.storage.transaction(async (storage) => {
      const state = await readState(storage);
      const stored = await readReceipt(storage, pending.commandId);
      if (stored?.fingerprint === pending.fingerprint) {
        return structuredClone(stored.receipt);
      }
      if (state.pending?.commandId !== pending.commandId) {
        throw new PackagePublisherConflictError(state.revision);
      }
      const nextRevision = state.revision + 1;
      const receipt: PackagePublicationReceiptV1 = {
        schemaVersion: 1,
        commandId: pending.commandId,
        status: "failed",
        revision: nextRevision,
        failure,
      };
      await storage.put(STATE_KEY, {
        ...state,
        revision: nextRevision,
        pending: undefined,
      });
      await storage.put(`${RECEIPT_PREFIX}${pending.commandId}`, {
        fingerprint: pending.fingerprint,
        receipt,
      } satisfies StoredReceipt);
      return structuredClone(receipt);
    });
  }

  rollback(
    command: RollbackPackageCommandV1,
  ): Promise<PackagePublicationReceiptV1> {
    const fingerprint = JSON.stringify(command);
    return this.host.storage.transaction(async (storage) => {
      const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
      const stored = await readReceipt(storage, command.commandId);
      if (stored) {
        if (stored.fingerprint !== fingerprint) {
          throw new PackagePublisherDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        }
        return structuredClone(stored.receipt);
      }
      const state = await readState(storage);
      if (state.pending)
        throw new PackagePublisherConflictError(state.revision);
      if (state.revision !== command.expectedRevision) {
        throw new PackagePublisherConflictError(state.revision);
      }
      const target = state.revisions.find(
        (revision) => revision.packageRevision === command.packageRevision,
      );
      if (!target) {
        throw new PackagePublisherDecodeError(
          `package revision ${command.packageRevision} was not found`,
        );
      }
      const nextRevision = state.revision + 1;
      const receipt: PackagePublicationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "active",
        revision: nextRevision,
        packageRevision: target.packageRevision,
        applicationHash: target.applicationHash,
      };
      await storage.put(STATE_KEY, {
        ...state,
        revision: nextRevision,
        activePackageRevision: target.packageRevision,
      });
      await storage.put(receiptKey, {
        fingerprint,
        receipt,
      } satisfies StoredReceipt);
      return structuredClone(receipt);
    });
  }
}

export function createPackagePublisherUserContribution(
  host: PackagePublisherUserHost,
): PackagePublisherUserContribution {
  return new PackagePublisherUserContribution(host);
}

export function createPackagePublisherUserPlugin(
  host: PackagePublisherUserHost,
  lifecycle: { mount(value: PackagePublisherUserContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createPackagePublisherUserContribution(host));
}
