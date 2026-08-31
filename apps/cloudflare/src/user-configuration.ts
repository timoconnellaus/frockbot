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
import {
  decodeConnectionDependencyCommandV1,
  type ConnectionDependencyResultV1,
} from "@frockbot/connection-core";
import {
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeCreateBotCommandV1,
} from "@frockbot/plugin-flock/shared";
import {
  AUTHORING_QUOTA_CONFIG_KEY,
  AUTHORING_QUOTA_DAY,
  decodeAuthoringQuotaConfigV1,
  reserveAuthoringQuotaV1,
  type AuthoringQuotaConfigV1,
  type AuthoringQuotaReceiptV1,
} from "@frockbot/plugin-authoring/quota";
import { DurableWorkspaceGenerations } from "@frockbot/kernel-do";
import {
  decodeWorkspaceGenerationRecordV1,
  decodeWorkspaceRootV1,
  isWorkspaceSharedMemoryRootV1,
  normalizeWorkspaceRelativePathV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import type { MemoryProjectV1 } from "@frockbot/plugin-memory/agent";
import {
  decodePublishPackageCommandV1,
  decodeRollbackPackageCommandV1,
} from "@frockbot/plugin-package-publisher/shared";
import type { WorkerLoader } from "./contracts.js";
import { createPackagePublicationHost } from "./package-publication.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcPattern,
  rpcString,
  rpcEnum,
  rpcDecodedValue,
} from "./durable-rpc.js";

/** The durable key holding this User's Project catalogue. */
const MEMORY_PROJECTS_KEY = "memory:projects";
/** Most Projects one User may have, and most one Bot may belong to. */
const MEMORY_MAX_PROJECTS = 200;
const MEMORY_MAX_JOINED_PROJECTS = 32;
const MEMORY_PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** The durable key pinning the User this object was provisioned for. */
const USER_IDENTITY_KEY = "user:identity";

interface UserConfigurationEnv {
  CREDENTIAL_KEYRING?: string;
  /** Bot authority: archive and restore are carried to the Bot Durable Object. */
  BOT_STATES: DurableObjectNamespace;
  /**
   * This object's own namespace. Every caller reaches a User Durable Object
   * through `idFromName(userId)`, so the namespace is how the object checks
   * that the `userId` an RPC carries is the one it *is*.
   */
  USER_CONFIGURATIONS: DurableObjectNamespace;
  /** Immutable published application source and artifact bytes. */
  APPLICATION_ARTIFACTS: R2Bucket;
  /** The loader that health-checks a candidate artifact before activation. */
  USER_APPLICATIONS: WorkerLoader;
}

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<MountedFoundationUserBackend> | undefined;

  private contributions(): Promise<MountedFoundationUserBackend> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) =>
        createFoundationUserBackendContributions(plan, {
          storage: this.ctx.storage,
          readSecret: () => this.env.CREDENTIAL_KEYRING,
          packagePublisher: createPackagePublicationHost(
            this.env,
            this.ctx.storage,
          ),
          commandBotLifecycle: async (userId, command) => {
            const id = this.env.BOT_STATES.idFromName(
              `${userId}:${command.botId}`,
            );
            // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
            const rpc = this.env.BOT_STATES.get(id) as unknown as {
              executeLifecycle(input: unknown): Promise<unknown>;
            };
            return decodeBotLifecycleReceiptV1(
              await rpc.executeLifecycle({
                schemaVersion: 1,
                userId,
                botId: command.botId,
                command,
              }),
            );
          },
          readBotLifecycle: async (userId, botId) => {
            const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
            // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
            const rpc = this.env.BOT_STATES.get(id) as unknown as {
              readLifecycle(input: unknown): Promise<unknown>;
            };
            return decodeBotLifecycleViewV1(
              await rpc.readLifecycle({ schemaVersion: 1, userId, botId }),
            );
          },
        }),
      );
    }
    return this.mounted;
  }

  /**
   * The User this Durable Object is.
   *
   * Comparing an RPC's `userId` with a root's `userId` proves only that the
   * request agrees with itself; both come from the caller. A User Durable
   * Object is addressed by `idFromName(userId)`, so its identity is the name
   * it was constructed for: the id derived from the claimed `userId` must be
   * this object's own id. That identity is also pinned in durable storage the
   * first time it is asserted — provisioning is the first RPC a new User
   * object ever receives — so the check survives eviction.
   *
   * A missing namespace binding is a refusal, not a fallback. Without it the
   * only remaining check is the pin, and the pin trusts whoever called first:
   * an object that has never been addressed would take its identity from the
   * caller and then defend it for ever. The binding is present in production
   * and every test binds it, so its absence is a broken deployment rather than
   * a state to serve requests in.
   */
  private identity: string | undefined;

  private async assertUserIdentity(userId: string): Promise<string> {
    if (this.identity === userId) return userId;
    const namespace = this.env.USER_CONFIGURATIONS;
    if (!namespace) {
      throw new Error(
        "the User Durable Object namespace is unbound, so this object cannot prove which User it is",
      );
    }
    if (!namespace.idFromName(userId).equals(this.ctx.id)) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    const pinned = await this.ctx.storage.get<string>(USER_IDENTITY_KEY);
    if (pinned !== undefined && pinned !== userId) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    if (pinned === undefined) {
      await this.ctx.storage.put(USER_IDENTITY_KEY, userId);
    }
    this.identity = userId;
    return userId;
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

  private async publisherContribution(): Promise<
    MountedFoundationUserBackend["publisher"]
  > {
    return (await this.contributions()).publisher;
  }

  async readConfiguration(input: unknown) {
    const request = decodeUserConfigurationReadRpcV1(input);
    await this.assertUserIdentity(request.userId);
    return (await this.settingsContribution()).readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    await this.assertUserIdentity(request.userId);
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

  /**
   * The provider-neutral Connection dependency protocol (ADR 0003): claim,
   * read, acknowledge, release, and reconcile against the durable dependency
   * records the User's Settings Contribution owns. One exact command, one
   * durable shape; the Bot's Assignment saga speaks only this.
   */
  async executeConnectionDependency(
    input: unknown,
  ): Promise<ConnectionDependencyResultV1> {
    const command = decodeConnectionDependencyCommandV1(input);
    await this.assertUserIdentity(command.userId);
    const settings = await this.settingsContribution();
    const connection = await settings.getConnection(
      command.userId,
      command.connectionId,
    );
    if (connection && connection.packageId !== command.packageId) {
      return {
        schemaVersion: 1,
        status: "rejected",
        failure: `Connection "${command.connectionId}" does not belong to Package "${command.packageId}"`,
      };
    }
    const settled = () =>
      settings.readConnectionDependency(
        command.userId,
        command.connectionId,
        command.botId,
        command.generation,
      );
    switch (command.action) {
      case "claim": {
        if (!connection || connection.state !== "ready") {
          return {
            schemaVersion: 1,
            status: "unavailable",
            failure: `Connection "${command.connectionId}" is unavailable`,
          };
        }
        return (await settings.claimConnectionDependency(
          command.userId,
          command.connectionId,
          command.botId,
          command.generation,
          command.requirement,
        ))
          ? { schemaVersion: 1, status: "claimed" }
          : {
              schemaVersion: 1,
              status: "unavailable",
              failure: `Connection "${command.connectionId}" cannot serve this Capability`,
            };
      }
      case "acknowledge":
        return (await settings.acknowledgeConnectionDependency(
          command.userId,
          command.connectionId,
          command.botId,
          command.generation,
        ))
          ? { schemaVersion: 1, status: "acknowledged" }
          : {
              schemaVersion: 1,
              status: "unavailable",
              failure: `Connection "${command.connectionId}" cannot acknowledge this dependency`,
            };
      case "release":
        return (await settings.releaseConnectionDependency(
          command.userId,
          command.connectionId,
          command.botId,
          command.generation,
        ))
          ? { schemaVersion: 1, status: "released" }
          : { schemaVersion: 1, status: "pending" };
      case "reconcile": {
        await settings.compensateConnectionDependency(
          command.userId,
          command.connectionId,
          command.botId,
          command.generation,
        );
        const state = await settled();
        if (state === "acknowledged") {
          return { schemaVersion: 1, status: "acknowledged" };
        }
        return state === "pending"
          ? { schemaVersion: 1, status: "pending" }
          : { schemaVersion: 1, status: "released" };
      }
      case "read": {
        const state = await settled();
        if (state === "acknowledged") {
          return { schemaVersion: 1, status: "acknowledged" };
        }
        // A durable dependency that is recorded but not yet acknowledged is
        // *claimed*, which is what the Bot's Assignment saga acknowledges
        // next. Reporting it as `pending` would tell the saga the User
        // authority cannot answer yet, and it would compensate a claim it is
        // entitled to keep.
        return state === "pending"
          ? { schemaVersion: 1, status: "claimed" }
          : { schemaVersion: 1, status: "absent" };
      }
    }
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

  // ---------------------------------------------------------------------
  // Shared Memory roots.
  //
  // "The User's Durable Object is the authority for everything User-scoped:
  // ... and the generation records of User and Project Memory roots." The
  // Bot's Durable Object does the writing — it is the Memory Package's host —
  // but a shared root's generations are recorded here, so two Bots writing one
  // root record into one ledger and their ids order against each other.
  //
  // Every one of these refuses a root that is not a shared Memory root of
  // *this* User. The Bot object is a caller like any other; authority follows
  // the root, not the caller.
  // ---------------------------------------------------------------------

  private readonly workspaceGenerations = new DurableWorkspaceGenerations({
    state: this.ctx,
  });

  /** `userId` must already have passed `assertUserIdentity`. */
  private sharedMemoryRoot(userId: string, value: unknown): WorkspaceRootV1 {
    const root = decodeWorkspaceRootV1(value);
    if (!isWorkspaceSharedMemoryRootV1(root) || root.userId !== userId) {
      throw new Error(
        "the User Durable Object records generations for its own shared Memory roots only",
      );
    }
    return root;
  }

  private sharedMemoryRecord(
    userId: string,
    value: unknown,
  ): WorkspaceGenerationRecordV1 {
    const entry = decodeWorkspaceGenerationRecordV1(value);
    this.sharedMemoryRoot(userId, entry.root);
    return entry;
  }

  async mintWorkspaceGeneration(input: unknown): Promise<string> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      at: rpcString(64),
      root: rpcDecodedValue,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    this.sharedMemoryRoot(userId, request.root);
    const at = new Date(request.at as string);
    if (!Number.isFinite(at.getTime())) {
      throw new Error("RPC request.at is invalid");
    }
    return this.workspaceGenerations.mint(at);
  }

  async currentWorkspaceGeneration(
    input: unknown,
  ): Promise<WorkspaceGenerationRecordV1 | undefined> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      root: rpcDecodedValue,
      path: rpcString(1_024),
    });
    const root = this.sharedMemoryRoot(
      await this.assertUserIdentity(request.userId as string),
      request.root,
    );
    return this.workspaceGenerations.current(
      root,
      normalizeWorkspaceRelativePathV1(request.path),
    );
  }

  async recordWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.record(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async tombstoneWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.tombstone(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async conflictWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.conflict(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async listWorkspaceConflicts(
    input: unknown,
  ): Promise<WorkspaceGenerationRecordV1[]> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      root: rpcDecodedValue,
      path: rpcString(1_024),
    });
    const root = this.sharedMemoryRoot(
      await this.assertUserIdentity(request.userId as string),
      request.root,
    );
    return this.workspaceGenerations.conflicts(
      root,
      normalizeWorkspaceRelativePathV1(request.path),
    );
  }

  // ---------------------------------------------------------------------
  // Project membership.
  //
  // "A Project is an opt-in grouping a Bot creates or joins that carries its
  // own shared Memory tier; only the Projects a Bot has joined are injected
  // into its prompts." Membership is User-scoped durable state, so it lives
  // here: the catalogue of Projects the User has, and the joined list per Bot.
  // ---------------------------------------------------------------------

  private async projectCatalogue(): Promise<Record<string, MemoryProjectV1>> {
    const stored = await this.ctx.storage.get<unknown>(MEMORY_PROJECTS_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return {};
    }
    const catalogue: Record<string, MemoryProjectV1> = {};
    for (const [projectId, value] of Object.entries(
      stored as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.name !== "string") continue;
      catalogue[projectId] = {
        projectId,
        name: record.name.slice(0, 128),
        description:
          typeof record.description === "string"
            ? record.description.slice(0, 512)
            : "",
      };
    }
    return catalogue;
  }

  private async joinedProjects(botId: string): Promise<string[]> {
    const stored = await this.ctx.storage.get<unknown>(
      `${MEMORY_PROJECTS_KEY}:${botId}`,
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((value): value is string => typeof value === "string")
      .slice(0, MEMORY_MAX_JOINED_PROJECTS);
  }

  private async membership(botId: string): Promise<MemoryProjectV1[]> {
    const catalogue = await this.projectCatalogue();
    return (await this.joinedProjects(botId)).flatMap((projectId) => {
      const project = catalogue[projectId];
      return project ? [project] : [];
    });
  }

  async listMemoryProjects(input: unknown): Promise<MemoryProjectV1[]> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return this.membership(request.botId as string);
  }

  /**
   * Create, join, or leave. Create is join when the slug already exists, which
   * is GrokBot's own `update_state project create` behaviour, and the refusal
   * for an unknown slug on `join` is a value rather than a throw so the Bot's
   * tool can report it.
   */
  async changeMemoryProjects(
    input: unknown,
  ): Promise<
    | { status: "ok"; joined: MemoryProjectV1[] }
    | { status: "refused"; reason: string }
  > {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        action: rpcEnum(["create", "join", "leave"]),
        projectId: rpcPattern(MEMORY_PROJECT_ID, 128),
      },
      { project: rpcDecodedValue },
    );
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    const botId = request.botId as string;
    const projectId = request.projectId as string;
    const action = request.action as "create" | "join" | "leave";
    const catalogue = await this.projectCatalogue();
    const joined = new Set(await this.joinedProjects(botId));

    if (action === "create") {
      if (!catalogue[projectId]) {
        if (Object.keys(catalogue).length >= MEMORY_MAX_PROJECTS) {
          return {
            status: "refused",
            reason: `this User already has ${MEMORY_MAX_PROJECTS} Projects`,
          };
        }
        const supplied = request.project as Record<string, unknown> | undefined;
        catalogue[projectId] = {
          projectId,
          name:
            typeof supplied?.name === "string" && supplied.name.trim()
              ? supplied.name.trim().slice(0, 128)
              : projectId,
          description:
            typeof supplied?.description === "string"
              ? supplied.description.trim().slice(0, 512)
              : "",
        };
        await this.ctx.storage.put(MEMORY_PROJECTS_KEY, catalogue);
      }
      joined.add(projectId);
    } else if (action === "join") {
      if (!catalogue[projectId]) {
        return {
          status: "refused",
          reason: `no Project "${projectId}" exists; create it first`,
        };
      }
      joined.add(projectId);
    } else {
      joined.delete(projectId);
    }
    if (joined.size > MEMORY_MAX_JOINED_PROJECTS) {
      return {
        status: "refused",
        reason: `a Bot may belong to at most ${MEMORY_MAX_JOINED_PROJECTS} Projects`,
      };
    }
    await this.ctx.storage.put(
      `${MEMORY_PROJECTS_KEY}:${botId}`,
      [...joined].sort(),
    );
    return { status: "ok", joined: await this.membership(botId) };
  }

  /**
   * One durable alarm serves every User-scoped owner of one. Cloudflare gives
   * a Durable Object a single alarm, so credential lease expiry, Connection
   * recovery, and publication recovery all run on every firing rather than
   * one of them silently displacing the others' schedule.
   */
  async alarm() {
    const contributions = await this.contributions();
    await contributions.credentials.expireLeases();
    for (const contribution of contributions.connections.values()) {
      await contribution.alarm?.();
    }
    await contributions.publisher.recover();
    // The Bot lifecycle sagas (archive and restore) resume on the same firing.
    await contributions.flock.alarm();
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

  async listBotLifecycles(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).listBotLifecycles();
  }

  async executeBotLifecycle(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeBotLifecycleCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).executeLifecycle(
      request.userId as string,
      request.command,
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

  async readPackageRevisions(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).read();
  }

  async publishPackage(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodePublishPackageCommandV1),
    });
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    return (await this.publisherContribution()).publish(
      userId,
      request.command as ReturnType<typeof decodePublishPackageCommandV1>,
    );
  }

  async rollbackPackage(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeRollbackPackageCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).rollback(
      request.command as ReturnType<typeof decodeRollbackPackageCommandV1>,
    );
  }

  async activeApplicationHash(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.publisherContribution()).activeApplicationHash();
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await this.assertUserIdentity(userId);
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }
}
