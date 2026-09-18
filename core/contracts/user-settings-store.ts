import type {
  ConnectionView,
  UserSettingsViewV1,
} from "../configuration/index.js";

/** One key-value transaction the User settings contribution runs inside. */
export interface UserSettingsTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

/** Durable storage the User settings contribution is given. */
export interface UserSettingsStorage extends UserSettingsTransaction {
  transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * The User settings contribution a provider Package is handed. The
 * implementation lives in the app; this is the seam providers compile
 * against so they do not import the app.
 */
export interface UserSettingsBackendV1 {
  read(
    userId: string,
    storage?: UserSettingsTransaction,
  ): Promise<UserSettingsViewV1>;
  readSnapshot(storage?: UserSettingsTransaction): Promise<UserSettingsViewV1>;
  createConnection(
    userId: string,
    connection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView>;
  replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    nextConnection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView>;
  getConnection(
    userId: string,
    connectionId: string,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView | undefined>;
  isPackageInstalled(userId: string, packageId: string): Promise<boolean>;
}
