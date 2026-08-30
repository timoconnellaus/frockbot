import {
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
const LEASE_INDEX_KEY = "credential-lease-index";

export interface CredentialTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
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

function requireGeneration(
  value: StoredCredentialGeneration | undefined,
  connectionId: string,
  generation: string,
): StoredCredentialGeneration {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.connectionId !== connectionId ||
    value.generation !== generation
  ) {
    throw new Error("Credential generation is unavailable");
  }
  return value;
}

export class CredentialUserBackendContribution {
  private readonly keyring;
  private readonly now: () => number;

  constructor(private readonly host: CredentialUserBackendHost) {
    this.keyring = parseCredentialKeyringV1(host.keyring);
    this.now = host.now ?? Date.now;
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
    const existing = await storage.get<StoredCredentialGeneration>(key);
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
      await this.host.storage.get<StoredCredentialGeneration>(
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
        await transaction.get<StoredCredentialGeneration>(
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
      const currentGeneration = await transaction.get<string>(
        activeKey(input.connectionId),
      );
      const entries: Record<string, unknown> = {
        [credentialKey(input.connectionId, input.generation)]: {
          ...next,
          state: "active",
        } satisfies StoredCredentialGeneration,
        [activeKey(input.connectionId)]: input.generation,
      };
      if (currentGeneration && currentGeneration !== input.generation) {
        const current = requireGeneration(
          await transaction.get<StoredCredentialGeneration>(
            credentialKey(input.connectionId, currentGeneration),
          ),
          input.connectionId,
          currentGeneration,
        );
        entries[credentialKey(input.connectionId, currentGeneration)] = {
          ...current,
          state: "retired",
        } satisfies StoredCredentialGeneration;
      }
      await transaction.put(entries);
    };
    await (storage
      ? activate(storage)
      : this.host.storage.transaction(activate));
  }

  async discardPending(
    connectionId: string,
    generation: string,
  ): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const key = credentialKey(connectionId, generation);
      const stored = await storage.get<StoredCredentialGeneration>(key);
      if (stored?.state === "pending") await storage.delete(key);
    });
  }

  async lease(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
    expiresAt: string;
  }): Promise<CredentialLeaseV1> {
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("Credential lease expiry is invalid");
    }
    await this.expireLeases();
    const result = await this.host.storage.transaction(async (storage) => {
      const expired = await storage.get<{
        accountId: string;
        connectionId: string;
        packageId: string;
      }>(leaseTombstoneKey(input.effectId));
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
      const existing = await storage.get<StoredCredentialLease>(
        leaseKey(input.effectId),
      );
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
      const generation = await storage.get<string>(
        activeKey(input.connectionId),
      );
      if (!generation) throw new Error("Connection credential is unavailable");
      const stored = requireGeneration(
        await storage.get<StoredCredentialGeneration>(
          credentialKey(input.connectionId, generation),
        ),
        input.connectionId,
        generation,
      );
      if (
        stored.accountId !== input.accountId ||
        stored.packageId !== input.packageId ||
        stored.state !== "active"
      ) {
        throw new Error("Connection credential is unavailable");
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
      const leaseIndex = (await storage.get<string[]>(LEASE_INDEX_KEY)) ?? [];
      await storage.put({
        [leaseKey(input.effectId)]: lease,
        [LEASE_INDEX_KEY]: [...new Set([...leaseIndex, input.effectId])],
        [credentialKey(input.connectionId, generation)]: {
          ...stored,
          leaseIds: [...new Set([...stored.leaseIds, leaseId])],
        } satisfies StoredCredentialGeneration,
      });
      return this.publicLease(lease);
    });
    await this.scheduleLeaseAlarm();
    return result;
  }

  async openLease(input: {
    accountId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
    const stored = await this.host.storage.get<StoredCredentialLease>(
      leaseKey(input.lease.effectId),
    );
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

  async settle(effectId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const lease = await storage.get<StoredCredentialLease>(
        leaseKey(effectId),
      );
      if (!lease || lease.settled) return;
      await this.releaseLease(storage, lease, false);
    });
    await this.scheduleLeaseAlarm();
  }

  async expireLeases(now = this.now()): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const effectIds = (await storage.get<string[]>(LEASE_INDEX_KEY)) ?? [];
      for (const effectId of effectIds) {
        const lease = await storage.get<StoredCredentialLease>(
          leaseKey(effectId),
        );
        if (lease && Date.parse(lease.expiresAt) <= now) {
          await this.releaseLease(storage, lease, true);
        }
      }
    });
    await this.scheduleLeaseAlarm();
  }

  async nextLeaseExpiry(): Promise<number | undefined> {
    const effectIds =
      (await this.host.storage.get<string[]>(LEASE_INDEX_KEY)) ?? [];
    const expiries: number[] = [];
    for (const effectId of effectIds) {
      const lease = await this.host.storage.get<StoredCredentialLease>(
        leaseKey(effectId),
      );
      if (lease) expiries.push(Date.parse(lease.expiresAt));
    }
    return expiries.length > 0 ? Math.min(...expiries) : undefined;
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
      await storage.get<StoredCredentialGeneration>(key),
      lease.connectionId,
      lease.credentialGeneration,
    );
    const next = {
      ...stored,
      leaseIds: stored.leaseIds.filter((id) => id !== lease.leaseId),
    } satisfies StoredCredentialGeneration;
    const leaseIndex =
      (await storage.get<string[]>(LEASE_INDEX_KEY))?.filter(
        (effectId) => effectId !== lease.effectId,
      ) ?? [];
    await storage.delete(leaseKey(lease.effectId));
    await storage.put(LEASE_INDEX_KEY, leaseIndex);
    if (expired) {
      await storage.put(leaseTombstoneKey(lease.effectId), {
        accountId: lease.accountId,
        connectionId: lease.connectionId,
        packageId: lease.packageId,
      });
    }
    if (next.state === "retired" && next.leaseIds.length === 0) {
      await storage.delete(key);
    } else {
      await storage.put(key, next);
    }
  }

  private async scheduleLeaseAlarm(): Promise<void> {
    if (!this.host.storage.setAlarm) return;
    const next = await this.nextLeaseExpiry();
    if (next === undefined) return;
    const current = await this.host.storage.getAlarm?.();
    if (current === null || current === undefined || next < current) {
      await this.host.storage.setAlarm(next);
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const generation = await storage.get<string>(activeKey(connectionId));
      if (!generation) return;
      const key = credentialKey(connectionId, generation);
      const stored = requireGeneration(
        await storage.get<StoredCredentialGeneration>(key),
        connectionId,
        generation,
      );
      await storage.delete(activeKey(connectionId));
      if (stored.leaseIds.length === 0) await storage.delete(key);
      else await storage.put(key, { ...stored, state: "retired" });
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
