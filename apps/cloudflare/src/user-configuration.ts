import { DurableObject } from "cloudflare:workers";
import {
  createFoundationUserBackendContributions,
  type FoundationConnectionUserBackendContribution,
  type MountedFoundationUserBackend,
} from "@frockbot/application-foundation/user";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import {
  decodeConnectionCommandIdV1,
  decodeConnectionCommandV1,
} from "@frockbot/connection-core";
import {
  decodeConnectionDependencyRequirementV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  type ConnectionDependencyRequirementV1,
} from "@frockbot/configuration-core";
import { decodeCreateBotCommandV1 } from "@frockbot/plugin-flock/shared";
import {
  AUTHORING_QUOTA_CONFIG_KEY,
  AUTHORING_QUOTA_DAY,
  decodeAuthoringQuotaConfigV1,
  reserveAuthoringQuotaV1,
  type AuthoringQuotaConfigV1,
  type AuthoringQuotaReceiptV1,
} from "@frockbot/plugin-authoring/quota";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcPattern,
  rpcString,
} from "./durable-rpc.js";

interface UserConfigurationEnv {
  CREDENTIAL_KEYRING?: string;
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<MountedFoundationUserBackend> | undefined;

  private contributions(): Promise<MountedFoundationUserBackend> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) =>
        createFoundationUserBackendContributions(plan, {
          storage: this.ctx.storage,
          readSecret: () => this.env.CREDENTIAL_KEYRING,
        }),
      );
    }
    return this.mounted;
  }

  private async settingsContribution(): Promise<
    MountedFoundationUserBackend["settings"]
  > {
    return (await this.contributions()).settings;
  }

  private async connectionContribution(
    packageId: string,
  ): Promise<FoundationConnectionUserBackendContribution> {
    const contribution = (await this.contributions()).connections.get(
      packageId,
    );
    if (!contribution) {
      throw new Error(`Connection Package "${packageId}" is unavailable`);
    }
    return contribution;
  }

  private async flockContribution(): Promise<
    MountedFoundationUserBackend["flock"]
  > {
    return (await this.contributions()).flock;
  }

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    return (await this.settingsContribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    return (await this.settingsContribution()).executeConfiguration(request);
  }

  async executeConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeConnectionCommandV1),
    });
    const command = request.command as ReturnType<
      typeof decodeConnectionCommandV1
    >;
    const accountId = request.userId as string;
    const packageId = await (
      await this.settingsContribution()
    ).resolveConnectionCommandOwner(accountId, command);
    return (await this.connectionContribution(packageId)).executeConnection(
      accountId,
      command,
    );
  }

  async lookupConnectionCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    return (
      await this.connectionContribution(request.packageId as string)
    ).lookupConnectionCommand(
      request.userId as string,
      decodeConnectionCommandIdV1(request.commandId),
    );
  }

  async getConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    return (await this.settingsContribution()).getConnection(
      request.userId as string,
      request.connectionId as string,
    );
  }

  async leaseModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      providerModelId: rpcString(256),
      effectId: rpcIdentifier,
      connectionGeneration: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) throw new Error("Connection is unavailable");
    return (
      await this.connectionContribution(connection.packageId)
    ).leaseModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      providerModelId: request.providerModelId as string,
      effectId: request.effectId as string,
      connectionGeneration: request.connectionGeneration as string,
    });
  }

  async claimConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
      requirement: rpcDecoded(decodeConnectionDependencyRequirementV1),
    });
    return (await this.settingsContribution()).claimConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
      request.requirement as ConnectionDependencyRequirementV1,
    );
  }

  async acknowledgeConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).acknowledgeConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async releaseConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).releaseConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async compensateConnectionDependency(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      botId: rpcBotId,
      generation: rpcIdentifier,
    });
    return (await this.settingsContribution()).compensateConnectionDependency(
      request.userId as string,
      request.connectionId as string,
      request.botId as string,
      request.generation as string,
    );
  }

  async settleModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      packageId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    await (await this.settingsContribution()).read(request.userId as string);
    const contribution = (await this.contributions()).connections.get(
      request.packageId as string,
    );
    if (!contribution) {
      throw new Error("Connection Package Contribution is unavailable");
    }
    await contribution.settleModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
    });
  }

  /**
   * D7. The User Durable Object is the authority for User-scoped quotas: the
   * Bot's Durable Object reserves one authored-generation unit here before it
   * records an authorship intent. Reservation is idempotent on `effectId`, so
   * a resumed Turn does not consume a second unit, and a breach is a refusal
   * receipt rather than a throw — the Bot records the visible failure.
   */
  async reserveAuthoringQuota(
    input: unknown,
  ): Promise<AuthoringQuotaReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      effectId: rpcString(200),
      day: rpcPattern(AUTHORING_QUOTA_DAY, 10),
      sourceBytes: rpcInteger({ minimum: 0, maximum: 64 * 1024 * 1024 }),
      retainedGenerations: rpcInteger({ minimum: 0, maximum: 1_000_000 }),
    });
    return reserveAuthoringQuotaV1(this.ctx.storage, {
      schemaVersion: 1,
      userId: request.userId as string,
      botId: request.botId as string,
      effectId: request.effectId as string,
      day: request.day as string,
      sourceBytes: request.sourceBytes as number,
      retainedGenerations: request.retainedGenerations as number,
    });
  }

  /** The durable per-User authoring quota configuration; defaults when unset. */
  async readAuthoringQuota(input: unknown): Promise<AuthoringQuotaConfigV1> {
    decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    return decodeAuthoringQuotaConfigV1(
      await this.ctx.storage.get<unknown>(AUTHORING_QUOTA_CONFIG_KEY),
    );
  }

  async configureAuthoringQuota(
    input: unknown,
  ): Promise<AuthoringQuotaConfigV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      quota: rpcDecoded(decodeAuthoringQuotaConfigV1),
    });
    const quota = request.quota as AuthoringQuotaConfigV1;
    await this.ctx.storage.put(AUTHORING_QUOTA_CONFIG_KEY, quota);
    return quota;
  }

  async alarm() {
    const contributions = await this.contributions();
    await contributions.credentials.expireLeases();
    for (const contribution of contributions.connections.values()) {
      await contribution.alarm?.();
    }
  }

  async listBots(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).listBots();
  }

  async createBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeCreateBotCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).createBot(
      request.userId as string,
      request.command as ReturnType<typeof decodeCreateBotCommandV1>,
    );
  }

  async getBotRegistration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).registration(
      request.botId as string,
    );
  }

  async hasBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    return {
      schemaVersion: 1,
      botId,
      registered: await (await this.flockContribution()).hasBot(botId),
    } as const;
  }

  async isPackageInstalled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
    });
    return (await this.settingsContribution()).isPackageInstalled(
      request.userId as string,
      request.packageId as string,
    );
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }
}
