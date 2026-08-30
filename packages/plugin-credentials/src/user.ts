import {
  decodeCredentialEnvelopeV1,
  decodeCredentialLeaseV1,
  type CredentialEnvelopeV1,
  type CredentialLeaseV1,
  openCredentialV1,
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";

const CREDENTIAL_PREFIX = "credential:";
const ACTIVE_PREFIX = "credential-active:";
const LEASE_PREFIX = "credential-lease:";
const LEASE_TOMBSTONE_PREFIX = "credential-lease-expired:";
const LEASE_QUEUE_STATE_KEY = "credential-lease-queue";
const LEASE_QUEUE_PAGE_PREFIX = "credential-lease-queue-page:";
const LEASE_QUEUE_POINTER_PREFIX = "credential-lease-queue-pointer:";
const LEASE_GENERATION_INDEX_PREFIX = "credential-lease-generation-index:";
const LEASE_TOMBSTONE_INDEX_PREFIX = "credential-lease-expired-index:";
const MAX_GENERATION_LEASE_RECORDS = 64;
const MAX_LEASE_RECOVERIES_PER_ALARM = 64;

export interface CredentialTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

export interface CredentialStorage extends CredentialTransaction {
  transaction<T>(
    callback: (storage: CredentialTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CredentialUserBackendHost {
  storage: CredentialStorage & {
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number | Date): Promise<void>;
  };
  keyring: string;
  now?: () => number;
}

export interface PreparedApiKeyCredential {
  accountId: string;
  connectionId: string;
  packageId: string;
  generation: string;
  envelope: CredentialEnvelopeV1;
}

interface StoredCredentialGeneration {
  schemaVersion: 1;
  accountId: string;
  connectionId: string;
  packageId: string;
  generation: string;
  state: "pending" | "active" | "retired";
  envelope: CredentialEnvelopeV1;
  leaseIds: string[];
}

interface StoredCredentialLease extends CredentialLeaseV1 {
  accountId: string;
  packageId: string;
  settled: boolean;
}

interface StoredLeaseQueue {
  schemaVersion: 1;
  headPage: number;
  tailPage: number;
  scanPage: number | null;
  scanMinimum: number | null;
  nextAlarm: number | null;
}

function credentialKey(connectionId: string, generation: string): string {
  return `${CREDENTIAL_PREFIX}${connectionId}:${generation}`;
}

function activeKey(connectionId: string): string {
  return `${ACTIVE_PREFIX}${connectionId}`;
}

function leaseKey(effectId: string): string {
  return `${LEASE_PREFIX}${effectId}`;
}

function leaseTombstoneKey(effectId: string): string {
  return `${LEASE_TOMBSTONE_PREFIX}${effectId}`;
}

function leaseQueuePageKey(page: number): string {
  return `${LEASE_QUEUE_PAGE_PREFIX}${page}`;
}

function leaseQueuePointerKey(effectId: string): string {
  return `${LEASE_QUEUE_POINTER_PREFIX}${effectId}`;
}

function leaseGenerationIndexKey(
  connectionId: string,
  generation: string,
): string {
  return `${LEASE_GENERATION_INDEX_PREFIX}${connectionId}:${generation}`;
}

function leaseTombstoneIndexKey(
  connectionId: string,
  generation: string,
): string {
  return `${LEASE_TOMBSTONE_INDEX_PREFIX}${connectionId}:${generation}`;
}

function storedRecord(
  input: unknown,
  label: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} is invalid`);
  }
  const value = input as Record<string, unknown>;
  if (
    !fields.every((field) => Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function storedText(value: unknown, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function decodeStoredStringList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} is invalid`);
  return [...new Set(input.map((value) => storedText(value, label)))];
}

function storedQueueNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function decodeStoredLeaseQueue(input: unknown): StoredLeaseQueue {
  const value = storedRecord(input, "Stored credential lease queue", [
    "schemaVersion",
    "headPage",
    "tailPage",
    "scanPage",
    "scanMinimum",
    "nextAlarm",
  ]);
  if (value.schemaVersion !== 1) {
    throw new Error("Stored credential lease queue is invalid");
  }
  const optionalNumber = (candidate: unknown, label: string) =>
    candidate === null ? null : storedQueueNumber(candidate, label);
  const headPage = storedQueueNumber(value.headPage, "headPage");
  const tailPage = storedQueueNumber(value.tailPage, "tailPage");
  const scanPage = optionalNumber(value.scanPage, "scanPage");
  if (
    headPage > tailPage ||
    (scanPage !== null && (scanPage < headPage || scanPage > tailPage))
  ) {
    throw new Error("Stored credential lease queue is invalid");
  }
  return {
    schemaVersion: 1,
    headPage,
    tailPage,
    scanPage,
    scanMinimum: optionalNumber(value.scanMinimum, "scanMinimum"),
    nextAlarm: optionalNumber(value.nextAlarm, "nextAlarm"),
  };
}

function decodeLeaseQueuePage(input: unknown): string[] {
  const page = decodeStoredStringList(input, "credential lease queue page");
  if (page.length > MAX_LEASE_RECOVERIES_PER_ALARM) {
    throw new Error("credential lease queue page is invalid");
  }
  return page;
}

function decodeStoredCredentialGeneration(
  input: unknown,
): StoredCredentialGeneration {
  const value = storedRecord(input, "Stored credential generation", [
    "schemaVersion",
    "accountId",
    "connectionId",
    "packageId",
    "generation",
    "state",
    "envelope",
    "leaseIds",
  ]);
  if (
    value.schemaVersion !== 1 ||
    (value.state !== "pending" &&
      value.state !== "active" &&
      value.state !== "retired")
  ) {
    throw new Error("Stored credential generation is invalid");
  }
  const generation = storedText(value.generation, "generation", 128);
  const envelope = decodeCredentialEnvelopeV1(value.envelope);
  if (envelope.credentialGeneration !== generation) {
    throw new Error("Stored credential generation is invalid");
  }
  return {
    schemaVersion: 1,
    accountId: storedText(value.accountId, "accountId"),
    connectionId: storedText(value.connectionId, "connectionId", 128),
    packageId: storedText(value.packageId, "packageId", 128),
    generation,
    state: value.state,
    envelope,
    leaseIds: decodeStoredStringList(value.leaseIds, "leaseIds"),
  };
}

function decodeStoredCredentialLease(input: unknown): StoredCredentialLease {
  const value = storedRecord(input, "Stored credential lease", [
    "schemaVersion",
    "leaseId",
    "effectId",
    "accountId",
    "connectionId",
    "packageId",
    "credentialGeneration",
    "expiresAt",
    "envelope",
    "settled",
  ]);
  if (typeof value.settled !== "boolean") {
    throw new Error("Stored credential lease is invalid");
  }
  const lease = decodeCredentialLeaseV1({
    schemaVersion: value.schemaVersion,
    leaseId: value.leaseId,
    effectId: value.effectId,
    connectionId: value.connectionId,
    credentialGeneration: value.credentialGeneration,
    expiresAt: value.expiresAt,
    envelope: value.envelope,
  });
  return {
    ...lease,
    accountId: storedText(value.accountId, "accountId"),
    packageId: storedText(value.packageId, "packageId", 128),
    settled: value.settled,
  };
}

function decodeLeaseTombstone(input: unknown): {
  accountId: string;
  connectionId: string;
  packageId: string;
  credentialGeneration: string;
} {
  const value = storedRecord(input, "Stored credential lease tombstone", [
    "accountId",
    "connectionId",
    "packageId",
    "credentialGeneration",
  ]);
  return {
    accountId: storedText(value.accountId, "accountId"),
    connectionId: storedText(value.connectionId, "connectionId", 128),
    packageId: storedText(value.packageId, "packageId", 128),
    credentialGeneration: storedText(
      value.credentialGeneration,
      "credentialGeneration",
      128,
    ),
  };
}

function decodeStoredGenerationId(input: unknown): string {
  return storedText(input, "Stored credential generation id", 128);
}

function requireGeneration(
  value: unknown,
  connectionId: string,
  generation: string,
): StoredCredentialGeneration {
  if (value === undefined) {
    throw new Error("Credential generation is unavailable");
  }
  const decoded = decodeStoredCredentialGeneration(value);
  if (
    decoded.connectionId !== connectionId ||
    decoded.generation !== generation
  ) {
    throw new Error("Credential generation is unavailable");
  }
  return decoded;
}

export class CredentialUserBackendContribution {
  private readonly keyring;
  private readonly now: () => number;

  constructor(private readonly host: CredentialUserBackendHost) {
    this.keyring = parseCredentialKeyringV1(host.keyring);
    this.now = host.now ?? Date.now;
  }

  private async enqueueLease(
    storage: CredentialTransaction,
    effectId: string,
    expiresAt: number,
  ): Promise<void> {
    const stateValue = await storage.get<unknown>(LEASE_QUEUE_STATE_KEY);
    let state: StoredLeaseQueue =
      stateValue === undefined
        ? {
            schemaVersion: 1,
            headPage: 0,
            tailPage: 0,
            scanPage: null,
            scanMinimum: null,
            nextAlarm: null,
          }
        : decodeStoredLeaseQueue(stateValue);
    let pageValue = await storage.get<unknown>(
      leaseQueuePageKey(state.tailPage),
    );
    let page = pageValue === undefined ? [] : decodeLeaseQueuePage(pageValue);
    if (page.length >= MAX_LEASE_RECOVERIES_PER_ALARM) {
      state = { ...state, tailPage: state.tailPage + 1 };
      pageValue = await storage.get<unknown>(leaseQueuePageKey(state.tailPage));
      page = pageValue === undefined ? [] : decodeLeaseQueuePage(pageValue);
    }
    await storage.put({
      [leaseQueuePageKey(state.tailPage)]: [...page, effectId],
      [leaseQueuePointerKey(effectId)]: state.tailPage,
      [LEASE_QUEUE_STATE_KEY]: {
        ...state,
        nextAlarm:
          state.nextAlarm === null
            ? expiresAt
            : Math.min(state.nextAlarm, expiresAt),
      } satisfies StoredLeaseQueue,
    });
  }

  async prepareApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    apiKey: string;
    now?: string;
  }): Promise<PreparedApiKeyCredential> {
    return {
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: input.packageId,
      generation: input.generation,
      envelope: await sealCredentialV1({
        keyring: this.keyring,
        context: {
          accountId: input.accountId,
          connectionId: input.connectionId,
          packageId: input.packageId,
          credentialGeneration: input.generation,
        },
        plaintext: input.apiKey,
        createdAt: input.now,
      }),
    };
  }

  async stagePreparedApiKey(
    input: PreparedApiKeyCredential,
    storage: CredentialTransaction = this.host.storage,
  ): Promise<void> {
    const key = credentialKey(input.connectionId, input.generation);
    const existingValue = await storage.get<unknown>(key);
    const existing =
      existingValue === undefined
        ? undefined
        : decodeStoredCredentialGeneration(existingValue);
    if (existing) {
      if (
        existing.accountId !== input.accountId ||
        existing.packageId !== input.packageId
      ) {
        throw new Error("Credential generation authority does not match");
      }
      return;
    }
    await storage.put(key, {
      schemaVersion: 1,
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: input.packageId,
      generation: input.generation,
      state: "pending",
      envelope: input.envelope,
      leaseIds: [],
    } satisfies StoredCredentialGeneration);
  }

  async stageApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    apiKey: string;
    now?: string;
  }): Promise<void> {
    await this.stagePreparedApiKey(await this.prepareApiKey(input));
  }

  async readStagedApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
  }): Promise<string> {
    const stored = requireGeneration(
      await this.host.storage.get<unknown>(
        credentialKey(input.connectionId, input.generation),
      ),
      input.connectionId,
      input.generation,
    );
    if (
      stored.accountId !== input.accountId ||
      stored.packageId !== input.packageId ||
      stored.state !== "pending"
    ) {
      throw new Error("Pending credential authority does not match");
    }
    return openCredentialV1({
      keyring: this.keyring,
      context: {
        accountId: stored.accountId,
        connectionId: stored.connectionId,
        packageId: stored.packageId,
        credentialGeneration: stored.generation,
      },
      envelope: stored.envelope,
    });
  }

  async activate(
    input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      generation: string;
    },
    storage?: CredentialTransaction,
  ): Promise<void> {
    const activate = async (transaction: CredentialTransaction) => {
      const next = requireGeneration(
        await transaction.get<unknown>(
          credentialKey(input.connectionId, input.generation),
        ),
        input.connectionId,
        input.generation,
      );
      if (
        next.accountId !== input.accountId ||
        next.packageId !== input.packageId
      ) {
        throw new Error("Credential generation authority does not match");
      }
      const currentGenerationValue = await transaction.get<unknown>(
        activeKey(input.connectionId),
      );
      const currentGeneration =
        currentGenerationValue === undefined
          ? undefined
          : decodeStoredGenerationId(currentGenerationValue);
      const entries: Record<string, unknown> = {
        [credentialKey(input.connectionId, input.generation)]: {
          ...next,
          state: "active",
        } satisfies StoredCredentialGeneration,
        [activeKey(input.connectionId)]: input.generation,
      };
      let obsoleteGenerationKey: string | undefined;
      if (currentGeneration && currentGeneration !== input.generation) {
        const current = requireGeneration(
          await transaction.get<unknown>(
            credentialKey(input.connectionId, currentGeneration),
          ),
          input.connectionId,
          currentGeneration,
        );
        const currentKey = credentialKey(input.connectionId, currentGeneration);
        if (current.leaseIds.length === 0) {
          obsoleteGenerationKey = currentKey;
        } else {
          entries[currentKey] = {
            ...current,
            state: "retired",
          } satisfies StoredCredentialGeneration;
        }
      }
      if (currentGeneration && currentGeneration !== input.generation) {
        const indexKey = leaseTombstoneIndexKey(
          input.connectionId,
          currentGeneration,
        );
        const tombstoneIndexValue = await transaction.get<unknown>(indexKey);
        const tombstoneIndex =
          tombstoneIndexValue === undefined
            ? []
            : decodeStoredStringList(
                tombstoneIndexValue,
                "credential lease tombstone index",
              );
        for (const effectId of tombstoneIndex) {
          const tombstoneValue = await transaction.get<unknown>(
            leaseTombstoneKey(effectId),
          );
          if (tombstoneValue === undefined) continue;
          const tombstone = decodeLeaseTombstone(tombstoneValue);
          if (
            tombstone.connectionId !== input.connectionId ||
            tombstone.credentialGeneration !== currentGeneration
          ) {
            throw new Error("Credential lease tombstone index is invalid");
          }
          await transaction.delete(leaseTombstoneKey(effectId));
        }
        entries[indexKey] = [];
      }
      await transaction.put(entries);
      if (obsoleteGenerationKey && currentGeneration) {
        await transaction.delete(obsoleteGenerationKey);
        await transaction.delete(
          leaseGenerationIndexKey(input.connectionId, currentGeneration),
        );
        await transaction.delete(
          leaseTombstoneIndexKey(input.connectionId, currentGeneration),
        );
      }
    };
    await (storage
      ? activate(storage)
      : this.host.storage.transaction(activate));
  }

  async discardPending(
    connectionId: string,
    generation: string,
    storage?: CredentialTransaction,
  ): Promise<void> {
    const discard = async (transaction: CredentialTransaction) => {
      const key = credentialKey(connectionId, generation);
      const storedValue = await transaction.get<unknown>(key);
      if (storedValue === undefined) return;
      const stored = decodeStoredCredentialGeneration(storedValue);
      if (stored.state !== "pending") return;
      if (stored.leaseIds.length === 0) {
        await transaction.delete(key);
      } else {
        await transaction.put(key, { ...stored, state: "retired" });
      }
    };
    if (storage) return discard(storage);
    return this.host.storage.transaction(discard);
  }

  async replayLease(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<CredentialLeaseV1 | undefined> {
    const storedValue = await this.host.storage.get<unknown>(
      leaseKey(input.effectId),
    );
    if (storedValue === undefined) return undefined;
    const stored = decodeStoredCredentialLease(storedValue);
    if (
      stored.accountId !== input.accountId ||
      stored.connectionId !== input.connectionId ||
      stored.packageId !== input.packageId
    ) {
      throw new Error("Credential lease effect id was reused");
    }
    if (Date.parse(stored.expiresAt) <= this.now()) {
      await this.expireLeases();
      throw new Error("Credential lease expired");
    }
    return this.publicLease(stored);
  }

  async lease(
    input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      effectId: string;
      expiresAt: string;
      expectedGeneration: string;
      credentialState?: "active" | "pending";
    },
    storage?: CredentialTransaction,
  ): Promise<CredentialLeaseV1> {
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("Credential lease expiry is invalid");
    }
    if (!storage) await this.expireLeases();
    const issue = async (transaction: CredentialTransaction) => {
      const expiredValue = await transaction.get<unknown>(
        leaseTombstoneKey(input.effectId),
      );
      const expired =
        expiredValue === undefined
          ? undefined
          : decodeLeaseTombstone(expiredValue);
      if (expired) {
        if (
          expired.accountId !== input.accountId ||
          expired.connectionId !== input.connectionId ||
          expired.packageId !== input.packageId
        ) {
          throw new Error("Credential lease effect id was reused");
        }
        throw new Error("Credential lease expired");
      }
      const existingValue = await transaction.get<unknown>(
        leaseKey(input.effectId),
      );
      const existing =
        existingValue === undefined
          ? undefined
          : decodeStoredCredentialLease(existingValue);
      if (existing) {
        if (
          existing.accountId !== input.accountId ||
          existing.connectionId !== input.connectionId ||
          existing.packageId !== input.packageId
        ) {
          throw new Error("Credential lease effect id was reused");
        }
        return this.publicLease(existing);
      }
      const credentialState = input.credentialState ?? "active";
      const activeGenerationValue =
        credentialState === "active"
          ? await transaction.get<unknown>(activeKey(input.connectionId))
          : undefined;
      const generation =
        credentialState === "pending"
          ? input.expectedGeneration
          : activeGenerationValue === undefined
            ? undefined
            : decodeStoredGenerationId(activeGenerationValue);
      if (!generation || generation !== input.expectedGeneration) {
        throw new Error("Connection credential is unavailable");
      }
      const stored = requireGeneration(
        await transaction.get<unknown>(
          credentialKey(input.connectionId, generation),
        ),
        input.connectionId,
        generation,
      );
      if (
        stored.accountId !== input.accountId ||
        stored.packageId !== input.packageId ||
        stored.state !== credentialState
      ) {
        throw new Error("Connection credential is unavailable");
      }
      const generationLeaseIndexKey = leaseGenerationIndexKey(
        input.connectionId,
        generation,
      );
      const generationLeaseIndexValue = await transaction.get<unknown>(
        generationLeaseIndexKey,
      );
      const generationLeaseIndex =
        generationLeaseIndexValue === undefined
          ? []
          : decodeStoredStringList(
              generationLeaseIndexValue,
              "credential generation lease index",
            );
      const tombstoneIndexKey = leaseTombstoneIndexKey(
        input.connectionId,
        generation,
      );
      const tombstoneIndexValue =
        await transaction.get<unknown>(tombstoneIndexKey);
      const tombstoneIndex =
        tombstoneIndexValue === undefined
          ? []
          : decodeStoredStringList(
              tombstoneIndexValue,
              "credential lease tombstone index",
            );
      if (
        tombstoneIndex.length + generationLeaseIndex.length >=
        MAX_GENERATION_LEASE_RECORDS
      ) {
        throw new Error("Credential lease capacity requires rotation");
      }
      const leaseId = crypto.randomUUID();
      const lease: StoredCredentialLease = {
        schemaVersion: 1,
        leaseId,
        effectId: input.effectId,
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        credentialGeneration: generation,
        expiresAt: input.expiresAt,
        envelope: stored.envelope,
        settled: false,
      };
      await transaction.put({
        [leaseKey(input.effectId)]: lease,
        [generationLeaseIndexKey]: [
          ...new Set([...generationLeaseIndex, input.effectId]),
        ],
        [credentialKey(input.connectionId, generation)]: {
          ...stored,
          leaseIds: [...new Set([...stored.leaseIds, leaseId])],
        } satisfies StoredCredentialGeneration,
      });
      await this.enqueueLease(transaction, input.effectId, expiresAt);
      return this.publicLease(lease);
    };
    const result = storage
      ? await issue(storage)
      : await this.host.storage.transaction(issue);
    await this.scheduleLeaseAlarm(storage);
    return result;
  }

  async openLease(input: {
    accountId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
    const storedValue = await this.host.storage.get<unknown>(
      leaseKey(input.lease.effectId),
    );
    const stored =
      storedValue === undefined
        ? undefined
        : decodeStoredCredentialLease(storedValue);
    if (
      !stored ||
      stored.accountId !== input.accountId ||
      stored.packageId !== input.packageId ||
      stored.leaseId !== input.lease.leaseId ||
      JSON.stringify(this.publicLease(stored)) !== JSON.stringify(input.lease)
    ) {
      throw new Error("Credential lease is unavailable");
    }
    if (Date.parse(stored.expiresAt) <= this.now()) {
      await this.expireLeases();
      throw new Error("Credential lease expired");
    }
    return openCredentialV1({
      keyring: this.keyring,
      context: {
        accountId: input.accountId,
        connectionId: input.lease.connectionId,
        packageId: input.packageId,
        credentialGeneration: input.lease.credentialGeneration,
      },
      envelope: input.lease.envelope,
    });
  }

  async settle(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const leaseValue = await storage.get<unknown>(leaseKey(input.effectId));
      if (leaseValue === undefined) {
        const tombstoneValue = await storage.get<unknown>(
          leaseTombstoneKey(input.effectId),
        );
        if (tombstoneValue === undefined) return;
        const tombstone = decodeLeaseTombstone(tombstoneValue);
        if (
          tombstone.accountId !== input.accountId ||
          tombstone.connectionId !== input.connectionId ||
          tombstone.packageId !== input.packageId
        ) {
          throw new Error("Credential lease authority does not match");
        }
        const indexKey = leaseTombstoneIndexKey(
          tombstone.connectionId,
          tombstone.credentialGeneration,
        );
        const indexValue = await storage.get<unknown>(indexKey);
        const index = (
          indexValue === undefined
            ? []
            : decodeStoredStringList(
                indexValue,
                "credential lease tombstone index",
              )
        ).filter((effectId) => effectId !== input.effectId);
        await storage.delete(leaseTombstoneKey(input.effectId));
        await storage.put(indexKey, index);
        return;
      }
      const lease = decodeStoredCredentialLease(leaseValue);
      if (
        lease.accountId !== input.accountId ||
        lease.connectionId !== input.connectionId ||
        lease.packageId !== input.packageId
      ) {
        throw new Error("Credential lease authority does not match");
      }
      if (lease.settled) return;
      await this.releaseLease(storage, lease, false);
    });
    await this.scheduleLeaseAlarm();
  }

  async expireLeases(now = this.now()): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const stateValue = await storage.get<unknown>(LEASE_QUEUE_STATE_KEY);
      if (stateValue === undefined) return;
      const state = decodeStoredLeaseQueue(stateValue);
      if (
        state.scanPage === null &&
        (state.nextAlarm === null || state.nextAlarm > now)
      ) {
        return;
      }
      const pageNumber = state.scanPage ?? state.headPage;
      const pageValue = await storage.get<unknown>(
        leaseQueuePageKey(pageNumber),
      );
      const effectIds =
        pageValue === undefined ? [] : decodeLeaseQueuePage(pageValue);
      const retained: string[] = [];
      let minimum = state.scanMinimum;
      for (const effectId of effectIds) {
        const leaseValue = await storage.get<unknown>(leaseKey(effectId));
        if (leaseValue === undefined) continue;
        const lease = decodeStoredCredentialLease(leaseValue);
        const expiry = Date.parse(lease.expiresAt);
        if (expiry <= now) {
          await this.releaseLease(storage, lease, true);
        } else {
          retained.push(effectId);
          minimum = minimum === null ? expiry : Math.min(minimum, expiry);
        }
      }
      if (retained.length === 0) {
        await storage.delete(leaseQueuePageKey(pageNumber));
      } else {
        await storage.put(leaseQueuePageKey(pageNumber), retained);
      }
      if (pageNumber < state.tailPage) {
        await storage.put(LEASE_QUEUE_STATE_KEY, {
          ...state,
          headPage:
            pageNumber === state.headPage && retained.length === 0
              ? state.headPage + 1
              : state.headPage,
          scanPage: pageNumber + 1,
          scanMinimum: minimum,
        } satisfies StoredLeaseQueue);
        return;
      }
      await storage.put(LEASE_QUEUE_STATE_KEY, {
        schemaVersion: 1,
        headPage:
          pageNumber === state.headPage && retained.length === 0
            ? state.tailPage
            : state.headPage,
        tailPage: state.tailPage,
        scanPage: null,
        scanMinimum: null,
        nextAlarm: minimum,
      } satisfies StoredLeaseQueue);
    });
    await this.scheduleLeaseAlarm();
  }

  async nextLeaseExpiry(
    storage: CredentialTransaction = this.host.storage,
  ): Promise<number | undefined> {
    const stateValue = await storage.get<unknown>(LEASE_QUEUE_STATE_KEY);
    if (stateValue === undefined) return undefined;
    const state = decodeStoredLeaseQueue(stateValue);
    if (state.scanPage !== null) return this.now();
    return state.nextAlarm ?? undefined;
  }

  private publicLease(lease: StoredCredentialLease): CredentialLeaseV1 {
    const { accountId: _, packageId: __, settled: ___, ...result } = lease;
    return result;
  }

  private async releaseLease(
    storage: CredentialTransaction,
    lease: StoredCredentialLease,
    expired: boolean,
  ): Promise<void> {
    const key = credentialKey(lease.connectionId, lease.credentialGeneration);
    const stored = requireGeneration(
      await storage.get<unknown>(key),
      lease.connectionId,
      lease.credentialGeneration,
    );
    const next = {
      ...stored,
      leaseIds: stored.leaseIds.filter((id) => id !== lease.leaseId),
    } satisfies StoredCredentialGeneration;
    const queuePointerValue = await storage.get<unknown>(
      leaseQueuePointerKey(lease.effectId),
    );
    if (queuePointerValue !== undefined) {
      const queuePage = storedQueueNumber(
        queuePointerValue,
        "lease queue page",
      );
      if (!expired) {
        const queuePageValue = await storage.get<unknown>(
          leaseQueuePageKey(queuePage),
        );
        const queueEntries =
          queuePageValue === undefined
            ? []
            : decodeLeaseQueuePage(queuePageValue);
        const retainedQueueEntries = queueEntries.filter(
          (effectId) => effectId !== lease.effectId,
        );
        if (retainedQueueEntries.length === 0) {
          await storage.delete(leaseQueuePageKey(queuePage));
        } else {
          await storage.put(leaseQueuePageKey(queuePage), retainedQueueEntries);
        }
      }
      await storage.delete(leaseQueuePointerKey(lease.effectId));
    }
    const generationLeaseIndexKey = leaseGenerationIndexKey(
      lease.connectionId,
      lease.credentialGeneration,
    );
    const generationLeaseIndexValue = await storage.get<unknown>(
      generationLeaseIndexKey,
    );
    const generationLeaseIndex = (
      generationLeaseIndexValue === undefined
        ? []
        : decodeStoredStringList(
            generationLeaseIndexValue,
            "credential generation lease index",
          )
    ).filter((effectId) => effectId !== lease.effectId);
    await storage.delete(leaseKey(lease.effectId));
    await storage.put(generationLeaseIndexKey, generationLeaseIndex);
    if (expired && stored.state !== "retired") {
      const tombstoneIndexKey = leaseTombstoneIndexKey(
        lease.connectionId,
        lease.credentialGeneration,
      );
      const tombstoneIndexValue = await storage.get<unknown>(tombstoneIndexKey);
      const tombstoneIndex =
        tombstoneIndexValue === undefined
          ? []
          : decodeStoredStringList(
              tombstoneIndexValue,
              "credential lease tombstone index",
            );
      await storage.put({
        [leaseTombstoneKey(lease.effectId)]: {
          accountId: lease.accountId,
          connectionId: lease.connectionId,
          packageId: lease.packageId,
          credentialGeneration: lease.credentialGeneration,
        },
        [tombstoneIndexKey]: [
          ...tombstoneIndex.filter((effectId) => effectId !== lease.effectId),
          lease.effectId,
        ],
      });
    }
    if (next.state === "retired" && next.leaseIds.length === 0) {
      await storage.delete(key);
      await storage.delete(generationLeaseIndexKey);
      await storage.delete(
        leaseTombstoneIndexKey(lease.connectionId, lease.credentialGeneration),
      );
    } else {
      await storage.put(key, next);
    }
  }

  private async scheduleLeaseAlarm(
    storage: CredentialTransaction = this.host.storage,
  ): Promise<void> {
    if (!storage.setAlarm) return;
    const next = await this.nextLeaseExpiry(storage);
    if (next === undefined) return;
    const current = await storage.getAlarm?.();
    if (
      next <= this.now() ||
      current === null ||
      current === undefined ||
      next < current
    ) {
      await storage.setAlarm(next);
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const generationValue = await storage.get<unknown>(
        activeKey(connectionId),
      );
      if (generationValue === undefined) return;
      const generation = decodeStoredGenerationId(generationValue);
      const key = credentialKey(connectionId, generation);
      const stored = requireGeneration(
        await storage.get<unknown>(key),
        connectionId,
        generation,
      );
      const tombstoneIndexKey = leaseTombstoneIndexKey(
        connectionId,
        generation,
      );
      const tombstoneIndexValue = await storage.get<unknown>(tombstoneIndexKey);
      const tombstoneIndex =
        tombstoneIndexValue === undefined
          ? []
          : decodeStoredStringList(
              tombstoneIndexValue,
              "credential lease tombstone index",
            );
      for (const effectId of tombstoneIndex) {
        const tombstoneValue = await storage.get<unknown>(
          leaseTombstoneKey(effectId),
        );
        if (tombstoneValue === undefined) continue;
        const tombstone = decodeLeaseTombstone(tombstoneValue);
        if (
          tombstone.accountId !== stored.accountId ||
          tombstone.connectionId !== connectionId ||
          tombstone.packageId !== stored.packageId ||
          tombstone.credentialGeneration !== generation
        ) {
          throw new Error("Credential lease tombstone index is invalid");
        }
        await storage.delete(leaseTombstoneKey(effectId));
      }
      await storage.delete(tombstoneIndexKey);
      await storage.delete(activeKey(connectionId));
      if (stored.leaseIds.length === 0) {
        await storage.delete(key);
        await storage.delete(leaseGenerationIndexKey(connectionId, generation));
      } else {
        await storage.put(key, { ...stored, state: "retired" });
      }
    });
  }
}

export function createCredentialUserBackendContribution(
  host: CredentialUserBackendHost,
): CredentialUserBackendContribution {
  return new CredentialUserBackendContribution(host);
}

export function createCredentialUserBackendPlugin(
  host: CredentialUserBackendHost,
  lifecycle: { mount(value: CredentialUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createCredentialUserBackendContribution(host));
}
