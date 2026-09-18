import type {
  CredentialEnvelopeV1,
  CredentialLeaseV1,
} from "../connection/credentials.js";

/** One key-value transaction the credential contribution runs inside. */
export interface CredentialTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm?(): Promise<number | null>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
}

/** Durable storage the credential contribution is given. */
export interface CredentialStorage extends CredentialTransaction {
  transaction<T>(
    callback: (storage: CredentialTransaction) => Promise<T>,
  ): Promise<T>;
}

/** An encrypted API key the contribution has prepared and not yet activated. */
export interface PreparedApiKeyCredential {
  accountId: string;
  connectionId: string;
  packageId: string;
  generation: string;
  envelope: CredentialEnvelopeV1;
}

/**
 * The credential contribution a provider Package is handed. The
 * implementation lives in the app; this is the seam providers compile
 * against so they do not import the app.
 */
export interface CredentialUserBackendV1 {
  prepareApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    apiKey: string;
    now?: string;
  }): Promise<PreparedApiKeyCredential>;
  stagePreparedApiKey(
    input: PreparedApiKeyCredential,
    storage?: CredentialTransaction,
  ): Promise<void>;
  stageApiKey(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    apiKey: string;
    now?: string;
  }): Promise<void>;
  activate(
    input: {
      accountId: string;
      connectionId: string;
      packageId: string;
      generation: string;
    },
    storage?: CredentialTransaction,
  ): Promise<void>;
  openPreparedSecret(input: PreparedApiKeyCredential): Promise<string>;
  refreshActiveSecret(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    generation: string;
    needsRefresh(secret: string): boolean;
    refresh(secret: string): Promise<string>;
  }): Promise<void>;
  discardPending(
    connectionId: string,
    generation: string,
    storage?: CredentialTransaction,
  ): Promise<void>;
  replayLease(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<CredentialLeaseV1 | undefined>;
  lease(
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
  ): Promise<CredentialLeaseV1>;
  openLease(input: {
    accountId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string>;
  settle(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<void>;
  expireLeases(now?: number): Promise<void>;
  nextLeaseExpiry(storage?: CredentialTransaction): Promise<number | undefined>;
  disconnect(connectionId: string): Promise<void>;
}
