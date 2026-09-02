import {
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  ConfigurationDecodeError,
  decodePackageSettingIdsV1,
  decodePackageSettingsPatchV1,
  MAX_PACKAGE_SETTINGS_V1,
  decodeOperationReceiptV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  MAX_USER_CONNECTIONS_V1,
  type ConnectionView,
  type JsonValue,
  type PackageSettingValueV1,
  type OperationReceiptV1,
  type PackageInstallationView,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeCatalogContentHashV1,
  decodeCatalogGenerationIdV1,
  type CatalogEntryV1,
  type CatalogIndexV1,
  type CatalogPinV1,
} from "@frockbot/catalog-core";
import type { ConnectionCommandV1 } from "@frockbot/connection-core";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import type { Plugin } from "cordis";

const STATE_KEY = "user-configuration";
const DEFAULT_PACKAGES_BOOTSTRAP_KEY = "user-default-packages-bootstrap:v1";
/**
 * The pinned Catalog generation lives beside the settings view rather than in
 * it, so pinning on a read never bumps the settings revision a client is
 * holding an `expectedRevision` against. It is projected into the view when
 * the view is read.
 */
const CATALOG_PIN_KEY = "user-catalog-pin";
const IDENTITY_KEY = "user-id";
const RECEIPT_PREFIX = "configuration-receipt:";

interface StoredConfigurationReceipt {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

export interface UserSettingsTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

export interface UserSettingsStorage extends UserSettingsTransaction {
  transaction<T>(
    callback: (storage: UserSettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * A provider Package registers one Connection command owner per Package so the
 * Settings Contribution can adjudicate Connection command authority without
 * naming any provider.
 */
export interface ConnectionCommandOwner {
  readonly packageId: string;
  lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<unknown>;
}

/**
 * A Package-owned, idempotent bootstrap that runs before the User settings
 * projection is returned. The Package keeps its own marker and durable state;
 * Settings supplies only the read lifecycle that makes first use deterministic.
 */
export interface UserConfigurationReadBootstrap {
  readonly packageId: string;
  bootstrap(userId: string): Promise<void>;
}

/**
 * The remote Package Catalog, as the User Durable Object sees it. A host that
 * omits it keeps the compiled-in behaviour exactly: `availablePackages` is
 * still the only source of installable Packages.
 *
 * Neither method reaches R2 or the network from this Contribution — the
 * adapter that owns the bucket implements them, so this Package names no
 * Cloudflare type and stays testable with a plain object.
 */
export interface UserPackageCatalogHost {
  /**
   * The generation the Catalog currently points at, with the content hash of
   * its index bytes. `undefined` when the deployment has no Catalog yet, which
   * leaves the User unpinned rather than failing a read.
   */
  readCurrentIndex(): Promise<
    { pin: CatalogPinV1; index: CatalogIndexV1 } | undefined
  >;
  /**
   * One entry from an exact, immutable generation. `undefined` when that
   * generation does not contain the entry.
   */
  readEntry(
    generation: string,
    catalogId: string,
  ): Promise<CatalogEntryV1 | undefined>;
}

/**
 * One Package this application can execute, as the User Durable Object needs
 * to see it: its identity, and the settings its manifest declares.
 *
 * The definitions travel with the version, not with the Package id: a Package
 * that narrows a setting in a later version must validate a write against the
 * version this User actually has installed.
 */
export interface AvailableUserPackage {
  packageId: string;
  version: string;
  /**
   * True when the immutable application manifest declares a Connection Type
   * or Capability for this Package. These are the Packages a new User owns
   * from their first configuration read.
   */
  installByDefault?: boolean;
  /** The seeded installation state. Omission preserves the enabled default. */
  defaultEnablement?: "enabled" | "disabled";
  /** The Package manifest's Package-id-to-version-range dependency record. */
  dependencies?: Readonly<Record<string, string>>;
  /**
   * `configuration.settings` from this version's manifest. Absent is the same
   * as empty and means the Package offers no User-level setting, so every
   * `user/set-package-settings` naming it is refused.
   */
  settings?: readonly PackageSettingDefinition[];
}

export interface UserSettingsBackendHost {
  storage: UserSettingsStorage;
  availablePackages: readonly AvailableUserPackage[];
  catalog?: UserPackageCatalogHost;
}

function initialState(): UserSettingsViewV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "FrockBot user" },
    packages: [],
    connections: [],
  };
}

function decodeStoredConfigurationReceipt(
  input: unknown,
): StoredConfigurationReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored configuration receipt is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => key !== "commandFingerprint" && key !== "receipt",
    ) ||
    typeof value.commandFingerprint !== "string"
  ) {
    throw new Error("Stored configuration receipt is invalid");
  }
  return {
    commandFingerprint: value.commandFingerprint,
    receipt: decodeOperationReceiptV1(value.receipt),
  };
}

function requireMatchingConfigurationReceipt(
  stored: StoredConfigurationReceipt,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}

/**
 * An install may only name the generation this User is pinned to. Refusing
 * anything else is what makes "Composition consumes immutable,
 * content-addressed artifacts" true of an install: a client holding a stale
 * index cannot install an entry that generation never contained.
 */
function assertPinnedGeneration(
  commandGeneration: string | undefined,
  pinnedGeneration: string | undefined,
): void {
  if (!pinnedGeneration) {
    throw new Error("Package Catalog generation is not pinned");
  }
  if (commandGeneration !== pinnedGeneration) {
    throw new Error(
      `Package Catalog generation "${commandGeneration}" is not the pinned generation "${pinnedGeneration}"`,
    );
  }
}

function withCatalogPin(
  settings: UserSettingsViewV1,
  pin: CatalogPinV1 | undefined,
): UserSettingsViewV1 {
  return pin
    ? {
        ...settings,
        catalogGeneration: pin.generation,
        catalogIndexHash: pin.indexHash,
      }
    : settings;
}

/**
 * The setting values one installation carries after a partial update.
 *
 * `values` on the installation row *is* the store: the Catalog install path of
 * ADR 0014 writes setup values there, and this writes the same field, so a
 * Package has exactly one durable bag of configuration and the projection the
 * client already reads needs no second source.
 */
function mergePackageSettingValues(
  current: Record<string, JsonValue | PackageSettingValueV1> | undefined,
  patch: Record<string, PackageSettingValueV1>,
  unset: readonly string[],
): Record<string, JsonValue | PackageSettingValueV1> {
  const merged: Record<string, JsonValue | PackageSettingValueV1> = {
    ...(current ?? {}),
  };
  for (const [settingId, value] of Object.entries(patch)) {
    merged[settingId] = value;
  }
  for (const settingId of unset) delete merged[settingId];
  if (Object.keys(merged).length > MAX_PACKAGE_SETTINGS_V1) {
    throw new ConfigurationDecodeError("Package settings are too many");
  }
  return merged;
}

function applyUserCommand(
  current: UserSettingsViewV1,
  command: UserConfigurationCommandV1,
  settingDefinitions: (
    packageId: string,
    version: string,
  ) => readonly PackageSettingDefinition[],
): UserSettingsViewV1 {
  const revision = current.revision + 1;
  switch (command.type) {
    case "user/update-profile":
      return { ...current, revision, profile: command.profile };
    case "user/set-platform-model":
      return {
        ...current,
        revision,
        platformModel: command.model,
      };
    case "user/install-package": {
      const existing = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      // One store, two writers: a Catalog install's setup values and
      // `user/set-package-settings` write the same bag, and a reinstall — a
      // version bump, say — carries the configuration forward rather than
      // silently returning the Package to its defaults.
      const values = {
        ...(existing?.values ?? {}),
        ...structuredClone(command.values ?? {}),
      };
      return {
        ...current,
        revision,
        packages: [
          ...current.packages.filter(
            (pkg) => pkg.packageId !== command.packageId,
          ),
          {
            packageId: command.packageId,
            version: command.version,
            state:
              existing?.state === "failed"
                ? "failed"
                : command.enabled === false
                  ? "disabled"
                  : "installed",
            failure: existing?.failure,
            // A Catalog install records where it came from; the compiled-in
            // path records nothing new, so an old row keeps its exact shape.
            ...(command.catalogId === undefined
              ? {}
              : {
                  catalogId: command.catalogId,
                  catalogGeneration: command.catalogGeneration,
                  provenance: "catalog" as const,
                }),
            ...(Object.keys(values).length === 0 ? {} : { values }),
          },
        ],
      };
    }
    case "user/uninstall-package": {
      // Removing the row is the whole effect. Connections are the User's own
      // and outlive any Package (ADR 0019).
      if (
        !current.packages.some((pkg) => pkg.packageId === command.packageId)
      ) {
        throw new Error(`Package "${command.packageId}" is not installed`);
      }
      return {
        ...current,
        revision,
        packages: current.packages.filter(
          (pkg) => pkg.packageId !== command.packageId,
        ),
      };
    }
    case "user/set-package-settings": {
      const installed = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (!installed) {
        throw new ConfigurationDecodeError(
          `Package "${command.packageId}" is not installed`,
        );
      }
      // Validated against the manifest of the version this User has, not the
      // one the client happened to be looking at.
      const definitions = settingDefinitions(
        installed.packageId,
        installed.version,
      );
      const patch = command.values
        ? decodePackageSettingsPatchV1(definitions, command.values)
        : {};
      const unset = command.unset
        ? decodePackageSettingIdsV1(definitions, command.unset)
        : [];
      return {
        ...current,
        revision,
        packages: current.packages.map((pkg) =>
          pkg.packageId !== command.packageId
            ? pkg
            : (() => {
                const values = mergePackageSettingValues(
                  pkg.values,
                  patch,
                  unset,
                );
                const { values: _storedValues, ...withoutValues } = pkg;
                return Object.keys(values).length > 0
                  ? { ...withoutValues, values }
                  : withoutValues;
              })(),
        ),
      };
    }
    case "user/set-package-enabled": {
      const installed = current.packages.some(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (!installed) {
        throw new Error(`Package "${command.packageId}" is not installed`);
      }
      return {
        ...current,
        revision,
        packages: current.packages.map((pkg) =>
          pkg.packageId === command.packageId
            ? {
                ...pkg,
                state: command.enabled ? "installed" : "disabled",
                failure: undefined,
              }
            : pkg,
        ),
      };
    }
  }
}

export class UserSettingsBackendContribution {
  private readonly availablePackages: ReadonlySet<string>;

  /** Declared Package dependencies, by Package id and version. */
  private readonly packageDependencies: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;

  /** The immutable first-party installation rows written on first read. */
  private readonly defaultPackages: readonly PackageInstallationView[];

  /** Declared User-level settings, by Package id and version. */
  private readonly packageSettingDefinitions: ReadonlyMap<
    string,
    readonly PackageSettingDefinition[]
  >;

  private readonly connectionOwners = new Map<string, ConnectionCommandOwner>();

  private readonly readBootstraps = new Map<
    string,
    UserConfigurationReadBootstrap
  >();

  constructor(private readonly host: UserSettingsBackendHost) {
    this.availablePackages = new Set(
      host.availablePackages.map(
        ({ packageId, version }) => `${packageId}\u0000${version}`,
      ),
    );
    this.packageDependencies = new Map(
      host.availablePackages.map((pkg) => [
        `${pkg.packageId}\u0000${pkg.version}`,
        pkg.dependencies ?? {},
      ]),
    );
    this.packageSettingDefinitions = new Map(
      host.availablePackages.map((pkg) => [
        `${pkg.packageId}\u0000${pkg.version}`,
        pkg.settings ?? [],
      ]),
    );
    this.defaultPackages = host.availablePackages.flatMap((pkg) =>
      pkg.installByDefault
        ? [
            {
              packageId: pkg.packageId,
              version: pkg.version,
              state:
                pkg.defaultEnablement === "disabled"
                  ? ("disabled" as const)
                  : ("installed" as const),
              provenance: "first-party" as const,
            },
          ]
        : [],
    );
  }

  /**
   * Persist the application's first-party Package availability exactly once.
   *
   * The marker, rows, and revision bump share one transaction. A later
   * uninstall therefore leaves the marker behind and cannot be undone by a
   * read, while concurrent first reads converge on the same durable state.
   */
  private async bootstrapDefaultPackages(
    userId: string,
    storage?: UserSettingsTransaction,
  ): Promise<UserSettingsViewV1> {
    if (this.defaultPackages.length === 0) {
      await this.assertIdentity(userId, storage ?? this.host.storage);
      return this.readSnapshot(storage ?? this.host.storage);
    }
    const bootstrap = async (transaction: UserSettingsTransaction) => {
      await this.assertIdentity(userId, transaction);
      const marker = await transaction.get<unknown>(
        DEFAULT_PACKAGES_BOOTSTRAP_KEY,
      );
      if (marker !== undefined) {
        if (
          !marker ||
          typeof marker !== "object" ||
          Array.isArray(marker) ||
          Object.keys(marker).length !== 1 ||
          (marker as { schemaVersion?: unknown }).schemaVersion !== 1
        ) {
          throw new Error("Stored default Package bootstrap is invalid");
        }
        return this.readSnapshot(transaction);
      }
      const current = await this.readSnapshot(transaction);
      const installedPackageIds = new Set(
        current.packages.map((pkg) => pkg.packageId),
      );
      const additions = this.defaultPackages.filter(
        (pkg) => !installedPackageIds.has(pkg.packageId),
      );
      const next = {
        ...current,
        revision: current.revision + 1,
        packages: [
          ...current.packages,
          ...additions.map((pkg) => structuredClone(pkg)),
        ],
      } satisfies UserSettingsViewV1;
      await transaction.put({
        [STATE_KEY]: next,
        [DEFAULT_PACKAGES_BOOTSTRAP_KEY]: { schemaVersion: 1 },
      });
      return structuredClone(next);
    };
    return storage
      ? bootstrap(storage)
      : this.host.storage.transaction(bootstrap);
  }

  /**
   * The settings one installed version declares. A version this application
   * cannot execute declares none, so a write against it is refused rather than
   * stored against a manifest nobody here has.
   */
  private settingDefinitions(
    packageId: string,
    version: string,
  ): readonly PackageSettingDefinition[] {
    return (
      this.packageSettingDefinitions.get(`${packageId}\u0000${version}`) ?? []
    );
  }

  private packageDependencyFailure(
    packageId: string,
    version: string,
    settings: UserSettingsViewV1,
  ): string | undefined {
    const dependencies = this.packageDependencies.get(
      `${packageId}\u0000${version}`,
    );
    if (!dependencies) return undefined;
    for (const dependencyId of Object.keys(dependencies).sort()) {
      const available = settings.packages.some(
        (pkg) => pkg.packageId === dependencyId && pkg.state === "installed",
      );
      if (!available) {
        return `Package "${packageId}" requires Package "${dependencyId}" to be installed and enabled; enable "${dependencyId}" first`;
      }
    }
    return undefined;
  }

  async readConfiguration(input: unknown): Promise<UserSettingsViewV1> {
    const request = decodeUserConfigurationReadRpcV1(input);
    for (const bootstrap of this.readBootstraps.values()) {
      await bootstrap.bootstrap(request.userId);
    }
    // The first read that finds a Catalog pins its generation, so every later
    // install is validated against one immutable, content-addressed set of
    // artifacts rather than whatever the pointer happens to name that second.
    const pin = await this.pinCatalogGeneration(request.userId);
    return withCatalogPin(await this.read(request.userId), pin);
  }

  /**
   * The Catalog generation this User is pinned to, pinning it on first sight.
   * `undefined` when the deployment has no Catalog, which is not a failure:
   * compiled-in Packages install through the unchanged path either way.
   */
  async pinCatalogGeneration(
    userId: string,
  ): Promise<CatalogPinV1 | undefined> {
    const catalog = this.host.catalog;
    if (!catalog) return undefined;
    const stored = await this.readCatalogPin(this.host.storage);
    if (stored) return stored;
    const current = await catalog.readCurrentIndex();
    if (!current) return undefined;
    return this.host.storage.transaction(async (storage) => {
      await this.assertIdentity(userId, storage);
      const existing = await this.readCatalogPin(storage);
      if (existing) return existing;
      const pin: CatalogPinV1 = {
        generation: decodeCatalogGenerationIdV1(current.pin.generation),
        indexHash: decodeCatalogContentHashV1(current.pin.indexHash),
      };
      await storage.put(CATALOG_PIN_KEY, pin);
      return pin;
    });
  }

  private async readCatalogPin(
    storage: UserSettingsTransaction,
  ): Promise<CatalogPinV1 | undefined> {
    const stored = await storage.get<unknown>(CATALOG_PIN_KEY);
    if (stored === undefined) return undefined;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("Stored Catalog pin is invalid");
    }
    const value = stored as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => key !== "generation" && key !== "indexHash",
      )
    ) {
      throw new Error("Stored Catalog pin is invalid");
    }
    return {
      generation: decodeCatalogGenerationIdV1(value.generation),
      indexHash: decodeCatalogContentHashV1(value.indexHash),
    };
  }

  /**
   * Resolve a Catalog install against the pinned generation, before the
   * durable transaction opens: reading an entry is object-storage I/O, and a
   * Durable Object transaction is not the place for it. The pinned generation
   * is checked again inside the transaction, so a pin that moved between the
   * two loses the race rather than admitting a stale install.
   */
  private async resolveCatalogInstall(command: {
    packageId: string;
    version: string;
    catalogId: string;
    catalogGeneration: string;
  }): Promise<CatalogEntryV1> {
    const catalog = this.host.catalog;
    if (!catalog) {
      throw new Error("Package Catalog is not available");
    }
    const pin = await this.readCatalogPin(this.host.storage);
    if (!pin) {
      throw new Error("Package Catalog generation is not pinned");
    }
    assertPinnedGeneration(command.catalogGeneration, pin.generation);
    const entry = await catalog.readEntry(pin.generation, command.catalogId);
    if (!entry) {
      throw new Error(
        `Catalog entry "${command.catalogId}" is not in pinned Catalog generation "${pin.generation}"`,
      );
    }
    if (
      entry.packageId !== command.packageId ||
      entry.version !== command.version
    ) {
      throw new Error(
        `Catalog entry "${command.catalogId}" does not offer Package "${command.packageId}" at version "${command.version}"`,
      );
    }
    return entry;
  }

  async executeConfiguration(input: unknown): Promise<OperationReceiptV1> {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    const { command } = request;
    const commandFingerprint = configurationCommandFingerprintV1(command);
    await this.assertIdentity(request.userId);
    const catalogInstall =
      command.type === "user/install-package" &&
      command.catalogId !== undefined &&
      command.catalogGeneration !== undefined
        ? await this.resolveCatalogInstall({
            packageId: command.packageId,
            version: command.version,
            catalogId: command.catalogId,
            catalogGeneration: command.catalogGeneration,
          })
        : undefined;
    return this.host.storage.transaction((storage) =>
      this.applyConfigurationCommand(
        request.userId,
        command,
        storage,
        commandFingerprint,
        catalogInstall,
      ),
    );
  }

  /**
   * Apply one already-decoded built-in User command inside a caller-owned
   * transaction. Provider bootstraps use this so their Connection, marker and
   * default-model change commit atomically through the normal reducer and
   * receipt path.
   */
  async executeConfigurationCommand(
    userId: string,
    command: UserConfigurationCommandV1,
    storage: UserSettingsTransaction,
  ): Promise<OperationReceiptV1> {
    if (
      command.type === "user/install-package" &&
      command.catalogId !== undefined
    ) {
      throw new Error(
        "Catalog installs must be resolved through executeConfiguration",
      );
    }
    return this.applyConfigurationCommand(
      userId,
      command,
      storage,
      configurationCommandFingerprintV1(command),
    );
  }

  private async applyConfigurationCommand(
    userId: string,
    command: UserConfigurationCommandV1,
    storage: UserSettingsTransaction,
    commandFingerprint: string,
    catalogInstall?: CatalogEntryV1,
  ): Promise<OperationReceiptV1> {
    await this.assertIdentity(userId, storage);
    const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
    const storedReceipt = await storage.get<unknown>(receiptKey);
    if (storedReceipt !== undefined) {
      return requireMatchingConfigurationReceipt(
        decodeStoredConfigurationReceipt(storedReceipt),
        commandFingerprint,
        command.commandId,
      );
    }
    if (command.type === "user/install-package") {
      if (catalogInstall) {
        assertPinnedGeneration(
          command.catalogGeneration,
          (await this.readCatalogPin(storage))?.generation,
        );
      } else if (
        !this.availablePackages.has(
          `${command.packageId}\u0000${command.version}`,
        )
      ) {
        throw new Error("Package is not available in this application");
      }
    }
    const storedSettings = await storage.get<unknown>(STATE_KEY);
    const current =
      storedSettings === undefined
        ? initialState()
        : decodeUserSettingsViewV1(storedSettings);
    if (command.type === "user/set-package-enabled" && command.enabled) {
      const installed = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (
        installed &&
        !this.availablePackages.has(
          `${installed.packageId}\u0000${installed.version}`,
        )
      ) {
        throw new Error("Package is not available in this application");
      }
    }
    if (command.expectedRevision !== current.revision) {
      throw new ConfigurationConflictError(current.revision);
    }
    let dependencyFailure: string | undefined;
    if (command.type === "user/install-package" && command.enabled !== false) {
      dependencyFailure = this.packageDependencyFailure(
        command.packageId,
        command.version,
        current,
      );
    } else if (command.type === "user/set-package-enabled" && command.enabled) {
      const installed = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      if (installed) {
        dependencyFailure = this.packageDependencyFailure(
          installed.packageId,
          installed.version,
          current,
        );
      }
    }
    if (dependencyFailure) {
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure: dependencyFailure,
      };
      await storage.put(receiptKey, { commandFingerprint, receipt });
      return receipt;
    }
    const next = applyUserCommand(current, command, (packageId, version) =>
      this.settingDefinitions(packageId, version),
    );
    const receipt: OperationReceiptV1 = {
      schemaVersion: 1,
      commandId: command.commandId,
      revision: next.revision,
      status: "applied",
    };
    await storage.put({
      [STATE_KEY]: next,
      [receiptKey]: { commandFingerprint, receipt },
    });
    return receipt;
  }

  async readSnapshot(
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<UserSettingsViewV1> {
    const stored = await storage.get<unknown>(STATE_KEY);
    return stored === undefined
      ? initialState()
      : decodeUserSettingsViewV1(stored);
  }

  async read(
    userId: string,
    storage?: UserSettingsTransaction,
  ): Promise<UserSettingsViewV1> {
    return this.bootstrapDefaultPackages(userId, storage);
  }

  async createConnection(
    userId: string,
    connection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView> {
    const create = async (transaction: UserSettingsTransaction) => {
      await this.assertIdentity(userId, transaction);
      const current = await this.readSnapshot(transaction);
      const existing = current.connections.find(
        (candidate) => candidate.connectionId === connection.connectionId,
      );
      if (existing) return existing;
      const retained = current.connections.filter(
        (candidate) => candidate.state !== "revoked",
      );
      if (retained.length >= MAX_USER_CONNECTIONS_V1) {
        throw new Error("User Connection limit reached");
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: [...retained, structuredClone(connection)],
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      return structuredClone(connection);
    };
    if (storage) return create(storage);
    return this.host.storage.transaction(create);
  }

  async replaceConnection(
    userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    nextConnection: ConnectionView,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView> {
    const replace = async (transaction: UserSettingsTransaction) => {
      await this.assertIdentity(userId, transaction);
      const current = await this.readSnapshot(transaction);
      const existing = current.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!existing) throw new Error("Connection is unavailable");
      if (existing.generation !== expectedGeneration) {
        throw new Error("Connection generation changed");
      }
      if (nextConnection.connectionId !== connectionId) {
        throw new Error("Connection identity cannot change");
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        connections: current.connections.map((candidate) =>
          candidate.connectionId === connectionId
            ? structuredClone(nextConnection)
            : candidate,
        ),
      } satisfies UserSettingsViewV1;
      await transaction.put(STATE_KEY, next);
      return structuredClone(nextConnection);
    };
    if (storage) return replace(storage);
    return this.host.storage.transaction(replace);
  }

  async getConnection(
    userId: string,
    connectionId: string,
    storage?: UserSettingsTransaction,
  ): Promise<ConnectionView | undefined> {
    const settings = await this.read(userId, storage);
    const connection = settings.connections.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return connection ? structuredClone(connection) : undefined;
  }

  registerConfigurationReadBootstrap(
    bootstrap: UserConfigurationReadBootstrap,
  ): () => void {
    if (this.readBootstraps.has(bootstrap.packageId)) {
      throw new Error(
        `Package "${bootstrap.packageId}" already registered a User bootstrap`,
      );
    }
    this.readBootstraps.set(bootstrap.packageId, bootstrap);
    return () => {
      if (this.readBootstraps.get(bootstrap.packageId) === bootstrap) {
        this.readBootstraps.delete(bootstrap.packageId);
      }
    };
  }

  registerConnectionCommandOwner(owner: ConnectionCommandOwner): () => void {
    if (this.connectionOwners.has(owner.packageId)) {
      throw new Error(
        `Connection Package "${owner.packageId}" is already registered`,
      );
    }
    this.connectionOwners.set(owner.packageId, owner);
    return () => {
      if (this.connectionOwners.get(owner.packageId) === owner) {
        this.connectionOwners.delete(owner.packageId);
      }
    };
  }

  /**
   * Resolve the Package that owns a Connection command from the durable
   * Connection projection, falling back to the unique registered owner that
   * still retains the command receipt after its projection was compacted.
   */
  async resolveConnectionCommandOwner(
    userId: string,
    command: ConnectionCommandV1,
  ): Promise<string> {
    const projected =
      command.type === "connection/create-api-key" ||
      command.type === "connection/create"
        ? command.packageId
        : (await this.getConnection(userId, command.connectionId))?.packageId;
    if (projected) return projected;
    const retained: string[] = [];
    for (const owner of this.connectionOwners.values()) {
      if (
        (await owner.lookupConnectionCommand(userId, command.commandId)) !==
        undefined
      ) {
        retained.push(owner.packageId);
      }
    }
    if (retained.length > 1) {
      throw new Error("Connection command authority is ambiguous");
    }
    const [ownerPackageId] = retained;
    if (!ownerPackageId) throw new Error("Connection is unavailable");
    return ownerPackageId;
  }

  async isPackageInstalled(
    userId: string,
    packageId: string,
  ): Promise<boolean> {
    const settings = await this.read(userId);
    return settings.packages.some(
      (pkg) => pkg.packageId === packageId && pkg.state === "installed",
    );
  }

  private async assertIdentity(
    userId: string,
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<void> {
    const existing = await storage.get<unknown>(IDENTITY_KEY);
    if (existing !== undefined && typeof existing !== "string") {
      throw new Error("Stored User authority is invalid");
    }
    if (existing && existing !== userId) {
      throw new Error("User authority does not match durable identity");
    }
    if (!existing) await storage.put(IDENTITY_KEY, userId);
  }
}

export function createUserSettingsBackendContribution(
  host: UserSettingsBackendHost,
): UserSettingsBackendContribution {
  return new UserSettingsBackendContribution(host);
}

export function createUserSettingsBackendPlugin(
  host: UserSettingsBackendHost,
  lifecycle: { mount(value: UserSettingsBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createUserSettingsBackendContribution(host));
}
