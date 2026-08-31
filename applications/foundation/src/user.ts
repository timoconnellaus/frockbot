import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  createCredentialUserBackendPlugin,
  type CredentialStorage,
  type CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import {
  createFlockUserBackendPlugin,
  type FlockUserBackendContribution,
} from "@frockbot/plugin-flock/user";
import {
  createPackagePublisherUserPlugin,
  type PackagePublisherUserContribution,
  type PackagePublisherUserHost,
} from "@frockbot/plugin-package-publisher/user";
export type { PackagePublisherUserHost } from "@frockbot/plugin-package-publisher/user";
import {
  createOllamaCloudUserBackendPlugin,
  type OllamaCloudUserBackendContribution,
} from "@frockbot/plugin-provider-ollama-cloud/user";
import {
  createUserSettingsBackendPlugin,
  type UserSettingsBackendContribution,
  type UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  type BackendContributionLifecycle,
  createFoundationBackendContributions,
} from "./runtime.js";

export interface FoundationConnectionUserBackendContribution {
  readonly packageId: string;
  executeConnection(accountId: string, input: unknown): Promise<unknown>;
  lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<unknown>;
  leaseModelCredential(input: {
    accountId: string;
    connectionId: string;
    providerModelId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<unknown>;
  settleModelCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void>;
  alarm?(): Promise<void>;
}

export interface MountedFoundationUserBackend {
  settings: UserSettingsBackendContribution;
  credentials: CredentialUserBackendContribution;
  connections: ReadonlyMap<string, FoundationConnectionUserBackendContribution>;
  flock: FlockUserBackendContribution;
  publisher: PackagePublisherUserContribution;
  dispose(): Promise<void>;
}

export async function createFoundationUserBackendContributions(
  plan: ApplicationPlan,
  host: {
    storage: UserSettingsStorage &
      CredentialStorage & {
        getAlarm?(): Promise<number | null>;
        setAlarm(scheduledTime: number | Date): Promise<void>;
      };
    readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
    /**
     * The publication seam: the User Durable Object's own object storage and
     * Worker Loader, which the adapter owns and this application never names.
     */
    packagePublisher: PackagePublisherUserHost;
  },
): Promise<MountedFoundationUserBackend> {
  let settings: UserSettingsBackendContribution | undefined;
  let credentials: CredentialUserBackendContribution | undefined;
  let ollama: OllamaCloudUserBackendContribution | undefined;
  let flock: FlockUserBackendContribution | undefined;
  let publisher: PackagePublisherUserContribution | undefined;
  const connections = new Map<
    string,
    FoundationConnectionUserBackendContribution
  >();
  const factories = new Map<
    string,
    (
      lifecycle: BackendContributionLifecycle<
        | UserSettingsBackendContribution
        | CredentialUserBackendContribution
        | OllamaCloudUserBackendContribution
        | FlockUserBackendContribution
        | PackagePublisherUserContribution
      >,
    ) => Plugin
  >([
    [
      "@frockbot/plugin-settings/user",
      (lifecycle) =>
        createUserSettingsBackendPlugin(
          {
            storage: host.storage,
            availablePackages: plan.packages.map((pkg) => ({
              packageId: pkg.id,
              version: pkg.version,
            })),
          },
          {
            mount(value: UserSettingsBackendContribution) {
              settings = value;
              return lifecycle.mount(value);
            },
          },
        ),
    ],
    [
      "@frockbot/plugin-credentials/user",
      (lifecycle) => {
        const keyring = host.readSecret("CREDENTIAL_KEYRING");
        if (!keyring) {
          throw new Error("Credential Store Contribution is not configured");
        }
        return createCredentialUserBackendPlugin(
          { storage: host.storage, keyring },
          {
            mount(value: CredentialUserBackendContribution) {
              credentials = value;
              return lifecycle.mount(value);
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-provider-ollama-cloud/user",
      (lifecycle) => {
        if (!settings || !credentials) {
          throw new Error(
            "Ollama Cloud requires Settings and Credential Contributions",
          );
        }
        const userSettings = settings;
        return createOllamaCloudUserBackendPlugin(
          { storage: host.storage, settings, credentials },
          {
            mount(value: OllamaCloudUserBackendContribution) {
              ollama = value;
              connections.set(value.packageId, value);
              const unregister =
                userSettings.registerConnectionCommandOwner(value);
              const dispose = lifecycle.mount(value);
              return () => {
                connections.delete(value.packageId);
                unregister();
                dispose();
              };
            },
          },
        );
      },
    ],
    [
      "@frockbot/plugin-package-publisher/user",
      (lifecycle) =>
        createPackagePublisherUserPlugin(host.packagePublisher, {
          mount(value: PackagePublisherUserContribution) {
            publisher = value;
            return lifecycle.mount(value);
          },
        }),
    ],
    [
      "@frockbot/plugin-flock/user",
      (lifecycle) =>
        createFlockUserBackendPlugin(
          {
            storage: host.storage,
            readUserSettings: (storage) => {
              if (!settings) {
                throw new Error("User settings Contribution is unavailable");
              }
              return settings.readSnapshot(storage);
            },
            claimInitialModelBinding: async (storage, input) => {
              if (!settings) {
                throw new Error("User settings Contribution is unavailable");
              }
              const user = await settings.readSnapshot(storage);
              const connection = user.connections.find(
                (candidate) =>
                  candidate.connectionId === input.model.connectionId,
              );
              const installation = user.packages.find(
                (candidate) =>
                  candidate.packageId === connection?.packageId &&
                  candidate.state === "installed",
              );
              const pkg = plan.packages.find(
                (candidate) =>
                  candidate.id === connection?.packageId &&
                  candidate.version === installation?.version,
              );
              const connectionType =
                pkg?.manifest.configuration?.connectionTypes.find(
                  (candidate) => candidate.id === connection?.connectionTypeId,
                );
              const capability = pkg?.manifest.configuration?.capabilities.find(
                (candidate) =>
                  candidate.kind === "model" &&
                  connectionType?.capabilities.includes(candidate.id) &&
                  candidate.connectionTypes.includes(connectionType.id),
              );
              if (
                connection?.state !== "ready" ||
                !installation ||
                !pkg ||
                !connectionType ||
                !capability
              ) {
                return undefined;
              }
              const claimed = await settings.claimConnectionDependency(
                input.userId,
                connection.connectionId,
                input.botId,
                input.generation,
                {
                  schemaVersion: 1,
                  packageId: pkg.id,
                  packageVersion: pkg.version,
                  capabilityId: capability.id,
                  connectionTypeIds: [...capability.connectionTypes],
                },
                storage,
              );
              return claimed
                ? {
                    assignmentId: input.generation,
                    packageId: pkg.id,
                    capabilityId: capability.id,
                    connectionId: connection.connectionId,
                    state: "enabled" as const,
                  }
                : undefined;
            },
          },
          {
            mount(value: FlockUserBackendContribution) {
              flock = value;
              return lifecycle.mount(value);
            },
          },
        ),
    ],
  ]);
  const mounted = await createFoundationBackendContributions<
    | UserSettingsBackendContribution
    | CredentialUserBackendContribution
    | OllamaCloudUserBackendContribution
    | FlockUserBackendContribution
    | PackagePublisherUserContribution
  >(plan, {
    backendHost: "user",
    resolve: (specifier, lifecycle) => {
      const factory = factories.get(specifier);
      if (!factory) {
        throw new Error(`Unsupported User Contribution: ${specifier}`);
      }
      return factory(lifecycle);
    },
  });
  if (!settings || !credentials || !ollama || !flock || !publisher) {
    await mounted.dispose();
    throw new Error(
      "Foundation requires Settings, Credentials, Ollama, Flock, and Package Publisher User Contributions",
    );
  }
  return {
    settings,
    credentials,
    connections,
    flock,
    publisher,
    dispose: mounted.dispose,
  };
}
