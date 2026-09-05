import {
  applicationSettingsFrame,
  applicationSettingsCommand,
  modelsSettingsFrame,
  modelsSettingsCommand,
} from "./settings-frame.js";
import {
  configurationCommandFingerprintV1,
  packageConfigurationHomeV1,
  ConfigurationConflictError,
  ConfigurationDecodeError,
  decodePackageSettingIdsV1,
  decodeModelBindingV1,
  decodePackageSettingsPatchV1,
  MAX_PACKAGE_SETTINGS_V1,
  decodeOperationReceiptV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  migrateStoredUserSettingsV1,
  MAX_USER_CONNECTIONS_V1,
  USER_PROFILE_PLACEHOLDER_NAME_V1,
  type ConnectionView,
  type JsonValue,
  type PackageSettingValueV1,
  type OperationReceiptV1,
  type PackageInstallationView,
  type StoredUserSettingsPackageV1,
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
import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";

const STATE_KEY = "user-configuration";
const ACCOUNT_MODEL_KEY = "user-account-model:v1";
const ACCOUNT_MODEL_CHECKPOINT_KEY =
  "user-account-model:migration-checkpoint:v1";
const DEFAULT_PACKAGES_BOOTSTRAP_KEY = "user-default-packages-bootstrap:v1";
const DEFAULT_PACKAGES_BOOTSTRAP_VERSION = 3;
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
  displayName?: string;
  capabilities?: readonly { kind: string }[];
  connectionTypes?: readonly unknown[];
  /**
   * True when the immutable application manifest declares a Connection Type
   * or Capability for this Package. These are the Packages a new User owns
   * from their first configuration read.
   */
  installByDefault?: boolean;
  /** The seeded installation state. Omission preserves the enabled default. */
  defaultEnablement?: "enabled" | "disabled";
  /** Derived from immutable manifest facts by the application compiler. */
  platformOwned?: boolean;
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
    profile: { name: USER_PROFILE_PLACEHOLDER_NAME_V1 },
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
  chooseProvider: (
    current: UserSettingsViewV1,
    packageId: string,
  ) => UserSettingsViewV1,
  settingDefinitions: (
    packageId: string,
    version: string,
  ) => readonly PackageSettingDefinition[],
): UserSettingsViewV1 {
  const revision = current.revision + 1;
  switch (command.type) {
    case "user/update-profile":
      return { ...current, revision, profile: command.profile };
    case "user/choose-model-provider":
      return chooseProvider(current, command.packageId);
    case "user/set-account-model": {
      const { accountModel: _previous, ...base } = current;
      return {
        ...base,
        revision,
        ...(command.model === null ? {} : { accountModel: command.model }),
      };
    }
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
                  ...(command.contentHash === undefined
                    ? {}
                    : { contentHash: command.contentHash }),
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

  /** Catalog-relative facts supplied to the raw stored-settings migration. */
  private readonly storedSettingsPackages: readonly StoredUserSettingsPackageV1[];

  /** Package ids whose installation state is platform policy, not a User choice. */
  private readonly platformOwnedPackageIds: ReadonlySet<string>;

  /** Declared Package dependencies, by Package id and version. */
  private readonly packageDependencies: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;

  /** The immutable first-party installation rows written on first read. */
  private readonly defaultPackages: readonly PackageInstallationView[];

  /**
   * Packages introduced by the default-enablement rollout, plus their
   * dependency closure. A v1 marker predates those rows, so this is the one
   * bounded set that marker migration may add without replaying every default.
   */
  private readonly enablementRolloutPackages: readonly PackageInstallationView[];

  /**
   * Default-enabled rows damaged by v0.2.3's v1→v2 migration. The old pass
   * validated dependencies before it added the rollout's dependency closure,
   * so it wrote these rows disabled even though the User had made no choice.
   */
  private readonly defaultEnabledPackages: ReadonlyMap<
    string,
    PackageInstallationView
  >;

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
    this.storedSettingsPackages = host.availablePackages.map((pkg) => ({
      packageId: pkg.packageId,
      version: pkg.version,
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
      ...(pkg.platformOwned ? { platformOwned: true } : {}),
    }));
    this.platformOwnedPackageIds = new Set(
      host.availablePackages
        .filter((pkg) => pkg.platformOwned)
        .map((pkg) => pkg.packageId),
    );
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
      pkg.installByDefault || pkg.platformOwned
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
    const byPackageId = new Map(
      host.availablePackages.map((pkg) => [pkg.packageId, pkg]),
    );
    const rolloutPackageIds = new Set(
      host.availablePackages
        .filter(
          (pkg) => pkg.installByDefault && pkg.defaultEnablement !== undefined,
        )
        .map((pkg) => pkg.packageId),
    );
    for (const packageId of rolloutPackageIds) {
      for (const dependencyId of Object.keys(
        byPackageId.get(packageId)?.dependencies ?? {},
      )) {
        if (byPackageId.has(dependencyId)) rolloutPackageIds.add(dependencyId);
      }
    }
    this.enablementRolloutPackages = this.defaultPackages.filter((pkg) =>
      rolloutPackageIds.has(pkg.packageId),
    );
    this.defaultEnabledPackages = new Map(
      this.defaultPackages
        .filter((pkg) => pkg.state === "installed")
        .map((pkg) => [pkg.packageId, pkg]),
    );
  }

  private addMissingPackages(
    current: UserSettingsViewV1,
    defaults: readonly PackageInstallationView[],
  ): UserSettingsViewV1 {
    const installedPackageIds = new Set(
      current.packages.map((pkg) => pkg.packageId),
    );
    const additions = defaults.filter(
      (pkg) => !installedPackageIds.has(pkg.packageId),
    );
    return additions.length === 0
      ? current
      : {
          ...current,
          packages: [
            ...current.packages,
            ...additions.map((pkg) => structuredClone(pkg)),
          ],
        };
  }

  /** Apply the default-disabled choices first introduced by marker v2. */
  private applyEnablementRolloutDefaults(
    current: UserSettingsViewV1,
  ): UserSettingsViewV1 {
    let changed = false;
    const rolloutDefaults = new Map(
      this.enablementRolloutPackages.map((pkg) => [pkg.packageId, pkg]),
    );
    const packages = current.packages.map((pkg) => {
      const defaultPackage = rolloutDefaults.get(pkg.packageId);
      if (
        !defaultPackage ||
        defaultPackage.version !== pkg.version ||
        defaultPackage.state !== "disabled" ||
        pkg.state !== "installed" ||
        pkg.failure !== undefined ||
        pkg.provenance === "catalog"
      ) {
        return pkg;
      }
      changed = true;
      return { ...pkg, state: "disabled" as const };
    });
    return changed ? { ...current, packages } : current;
  }

  /** One-shot repair for rows the v0.2.3 marker-v2 rollout disabled. */
  private repairEnablementRolloutV2(
    current: UserSettingsViewV1,
  ): UserSettingsViewV1 {
    let changed = false;
    const packages = current.packages.map((pkg) => {
      const defaultPackage = this.defaultEnabledPackages.get(pkg.packageId);
      if (
        !defaultPackage ||
        defaultPackage.version !== pkg.version ||
        pkg.state !== "disabled" ||
        pkg.failure !== undefined ||
        pkg.provenance === "catalog"
      ) {
        return pkg;
      }
      changed = true;
      return { ...pkg, state: "installed" as const };
    });
    return changed ? { ...current, packages } : current;
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
      const stored = await transaction.get<unknown>(STATE_KEY);
      if (marker !== undefined) {
        if (
          !marker ||
          typeof marker !== "object" ||
          Array.isArray(marker) ||
          Object.keys(marker).length !== 1 ||
          ![1, 2, DEFAULT_PACKAGES_BOOTSTRAP_VERSION].includes(
            (marker as { schemaVersion?: unknown }).schemaVersion as number,
          )
        ) {
          throw new Error("Stored default Package bootstrap is invalid");
        }
        const markerVersion = (marker as { schemaVersion: number })
          .schemaVersion;

        // Marker v1 predates default-disabled model Packages and their
        // dependency closure. Seed that closure before the catalog-relative
        // fixed point sees it, then validate the complete graph. A later
        // marker gets only the platform-owned repair on this read: retirement
        // and dependency validation are one-shot migration steps, never a
        // read-time rule.
        const rawMigrated =
          stored === undefined
            ? initialState()
            : migrateStoredUserSettingsV1(
                stored,
                markerVersion === 1 ? undefined : this.storedSettingsPackages,
                "repair",
              );
        let settingsChanged = stored !== undefined && rawMigrated !== stored;
        let migrated = await this.withAccountModel(
          decodeUserSettingsViewV1(rawMigrated),
          transaction,
        );
        if (markerVersion === 1) {
          const seeded = this.applyEnablementRolloutDefaults(
            this.addMissingPackages(migrated, this.enablementRolloutPackages),
          );
          const validated = migrateStoredUserSettingsV1(
            seeded,
            this.storedSettingsPackages,
          );
          settingsChanged ||= seeded !== migrated || validated !== seeded;
          migrated = decodeUserSettingsViewV1(validated);
        }
        if (markerVersion === 2) {
          const repaired = this.repairEnablementRolloutV2(migrated);
          settingsChanged ||= repaired !== migrated;
          migrated = repaired;
        }

        if (
          markerVersion === DEFAULT_PACKAGES_BOOTSTRAP_VERSION &&
          !settingsChanged
        ) {
          return structuredClone(migrated);
        }
        const next = settingsChanged
          ? { ...migrated, revision: migrated.revision + 1 }
          : migrated;
        await transaction.put({
          ...(settingsChanged
            ? await this.configurationRecords(next, transaction)
            : {}),
          [DEFAULT_PACKAGES_BOOTSTRAP_KEY]: {
            schemaVersion: DEFAULT_PACKAGES_BOOTSTRAP_VERSION,
          },
        });
        return structuredClone(next);
      }
      const current =
        stored === undefined
          ? initialState()
          : decodeUserSettingsViewV1(
              migrateStoredUserSettingsV1(stored, this.storedSettingsPackages),
            );
      const seeded = this.addMissingPackages(
        await this.withAccountModel(current, transaction),
        this.defaultPackages,
      );
      const next = {
        ...seeded,
        revision: seeded.revision + 1,
      } satisfies UserSettingsViewV1;
      await transaction.put({
        ...(await this.configurationRecords(next, transaction)),
        [DEFAULT_PACKAGES_BOOTSTRAP_KEY]: {
          schemaVersion: DEFAULT_PACKAGES_BOOTSTRAP_VERSION,
        },
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

  /**
   * The mirror of `packageDependencyFailure`, read the other way round.
   *
   * Enabling B before A is refused, so leaving B enabled once A is switched
   * off would put the account in exactly the configuration the enable path
   * will not create. Refusing the disable is not the answer either: a Package
   * the User never chose — `provider-ollama-cloud` depends on `web` — would
   * make `web` undisableable. So the disable is allowed and carries its
   * dependents with it, transitively. Model binding degrades to the platform
   * default rather than failing, so a cascade that reaches the Package a Bot's
   * model is bound to costs that Bot its choice, not its next reply.
   *
   * Platform-owned Packages are never cascaded: they cannot be disabled by any
   * other path, and in this application they depend only on each other.
   */
  private cascadeDisabledDependents(
    settings: UserSettingsViewV1,
  ): UserSettingsViewV1 {
    let packages = settings.packages;
    for (;;) {
      const enabled = new Set(
        packages
          .filter((pkg) => pkg.state === "installed")
          .map((pkg) => pkg.packageId),
      );
      const cascaded = packages.map((pkg) => {
        if (pkg.state !== "installed") return pkg;
        if (this.platformOwnedPackageIds.has(pkg.packageId)) return pkg;
        const dependencies = this.packageDependencies.get(
          `${pkg.packageId}\u0000${pkg.version}`,
        );
        if (!dependencies) return pkg;
        const missing = Object.keys(dependencies).some(
          (dependencyId) => !enabled.has(dependencyId),
        );
        return missing
          ? { ...pkg, state: "disabled" as const, failure: undefined }
          : pkg;
      });
      if (cascaded.every((pkg, index) => pkg === packages[index])) {
        return packages === settings.packages
          ? settings
          : { ...settings, packages };
      }
      packages = cascaded;
    }
  }

  async readConfiguration(input: unknown): Promise<UserSettingsViewV1> {
    const request = decodeUserConfigurationReadRpcV1(input);
    // Settings owns the stored-record migration and platform-row repair. Run
    // it before Package bootstraps so every bootstrap observes the repaired
    // current Catalog in the same configuration read.
    await this.read(request.userId);
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
    contentHash?: string;
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
    if (entry.bundle) {
      if (command.contentHash !== entry.bundle.contentHash) {
        throw new Error(
          `Catalog entry "${command.catalogId}" requires bundle hash "${entry.bundle.contentHash}"`,
        );
      }
    } else if (command.contentHash !== undefined) {
      throw new Error(
        `Catalog entry "${command.catalogId}" does not carry a Package bundle`,
      );
    }
    return entry;
  }

  private chooseModelProvider(
    current: UserSettingsViewV1,
    packageId: string,
  ): UserSettingsViewV1 {
    const provider = this.host.availablePackages.find(
      (pkg) => pkg.packageId === packageId,
    );
    if (
      !provider?.capabilities?.some((capability) => capability.kind === "model")
    )
      throw new ConfigurationDecodeError("Model provider is unavailable");
    let packages = [...current.packages];
    const visiting = new Set<string>();
    const enable = (id: string) => {
      const existing = packages.find((pkg) => pkg.packageId === id);
      if (existing?.state === "installed") return;
      if (existing?.state === "failed")
        throw new ConfigurationDecodeError(
          "This provider needs recovery before it can be chosen",
        );
      if (visiting.has(id))
        throw new ConfigurationDecodeError(
          "Provider dependencies could not be resolved",
        );
      const available = this.host.availablePackages.find(
        (pkg) =>
          pkg.packageId === id &&
          (!existing || pkg.version === existing.version),
      );
      if (!available)
        throw new ConfigurationDecodeError(
          "A provider dependency is unavailable",
        );
      visiting.add(id);
      for (const dependency of Object.keys(available.dependencies ?? {}).sort())
        enable(dependency);
      visiting.delete(id);
      packages = [
        ...packages.filter((pkg) => pkg.packageId !== id),
        existing
          ? { ...existing, state: "installed" }
          : { packageId: id, version: available.version, state: "installed" },
      ];
    };
    enable(packageId);
    return { ...current, revision: current.revision + 1, packages };
  }

  async readSettingsFrame(userId: string, home: "application" | "models") {
    const frame =
      home === "models" ? modelsSettingsFrame : applicationSettingsFrame;
    return frame(
      userId,
      await this.readConfiguration({ schemaVersion: 1, userId }),
      this.host.availablePackages,
    );
  }

  async changeSettings(
    userId: string,
    home: "application" | "models",
    input: unknown,
  ) {
    const command =
      home === "models"
        ? modelsSettingsCommand(input)
        : applicationSettingsCommand(input);
    return this.host.storage.transaction((storage) =>
      this.applyConfigurationCommand(
        userId,
        command,
        storage,
        configurationCommandFingerprintV1(command),
        undefined,
        home,
      ),
    );
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
            ...(command.contentHash === undefined
              ? {}
              : { contentHash: command.contentHash }),
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
    home?: "application" | "models",
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
    const current = await this.readSnapshot(storage);
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
    if (
      (command.type === "user/uninstall-package" ||
        (command.type === "user/set-package-enabled" && !command.enabled)) &&
      this.platformOwnedPackageIds.has(command.packageId)
    ) {
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure: `Platform-owned Package "${command.packageId}" cannot be disabled or uninstalled`,
      };
      await storage.put(receiptKey, { commandFingerprint, receipt });
      return receipt;
    }
    if (
      home === "application" &&
      command.type === "user/set-package-settings"
    ) {
      const installed = current.packages.find(
        (pkg) => pkg.packageId === command.packageId,
      );
      const item = this.host.availablePackages.find(
        (pkg) =>
          pkg.packageId === command.packageId &&
          pkg.version === installed?.version,
      );
      if (
        installed?.state !== "installed" ||
        !item ||
        packageConfigurationHomeV1(item) !== "user-settings"
      ) {
        const receipt: OperationReceiptV1 = {
          schemaVersion: 1,
          commandId: command.commandId,
          revision: current.revision,
          status: "rejected",
          failure:
            "These settings are no longer available here. Refresh Settings to continue.",
        };
        await storage.put(receiptKey, { commandFingerprint, receipt });
        return receipt;
      }
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
    const applied = applyUserCommand(
      current,
      command,
      (current, id) => this.chooseModelProvider(current, id),
      (packageId, version) => this.settingDefinitions(packageId, version),
    );
    // One command, one revision: the cascade is part of the disable the User
    // asked for, not a second write they have to reconcile against.
    const next =
      command.type === "user/uninstall-package" ||
      (command.type === "user/set-package-enabled" && !command.enabled)
        ? this.cascadeDisabledDependents(applied)
        : applied;
    const receipt: OperationReceiptV1 = {
      schemaVersion: 1,
      commandId: command.commandId,
      revision: next.revision,
      status: "applied",
    };
    await storage.put({
      ...(await this.configurationRecords(next, storage)),
      [receiptKey]: { commandFingerprint, receipt },
    });
    return receipt;
  }

  /** Account choice has its own versioned User record; the previous settings DTO stays readable. */
  private async withAccountModel(
    value: UserSettingsViewV1,
    storage: UserSettingsTransaction,
  ): Promise<UserSettingsViewV1> {
    const stored = await storage.get<unknown>(ACCOUNT_MODEL_KEY);
    if (stored === undefined) return value; // A previous shape may supply the one-time migration value.
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).sort().join() !== "model,schemaVersion" ||
      !("schemaVersion" in stored) ||
      stored.schemaVersion !== 1 ||
      !("model" in stored)
    )
      throw new ConfigurationDecodeError("Stored account model is invalid");
    const { accountModel: _migrated, ...base } = value;
    return {
      ...base,
      ...(stored.model === null
        ? {}
        : { accountModel: decodeModelBindingV1(stored.model) }),
    };
  }

  private async configurationRecords(
    value: UserSettingsViewV1,
    storage: UserSettingsTransaction,
  ): Promise<Record<string, unknown>> {
    const { accountModel, ...settings } = value;
    const previous = await storage.get<unknown>(ACCOUNT_MODEL_KEY);
    // All callers are inside the User owner's transaction. Preserve one recovery
    // checkpoint before the migration; code revert never rewinds this data.
    const checkpoint =
      previous === undefined
        ? await storage.get<unknown>(STATE_KEY)
        : undefined;
    return {
      [STATE_KEY]: settings,
      [ACCOUNT_MODEL_KEY]: { schemaVersion: 1, model: accountModel ?? null },
      ...(checkpoint === undefined
        ? {}
        : {
            [ACCOUNT_MODEL_CHECKPOINT_KEY]: {
              schemaVersion: 1,
              settings: checkpoint,
            },
          }),
    };
  }

  async readSnapshot(
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<UserSettingsViewV1> {
    const stored = await storage.get<unknown>(STATE_KEY);
    return this.withAccountModel(
      stored === undefined
        ? initialState()
        : decodeUserSettingsViewV1(migrateStoredUserSettingsV1(stored)),
      storage,
    );
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
      await transaction.put(await this.configurationRecords(next, transaction));
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
      await transaction.put(await this.configurationRecords(next, transaction));
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

/**
 * What an application hands this Contribution: User settings, Package installation, and Connection commands, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface SettingsUserApplicationHostV1 {
  settings: UserSettingsBackendHost;
}

/**
 * The manifest's `user` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const userContribution = defineUserBackendContribution<
  SettingsUserApplicationHostV1,
  UserSettingsBackendContribution
>({
  specifier: "@frockbot/plugin-settings/user",
  create: (host, lifecycle) =>
    createUserSettingsBackendPlugin(host.settings, lifecycle),
});
