import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import { reconcileComposioProviderConnection } from "@frockbot/plugin-composio";
import { ComposioClient } from "@frockbot/plugin-composio/client";
import type {
  ComposioUserBackendContribution,
  StartConnectionInput,
  UserConfigurationEnv,
} from "@frockbot/plugin-composio/user-configuration";
import { createComposioUserBackendContribution } from "@frockbot/plugin-composio/user-configuration";

export type { StartConnectionInput };

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<ComposioUserBackendContribution> | undefined;

  private contribution(): Promise<ComposioUserBackendContribution> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) => {
        const contributions = createFoundationBackendContributions(plan, {
          backendHost: "user",
          mount: (specifier) => {
            if (specifier !== "@frockbot/plugin-composio/user-configuration") {
              throw new Error(`Unsupported User Contribution: ${specifier}`);
            }
            const client = () => {
              const apiKey = this.env.COMPOSIO_API_KEY;
              if (!apiKey) {
                throw new Error("Composio API key is not configured");
              }
              return new ComposioClient({ apiKey });
            };
            return createComposioUserBackendContribution({
              state: this.ctx,
              env: this.env,
              reconcileProviderConnection: (request) =>
                reconcileComposioProviderConnection(client(), request),
              revokeConnectedAccount: (connectedAccountId) =>
                client().revokeConnectedAccount(connectedAccountId),
              availablePackages: plan.packages.map((pkg) => ({
                packageId: pkg.id,
                version: pkg.version,
              })),
            });
          },
        });
        if (contributions.length !== 1) {
          throw new Error("Foundation requires one User backend Contribution");
        }
        return contributions[0]!;
      });
    }
    return this.mounted;
  }

  async readConfiguration(input: unknown) {
    return (await this.contribution()).readConfiguration(input);
  }

  async executeConfiguration(input: unknown) {
    return (await this.contribution()).executeConfiguration(input);
  }

  async isPackageInstalled(
    ...args: Parameters<ComposioUserBackendContribution["isPackageInstalled"]>
  ) {
    return (await this.contribution()).isPackageInstalled(...args);
  }

  async getConnection(
    ...args: Parameters<ComposioUserBackendContribution["getConnection"]>
  ) {
    return (await this.contribution()).getConnection(...args);
  }

  async startConnection(
    ...args: Parameters<ComposioUserBackendContribution["startConnection"]>
  ) {
    return (await this.contribution()).startConnection(...args);
  }

  async recordConnectLinkResult(
    ...args: Parameters<
      ComposioUserBackendContribution["recordConnectLinkResult"]
    >
  ) {
    return (await this.contribution()).recordConnectLinkResult(...args);
  }

  async recordLinkReconciliationIdentity(
    ...args: Parameters<
      ComposioUserBackendContribution["recordLinkReconciliationIdentity"]
    >
  ) {
    return (await this.contribution()).recordLinkReconciliationIdentity(
      ...args,
    );
  }

  async claimLostLinkCleanup(
    ...args: Parameters<ComposioUserBackendContribution["claimLostLinkCleanup"]>
  ) {
    return (await this.contribution()).claimLostLinkCleanup(...args);
  }

  async finishConnectionAuthorization(
    ...args: Parameters<
      ComposioUserBackendContribution["finishConnectionAuthorization"]
    >
  ) {
    return (await this.contribution()).finishConnectionAuthorization(...args);
  }

  async consumeAuthorizationState(
    ...args: Parameters<
      ComposioUserBackendContribution["consumeAuthorizationState"]
    >
  ) {
    return (await this.contribution()).consumeAuthorizationState(...args);
  }

  async admitConnectionCallback(
    ...args: Parameters<
      ComposioUserBackendContribution["admitConnectionCallback"]
    >
  ) {
    return (await this.contribution()).admitConnectionCallback(...args);
  }

  async claimConnectionAssignment(
    ...args: Parameters<
      ComposioUserBackendContribution["claimConnectionAssignment"]
    >
  ) {
    return (await this.contribution()).claimConnectionAssignment(...args);
  }

  async finishConnectionAssignment(
    ...args: Parameters<
      ComposioUserBackendContribution["finishConnectionAssignment"]
    >
  ) {
    return (await this.contribution()).finishConnectionAssignment(...args);
  }

  async requireAssignmentCompensation(
    ...args: Parameters<
      ComposioUserBackendContribution["requireAssignmentCompensation"]
    >
  ) {
    return (await this.contribution()).requireAssignmentCompensation(...args);
  }

  async recordAssignmentCompensated(
    ...args: Parameters<
      ComposioUserBackendContribution["recordAssignmentCompensated"]
    >
  ) {
    return (await this.contribution()).recordAssignmentCompensated(...args);
  }

  async claimConnectionDependency(
    ...args: Parameters<
      ComposioUserBackendContribution["claimConnectionDependency"]
    >
  ) {
    return (await this.contribution()).claimConnectionDependency(...args);
  }

  async acknowledgeConnectionDependency(
    ...args: Parameters<
      ComposioUserBackendContribution["acknowledgeConnectionDependency"]
    >
  ) {
    return (await this.contribution()).acknowledgeConnectionDependency(...args);
  }

  async compensateConnectionDependency(
    ...args: Parameters<
      ComposioUserBackendContribution["compensateConnectionDependency"]
    >
  ) {
    return (await this.contribution()).compensateConnectionDependency(...args);
  }

  async recordConnectionDependency(
    ...args: Parameters<
      ComposioUserBackendContribution["recordConnectionDependency"]
    >
  ) {
    return (await this.contribution()).recordConnectionDependency(...args);
  }

  async requireConnectionReconciliation(
    ...args: Parameters<
      ComposioUserBackendContribution["requireConnectionReconciliation"]
    >
  ) {
    return (await this.contribution()).requireConnectionReconciliation(...args);
  }

  async claimConnectionRevocation(
    ...args: Parameters<
      ComposioUserBackendContribution["claimConnectionRevocation"]
    >
  ) {
    return (await this.contribution()).claimConnectionRevocation(...args);
  }

  async recordRevocationProviderCompleted(
    ...args: Parameters<
      ComposioUserBackendContribution["recordRevocationProviderCompleted"]
    >
  ) {
    return (await this.contribution()).recordRevocationProviderCompleted(
      ...args,
    );
  }

  async finishConnectionRevocation(
    ...args: Parameters<
      ComposioUserBackendContribution["finishConnectionRevocation"]
    >
  ) {
    return (await this.contribution()).finishConnectionRevocation(...args);
  }

  async alarm(): Promise<void> {
    await (await this.contribution()).alarm();
  }
}
