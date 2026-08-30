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

export interface CredentialTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface CredentialStorage extends CredentialTransaction {
  transaction<T>(
    callback: (storage: CredentialTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CredentialUserBackendHost {
  storage: CredentialStorage;
  keyring: string;
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

  constructor(private readonly host: CredentialUserBackendHost) {
    this.keyring = parseCredentialKeyringV1(host.keyring);
  }

  async stageApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    apiKey: string;
    now?: string;
  }): Promise<void> {
    const key = credentialKey(input.connectionId, input.generation);
    const existing =
      await this.host.storage.get<StoredCredentialGeneration>(key);
    if (existing) {
      if (
        existing.accountId !== input.accountId ||
        existing.packageId !== input.packageId
      ) {
        throw new Error("Credential generation authority does not match");
      }
      return;
    }
    const envelope = await sealCredentialV1({
      keyring: this.keyring,
      context: {
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        credentialGeneration: input.generation,
      },
      plaintext: input.apiKey,
      createdAt: input.now,
    });
    await this.host.storage.put(key, {
      schemaVersion: 1,
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: input.packageId,
      generation: input.generation,
      state: "pending",
      envelope,
      leaseIds: [],
    } satisfies StoredCredentialGeneration);
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

  async activate(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
  }): Promise<void> {
    await this.host.storage.transaction(async (storage) => {
      const next = requireGeneration(
        await storage.get<StoredCredentialGeneration>(
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
      const currentGeneration = await storage.get<string>(
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
          await storage.get<StoredCredentialGeneration>(
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
      await storage.put(entries);
    });
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
    return this.host.storage.transaction(async (storage) => {
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
        const {
          accountId: _,
          packageId: __,
          settled: ___,
          ...lease
        } = existing;
        return lease;
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
      await storage.put({
        [leaseKey(input.effectId)]: lease,
        [credentialKey(input.connectionId, generation)]: {
          ...stored,
          leaseIds: [...new Set([...stored.leaseIds, leaseId])],
        } satisfies StoredCredentialGeneration,
      });
      const { accountId: _, packageId: __, settled: ___, ...result } = lease;
      return result;
    });
  }

  async openLease(input: {
    accountId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
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
      await storage.delete(leaseKey(effectId));
      if (next.state === "retired" && next.leaseIds.length === 0) {
        await storage.delete(key);
      } else {
        await storage.put(key, next);
      }
    });
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
