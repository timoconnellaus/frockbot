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
  decodeBotSettingsViewV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
} from "@frockbot/configuration-core";
import {
  MAX_TEMPLATE_BYTES_V1,
  parseTemplateShareIdV1,
} from "@frockbot/template-core";
import { parseCatalogIndexDocumentV1 } from "@frockbot/catalog-core";
import {
  decodeRoutineCommandReceiptV1,
  decodeRoutineListViewV1,
} from "@frockbot/plugin-routines/shared";
import {
  decodeTemplateCommandV1,
  type TemplateCommandV1,
} from "@frockbot/plugin-bot-template/shared";
import type {
  TemplateBlobStoreV1,
  TemplateBotReaderV1,
  TemplateImportWriterV1,
} from "@frockbot/plugin-bot-template/user";
import {
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeCreateBotCommandV1,
  decodeSheepIdentityViewV1,
  BotNotFoundError,
} from "@frockbot/plugin-flock/shared";
import {
  AUTHORING_QUOTA_CONFIG_KEY,
  AUTHORING_QUOTA_DAY,
  decodeAuthoringQuotaConfigV1,
  reserveAuthoringQuotaV1,
  type AuthoringQuotaConfigV1,
  type AuthoringQuotaReceiptV1,
} from "@frockbot/plugin-authoring/quota";
import {
  releaseSubagentSlotV1,
  reserveSubagentSlotV1,
  type SubagentSlotReceiptV1,
} from "@frockbot/plugin-subagents/quota";
import {
  releaseAgentTurnSlotV1,
  reserveAgentTurnSlotV1,
  type AgentTurnSlotReceiptV1,
} from "@frockbot/plugin-flock/quota";
import { machineTokenClaimsV1 } from "@frockbot/machine-protocol";
import {
  appletStateNameV1,
  DurableWorkspaceGenerations,
} from "@frockbot/kernel-do";
import {
  decodeAppletProvenanceV1,
  decodeAppletToolDeclarationV1,
  type AppletSummaryV1,
} from "@frockbot/kernel-contracts";
import {
  AppletDirectory,
  type AppletDirectoryViewV1,
} from "./applet-directory.js";
import type { AppletState } from "./applet-state.js";
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
  SEARCH_MAX_ROW_PAGE_V1,
  decodeSearchQueryV1,
  type ClientSearchRebuildReceiptV1,
  type SearchIndexResultsV1,
} from "@frockbot/plugin-search";
import type { BotSearchRpc } from "./search.js";
import {
  AUDIT_KINDS_V1,
  AUDIT_MAX_ENTRY_PAGE_V1,
  AUDIT_MAX_RESULTS_V1,
  type AuditRebuildReceiptV1,
  type ClientAuditPageV1,
} from "@frockbot/plugin-audit";
import type { BotAuditRpc } from "./audit.js";
import {
  decodePublishPackageCommandV1,
  decodeRollbackPackageCommandV1,
} from "@frockbot/plugin-package-publisher/shared";
import { decodeMcpMountOutcomeV1 } from "@frockbot/plugin-mcp/records";
import type {
  McpAuthorizationCompletionRequestV1,
  McpAuthorizationStartRequestV1,
} from "@frockbot/plugin-mcp/backend";
import {
  recordVoiceUsageV1,
  reserveVoiceCaptureV1,
  VOICE_QUOTA_DAY,
  type VoiceQuotaReceiptV1,
  type VoiceUsageReceiptV1,
} from "./voice-quota.js";
import type { WorkerLoader } from "./contracts.js";
import { createPackagePublicationHost } from "./package-publication.js";
import { R2PackageCatalog } from "./package-catalog.js";
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
  rpcJsonRecord,
  rpcJsonSnapshotV1,
  rpcObject,
} from "./durable-rpc.js";
import { loggedEntryV1 } from "./entry-boundary.js";

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
  /**
   * Signs every machine token and pairing code. Absent closes the door: a
   * pairing is refused rather than offered under a signature nothing could
   * verify.
   */
  MACHINE_TOKEN_SECRET?: string;
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
  /**
   * The remote Package Catalog, read-only. The User Durable Object pins one
   * generation from it and validates every Catalog install against that pin.
   * Optional: a deployment without a Catalog installs compiled-in Packages
   * exactly as before.
   */
  PACKAGE_CATALOG?: R2Bucket;
  /**
   * One Applet Durable Object per Applet instance (ADR 0022). The User object
   * owns the directory and calls `delete()` on the instance; it never reads an
   * Applet's contents. Optional so a deployment without the binding still
   * serves every other User RPC, and an Applet deletion refuses visibly.
   */
  APPLET_STATES?: DurableObjectNamespace<AppletState>;
}

/** The page of a Bot's projected rows a rebuild pulls, one Bot at a time. */
const SEARCH_REBUILD_BOT_LIMIT = 200;

export class UserConfiguration extends DurableObject<UserConfigurationEnv> {
  private mounted: Promise<MountedFoundationUserBackend> | undefined;

  private contributions(): Promise<MountedFoundationUserBackend> {
    if (!this.mounted) {
      this.mounted = compileFoundationApplication().then((plan) =>
        createFoundationUserBackendContributions(plan, {
          storage: this.ctx.storage,
          readSecret: (name) =>
            name === "MACHINE_TOKEN_SECRET"
              ? this.env.MACHINE_TOKEN_SECRET
              : this.env.CREDENTIAL_KEYRING,
          packagePublisher: createPackagePublicationHost(
            this.env,
            this.ctx.storage,
          ),
          ...(this.env.PACKAGE_CATALOG
            ? { catalog: new R2PackageCatalog(this.env.PACKAGE_CATALOG) }
            : {}),
          // The Bot Template seams. The blob store is the same bucket the
          // Catalog's own immutable generations live in, written through the
          // same collision-checking rule; the Bot reader is three read-only
          // RPCs to the Bot Durable Object that already owns that state.
          botTemplate: {
            bots: this.templateBotReader(),
            blobs: this.templateBlobStore(),
            importer: this.templateImportWriter(),
            readPublishedShare: (shareId: string) =>
              this.readPublishedShare(shareId),
            ...(this.env.PACKAGE_CATALOG
              ? {
                  readCatalogIds: async (generation: string) => {
                    const found = await new R2PackageCatalog(
                      this.env.PACKAGE_CATALOG!,
                    ).readIndexDocument(generation);
                    if (!found) return [];
                    return parseCatalogIndexDocumentV1(
                      found.document,
                    ).entries.map((entry) => entry.catalogId);
                  },
                }
              : {}),
            ...(this.env.PACKAGE_CATALOG
              ? {
                  readCatalogDisplayName: async (
                    generation: string,
                    catalogId: string,
                  ) =>
                    (
                      await new R2PackageCatalog(
                        this.env.PACKAGE_CATALOG!,
                      ).readEntry(generation, catalogId)
                    )?.displayName,
                }
              : {}),
          },
          // The transcript index (parity register row 52). It lives on this
          // object's own SQL storage because "The User's Durable Object is the
          // authority for everything User-scoped", and it is a *projection*:
          // its rows are read back out of the Bots' own stored runs by
          // `rebuildSearchIndex`, so it holds no authority of its own.
          search: {
            sql: this.ctx.storage.sql,
            projectBotRows: (botId, cursor) => {
              // Every caller of a rebuild has already passed
              // `assertFlockIdentity`, so this object knows which User it is;
              // a rebuild that reached here without one would address an
              // arbitrary Bot object, so it refuses instead.
              const userId = this.identity;
              if (!userId) {
                throw new Error(
                  "this User Durable Object has no proven identity to rebuild for",
                );
              }
              const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
              // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
              const rpc = this.env.BOT_STATES.get(
                id,
              ) as unknown as BotSearchRpc;
              return rpc
                .projectSearchRows({
                  schemaVersion: 1,
                  userId,
                  botId,
                  ...(cursor === undefined ? {} : { cursor }),
                })
                .then(rpcJsonSnapshotV1);
            },
          },
          // The audit table (parity register rows 30 and 30b). Same object,
          // same SQL storage, same discipline as the transcript index: every
          // row is a projection of the Bots' own durable session events, and
          // `rebuildAuditIndex` reads them back from that authority.
          audit: {
            sql: this.ctx.storage.sql,
            projectBotEntries: (botId, cursor) => {
              const userId = this.identity;
              if (!userId) {
                throw new Error(
                  "this User Durable Object has no proven identity to rebuild for",
                );
              }
              const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
              // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
              const rpc = this.env.BOT_STATES.get(id) as unknown as BotAuditRpc;
              return rpc
                .projectAuditEntries({
                  schemaVersion: 1,
                  userId,
                  botId,
                  ...(cursor === undefined ? {} : { cursor }),
                })
                .then(rpcJsonSnapshotV1);
            },
          },
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

  /**
   * Cheap, read-only signup-gate probe.
   *
   * Addressing this object is not User materialization: only
   * `assertUserIdentity` writes the durable identity pin. A closed deployment
   * can therefore ask whether the User already exists without creating one.
   */
  async isProvisioned(input: unknown): Promise<boolean> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    const userId = request.userId as string;
    const namespace = this.env.USER_CONFIGURATIONS;
    if (!namespace || !namespace.idFromName(userId).equals(this.ctx.id)) {
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
    return pinned === userId;
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
   * The User's MCP servers, as the status projection GrokBot calls
   * `GetMcpServerStatus`. A read of durable records this object owns; it
   * reaches no server and wakes nothing.
   */
  async readMcpServers(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.contributions()).mcp.readServerStatus(
      request.userId as string,
    );
  }

  /**
   * One MCP lifecycle command: add a server, set its instructions, restart
   * it. Decoded inside the Contribution that owns the records, so the seam
   * carries no shape of its own.
   */
  async executeMcpCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.contributions()).mcp.executeLifecycle(
      request.userId as string,
      request.command,
    );
  }

  /**
   * What a Bot's mount of an MCP server found. The Bot Durable Object holds
   * no MCP record — this object does — so a mount that could not reach the
   * server reports it here and the failure becomes visible on the User's own
   * surface rather than dying inside a Turn.
   */
  async recordMcpMountOutcome(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      outcome: rpcDecoded(decodeMcpMountOutcomeV1),
    });
    await this.assertUserIdentity(request.userId as string);
    await (
      await this.contributions()
    ).mcp.recordMountOutcome({
      accountId: request.userId as string,
      ...(request.outcome as ReturnType<typeof decodeMcpMountOutcomeV1>),
    });
  }

  /**
   * Start one `mcp-remote-oauth` authorization.
   *
   * The gateway signs the state and forwards; every outbound OAuth request —
   * discovery, registration, the token exchange — happens on the far side of
   * this seam, inside the object that holds the keyring. Nothing about the
   * flow's secrets crosses back: the answer is a redirect URL and nothing
   * else.
   */
  async startMcpAuthorization(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      start: rpcObject(
        {
          commandId: rpcIdentifier,
          redirectUri: rpcString(2_048),
          callbackState: rpcString(8_192),
          authorizationStateId: rpcString(128),
          authorizationStateExpiresAt: rpcInteger({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
          returnTarget: rpcString(16),
        },
        {
          connectionId: rpcIdentifier,
          label: rpcString(120),
          settings: rpcJsonRecord,
          nativeReturnNonce: rpcIdentifier,
        },
      ),
    });
    await this.assertUserIdentity(request.userId as string);
    const start = request.start as McpAuthorizationStartRequestV1;
    if (start.returnTarget !== "browser" && start.returnTarget !== "desktop") {
      throw new Error("MCP authorization returnTarget is invalid");
    }
    return (await this.contributions()).mcp.startAuthorization(
      request.userId as string,
      start,
    );
  }

  /**
   * Finish one authorization, once the gateway has verified its signed state.
   *
   * The `authorizationStateId` is consumed here, transactionally: a replayed
   * callback is a no-op that reports the Connection's settled state rather
   * than a second token exchange.
   */
  async completeMcpAuthorization(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      completion: rpcObject(
        {
          authorizationStateId: rpcString(128),
          connectionId: rpcIdentifier,
          returnTarget: rpcString(16),
        },
        {
          nativeReturnNonce: rpcIdentifier,
          code: rpcString(4_096),
          error: rpcString(512),
        },
      ),
    });
    await this.assertUserIdentity(request.userId as string);
    const completion =
      request.completion as McpAuthorizationCompletionRequestV1;
    if (
      completion.returnTarget !== "browser" &&
      completion.returnTarget !== "desktop"
    ) {
      throw new Error("MCP authorization returnTarget is invalid");
    }
    return (await this.contributions()).mcp.completeAuthorization(
      request.userId as string,
      completion,
    );
  }

  /** RFC 7009 revocation, then the local teardown. */
  async revokeMcpAuthorization(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.contributions()).mcp.revokeAuthorization(
      request.userId as string,
      request.connectionId as string,
    );
  }

  /**
   * An expiring lease over a Connection's credential for a tool
   * Contribution's mount. The Package that owns the Connection is resolved
   * from the durable projection, so a caller cannot name a Package the
   * Connection does not belong to, and a Package whose Connections carry no
   * credential refuses by not implementing the seam at all.
   */
  async leaseToolCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      effectId: rpcIdentifier,
      connectionGeneration: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) throw new Error("Connection is unavailable");
    const contribution = await this.connectionContribution(
      connection.packageId,
    );
    if (!contribution.leaseToolCredential) {
      throw new Error("Connection Package offers no tool credential");
    }
    return contribution.leaseToolCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
      connectionGeneration: request.connectionGeneration as string,
    });
  }

  async settleToolCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) return;
    const contribution = await this.connectionContribution(
      connection.packageId,
    );
    await contribution.settleToolCredential?.({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
    });
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

  /**
   * The per-User concurrent-subagent bound (ADR 0017).
   *
   * A Bot's own bound is countable in its Durable Object; a User's is not,
   * because a User's Bots are separate objects. So the slot is held here, and
   * the Bot's Durable Object reserves one before it dispatches and releases it
   * when the task settles. Both halves are idempotent on `(botId, taskId)`.
   */
  async reserveSubagentSlot(input: unknown): Promise<SubagentSlotReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
      reservedAt: rpcString(64),
    });
    return reserveSubagentSlotV1(this.ctx.storage, {
      schemaVersion: 1,
      userId: request.userId as string,
      botId: request.botId as string,
      taskId: request.taskId as string,
      reservedAt: request.reservedAt as string,
    });
  }

  async releaseSubagentSlot(
    input: unknown,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    return releaseSubagentSlotV1(this.ctx.storage, {
      botId: request.botId as string,
      taskId: request.taskId as string,
    });
  }

  /** User-wide agent-lane budget shared by every Bot and Voice session. */
  async reserveAgentTurnSlot(input: unknown): Promise<AgentTurnSlotReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      requesterId: rpcString(256),
      runId: rpcString(256),
      reservedAt: rpcString(64),
    });
    await this.assertUserIdentity(request.userId as string);
    return reserveAgentTurnSlotV1(this.ctx.storage, {
      schemaVersion: 1,
      userId: request.userId as string,
      requesterId: request.requesterId as string,
      runId: request.runId as string,
      reservedAt: request.reservedAt as string,
    });
  }

  async releaseAgentTurnSlot(
    input: unknown,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      requesterId: rpcString(256),
      runId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    return releaseAgentTurnSlotV1(this.ctx.storage, {
      requesterId: request.requesterId as string,
      runId: request.runId as string,
    });
  }

  /**
   * The durable per-User voice budget (voice plan D1).
   *
   * The `VoiceSession` Durable Object holds the sockets and no authority, so
   * it asks here before it opens a microphone and reports here when it closes
   * one — the same seam `reserveSubagentSlot` gives the Bot object, and for
   * the same reason: a User's budget is not countable anywhere else.
   */
  async reserveVoiceCapture(input: unknown): Promise<VoiceQuotaReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      day: rpcPattern(VOICE_QUOTA_DAY, 10),
      sessionId: rpcString(128),
    });
    return reserveVoiceCaptureV1(this.ctx.storage, {
      day: request.day as string,
      sessionId: request.sessionId as string,
    });
  }

  async recordVoiceUsage(input: unknown): Promise<VoiceUsageReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      day: rpcPattern(VOICE_QUOTA_DAY, 10),
      sessionId: rpcString(128),
      seconds: rpcInteger({ minimum: 0, maximum: 24 * 60 * 60 }),
    });
    return recordVoiceUsageV1(this.ctx.storage, {
      day: request.day as string,
      sessionId: request.sessionId as string,
      seconds: request.seconds as number,
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
    // An alarm has no caller: a throw here is an uncaught exception in the
    // object, and the next firing is the recovery.
    await loggedEntryV1("User configuration alarm", () => this.#alarm());
  }

  async #alarm() {
    const contributions = await this.contributions();
    await contributions.credentials.expireLeases();
    for (const contribution of contributions.connections.values()) {
      await contribution.alarm?.();
    }
    await contributions.publisher.recover();
    // An import left mid-apply by an eviction resumes here, from the first
    // step its record does not already mark done.
    const importer = this.identity;
    if (importer) await contributions.botTemplate.recoverImports(importer);
    // The Bot lifecycle sagas (archive and restore) resume on the same firing.
    await contributions.flock.alarm();
    // An archive that settled on a retry rather than on its command purges the
    // transcript index here. Purge is a delete of a projection, so sweeping
    // every archived Bot on every firing is idempotent and cheap, and it means
    // no archived Bot keeps rows because its saga finished out of band.
    const lifecycles = await contributions.flock.listBotLifecycles();
    for (const lifecycle of lifecycles.lifecycles) {
      if (lifecycle.status === "archived") {
        contributions.search.purge(lifecycle.botId);
        contributions.audit.purgeAuditForBot(lifecycle.botId);
      }
    }
    // A delete that settled on a retry rather than on its own command left its
    // User-scoped projections behind, and the deleted Bot is no longer in any
    // lifecycle list to sweep from. The Flock Contribution keeps the to-do
    // list instead, and it is cleared only once the projections are gone.
    for (const botId of await contributions.flock.listDeletedBotIds()) {
      await this.forgetDeletedBot(botId);
    }
  }

  /**
   * The User-scoped state one deleted Bot leaves behind: its transcript rows,
   * its audit entries and its Memory Project membership.
   *
   * Every step is a delete, so repeating it is free, and the to-do entry is
   * dropped last — a crash before that simply replays the sweep.
   */
  private async forgetDeletedBot(botId: string): Promise<void> {
    const contributions = await this.contributions();
    contributions.search.purge(botId);
    contributions.audit.purgeAuditForBot(botId);
    await this.ctx.storage.delete(`${MEMORY_PROJECTS_KEY}:${botId}`);
    await contributions.flock.forgetDeletedBot(botId);
  }

  // --- Applet directory (ADR 0022 decision 3) ------------------------------
  //
  // Account-wide by decision D2: every Bot of this User sees every Applet. The
  // directory holds identity, the current generation, and the tool
  // declarations; the instance itself lives in its own Durable Object and its
  // contents are never read here.

  private appletDirectory(): AppletDirectory {
    return new AppletDirectory({
      get: (key) => this.ctx.storage.get(key),
      put: (entries) => this.ctx.storage.put(entries),
      list: (options) => this.ctx.storage.list(options),
    });
  }

  private appletState(
    userId: string,
    appletId: string,
  ): DurableObjectStub<AppletState> {
    const namespace = this.env.APPLET_STATES;
    if (!namespace) {
      throw new Error("Applets are not configured for this deployment");
    }
    return namespace.get(
      namespace.idFromName(appletStateNameV1(userId, appletId)),
    );
  }

  async listApplets(input: unknown): Promise<AppletDirectoryViewV1> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return this.appletDirectory().list();
  }

  /**
   * The Applet members one Bot's next Composition generation resolves, with
   * the directory revision they were resolved at. A Bot re-resolves when the
   * revision it recorded no longer matches.
   */
  async readAppletCompositionInput(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return this.appletDirectory().compositionInput();
  }

  async createApplet(input: unknown): Promise<AppletSummaryV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      displayName: rpcString(128),
      provenance: rpcDecodedValue,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    return this.appletDirectory().create({
      ownerId: userId,
      displayName: request.displayName as string,
      provenance: decodeAppletProvenanceV1(
        rpcJsonSnapshotV1(request.provenance),
      ),
    });
  }

  /**
   * Records the generation the Applet Durable Object activated, and advances
   * the directory revision so every Bot picks the tools up at its next
   * Composition resolution.
   */
  async recordAppletGeneration(input: unknown): Promise<AppletSummaryV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
      generationId: rpcString(128),
      tools: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    const tools = rpcJsonSnapshotV1(request.tools);
    if (!Array.isArray(tools)) {
      throw new Error("Applet tool declarations must be an array");
    }
    return this.appletDirectory().recordGeneration({
      appletId: request.appletId as string,
      generationId: request.generationId as string,
      tools: tools.map((tool, index) =>
        decodeAppletToolDeclarationV1(
          tool,
          `Applet tool declaration[${index}]`,
        ),
      ),
    });
  }

  /**
   * Deletion in the order the constitution's failure rule wants: the entry is
   * marked deleted and the revision advanced first, so no Bot can still offer
   * the tools of an Applet whose storage is about to go, and the instance's
   * facet, versions, and records are deleted after. Artifacts are immutable
   * content and are left to the existing garbage collection.
   */
  async deleteApplet(input: unknown): Promise<AppletSummaryV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    const appletId = request.appletId as string;
    const deleted = await this.appletDirectory().markDeleted(appletId);
    await this.appletState(userId, appletId).delete({
      schemaVersion: 1,
      userId,
      appletId,
    });
    return deleted;
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
    const command = request.command as ReturnType<
      typeof decodeBotLifecycleCommandV1
    >;
    const receipt = await (
      await this.flockContribution()
    ).executeLifecycle(request.userId as string, command);
    // Archiving a Bot removes its transcript from the index. The rows are a
    // projection, so this destroys nothing: restoring the Bot and rebuilding
    // brings every one of them back from the Bot's own stored runs.
    if (command.type === "bot/archive" && receipt.status === "applied") {
      (await this.searchContribution()).purge(command.botId);
      (await this.auditContribution()).purgeAuditForBot(command.botId);
    }
    // Deleting a Bot destroys them rather than dropping a projection: nothing
    // is left to rebuild from. The sweep runs here on the common path and from
    // the alarm on every other one.
    if (command.type === "bot/delete" && receipt.status === "applied") {
      await this.forgetDeletedBot(command.botId);
    }
    return receipt;
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

  private async searchContribution(): Promise<
    MountedFoundationUserBackend["search"]
  > {
    return (await this.contributions()).search;
  }

  /**
   * Rows for one settled Turn, from the Bot Durable Object that owns it.
   *
   * Idempotent on `(botId, runId, seq)`: a resumed Turn, a retried RPC, and a
   * rebuild all converge on the same rows, so the Bot may treat the call as
   * fire-and-forget without risking a duplicated transcript.
   */
  async indexSearchRows(input: unknown): Promise<{ indexed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      rows: rpcDecodedValue,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    if (!(await (await this.flockContribution()).hasBot(botId))) {
      throw new Error(`Bot "${botId}" is not registered to this User`);
    }
    if (!Array.isArray(request.rows)) {
      throw new Error("RPC request.rows must be an array");
    }
    if (request.rows.length > SEARCH_MAX_ROW_PAGE_V1) {
      throw new Error("RPC request.rows exceeds its bound");
    }
    // A Bot indexes its own transcript and no other's. The `botId` was proved
    // registered to this User above; a row naming a different Bot is refused
    // rather than quietly dropped.
    const foreign = request.rows.find(
      (row) =>
        !row ||
        typeof row !== "object" ||
        (row as { botId?: unknown }).botId !== botId,
    );
    if (foreign) {
      throw new Error("search rows name another Bot");
    }
    return (await this.searchContribution()).indexRows(request.rows);
  }

  /** One page of hits across every Bot this User has. */
  async searchTranscripts(input: unknown): Promise<SearchIndexResultsV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      query: rpcDecoded(decodeSearchQueryV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.searchContribution()).search(request.query);
  }

  /**
   * Throws the index away and re-projects it from the Bots' own stored runs.
   *
   * The index is disposable because this exists. It is also the backfill path
   * for a Bot whose turns predate the index, so one code path produces every
   * row the index has ever held.
   */
  async rebuildSearchIndex(
    input: unknown,
  ): Promise<ClientSearchRebuildReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    const outcome = await (await this.searchContribution()).rebuild();
    return {
      schemaVersion: 1,
      status: "rebuilt",
      indexedRows: outcome.indexedRows,
      bots: Math.min(outcome.bots, SEARCH_REBUILD_BOT_LIMIT),
      indexState: outcome.indexState,
    };
  }

  /** Every row of one Bot leaves the index. Archiving a Bot calls this. */
  async purgeSearchIndex(input: unknown): Promise<{ removed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.searchContribution()).purge(request.botId as string);
  }

  /**
   * The Bot reads one export needs. Every one is read-only and Bot-scoped, and
   * every one goes to the Bot Durable Object that is the authority for it: the
   * User Durable Object never reads a Bot's instruction root itself.
   */
  private templateBotReader(): TemplateBotReaderV1 {
    const botState = (userId: string, botId: string) => {
      const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
      // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
      return this.env.BOT_STATES.get(id) as unknown as {
        readConfiguration(input: unknown): Promise<unknown>;
        readSheep(input: unknown): Promise<unknown>;
        listOwnSkillDocuments(input: unknown): Promise<unknown>;
        listRoutines(input: unknown): Promise<unknown>;
      };
    };
    return {
      readSettings: async (userId, botId) =>
        decodeBotSettingsViewV1(
          rpcJsonSnapshotV1(
            await botState(userId, botId).readConfiguration({
              schemaVersion: 1,
              userId,
              botId,
            }),
          ),
        ),
      readSheep: async (userId, botId) =>
        decodeSheepIdentityViewV1(
          rpcJsonSnapshotV1(
            await botState(userId, botId).readSheep({
              schemaVersion: 1,
              userId,
              botId,
            }),
          ),
        ).sheep,
      readSkills: async (userId, botId) => {
        const documents = rpcJsonSnapshotV1(
          await botState(userId, botId).listOwnSkillDocuments({
            schemaVersion: 1,
            userId,
            botId,
          }),
        );
        if (!Array.isArray(documents)) return [];
        // `loadSkillCatalogV1` already walked only this Bot's own instruction
        // root and refused every candidate the authority predicate refuses, so
        // each of these is a `bot` Skill this Bot or its User wrote. The scrub
        // is told so explicitly and decides the matter again on its own side.
        return documents.map((document) => {
          const value = document as Record<string, unknown>;
          return {
            source: "bot" as const,
            slug: typeof value.slug === "string" ? value.slug : undefined,
            name: typeof value.name === "string" ? value.name : "Skill",
            ...(typeof value.description === "string"
              ? { description: value.description }
              : {}),
            ...(typeof value.body === "string" ? { body: value.body } : {}),
            writer: { kind: "bot" as const },
          };
        });
      },
      readRoutines: async (userId, botId) =>
        decodeRoutineListViewV1(
          rpcJsonSnapshotV1(
            await botState(userId, botId).listRoutines({
              schemaVersion: 1,
              userId,
              botId,
            }),
          ),
        ).routines.map((routine) => ({
          routineId: routine.routineId,
          name: routine.name,
          prompt: routine.prompt,
          ...(routine.schedule === undefined
            ? {}
            : { schedule: routine.schedule }),
          ...(routine.trigger === undefined
            ? {}
            : { trigger: { kind: "webhook" as const } }),
          timezone: routine.timezone,
        })),
    };
  }

  /**
   * The import writer: the importing User's own commands, and no others.
   *
   * `bot/create` goes to this object's Flock, `user/install-package` to its
   * Settings Contribution, and the two Bot-scoped writes to the Bot Durable
   * Object that owns them. There is no method here for a Connection because
   * the seam cannot express it.
   */
  private templateImportWriter(): TemplateImportWriterV1 {
    const botState = (userId: string, botId: string) => {
      const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
      // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
      return this.env.BOT_STATES.get(id) as unknown as {
        writeUserSkill(input: unknown): Promise<unknown>;
        executeRoutineCommand(input: unknown): Promise<unknown>;
      };
    };
    return {
      listBots: async () => {
        const directory = await (await this.flockContribution()).listBots();
        return {
          revision: directory.revision,
          bots: directory.bots.map((bot) => ({ botId: bot.botId })),
        };
      },
      createBot: async (command) => {
        const receipt = await (
          await this.flockContribution()
        ).createBot(command.userId, {
          schemaVersion: 1,
          type: "bot/create",
          commandId: command.commandId,
          expectedRevision: command.expectedRevision,
          botId: command.botId,
          name: command.name,
          ...(command.description === undefined
            ? {}
            : { description: command.description }),
          sheep: command.sheep,
        });
        return receipt.status === "applied"
          ? { status: "applied" as const }
          : {
              status: "rejected" as const,
              ...(receipt.failure === undefined
                ? {}
                : { failure: receipt.failure }),
            };
      },
      installPackage: async (install) => {
        // The User's own install command, validated against their own pinned
        // generation by the Settings Contribution and receipted on its
        // `commandId`, so a replayed step is a read. It carries no `values`:
        // a template never exports setup values, because they may hold keys,
        // and an install with none leaves the store the User already has.
        const receipt = await (
          await this.settingsContribution()
        ).executeConfiguration({
          schemaVersion: 1,
          userId: install.userId,
          command: {
            schemaVersion: 1,
            type: "user/install-package",
            commandId: install.commandId,
            expectedRevision: (
              await (await this.settingsContribution()).read(install.userId)
            ).revision,
            packageId: install.packageId,
            version: install.version,
            catalogId: install.catalogId,
            catalogGeneration: install.catalogGeneration,
          },
        });
        return receipt.status === "rejected"
          ? {
              status: "rejected",
              ...(receipt.failure === undefined
                ? {}
                : { failure: receipt.failure }),
            }
          : { status: receipt.status };
      },
      writeSkill: async (skill) => {
        const outcome = rpcJsonSnapshotV1(
          await botState(skill.userId, skill.botId).writeUserSkill({
            schemaVersion: 1,
            userId: skill.userId,
            botId: skill.botId,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            body: skill.body,
          }),
        ) as Record<string, unknown>;
        return outcome.status === "written"
          ? {
              status: "written" as const,
              generationId: String(outcome.generationId),
            }
          : {
              status: "refused" as const,
              reason: String(outcome.reason ?? "the Skill write was refused"),
            };
      },
      executeRoutineCommand: async (routine) => {
        const receipt = rpcJsonSnapshotV1(
          await botState(routine.userId, routine.botId).executeRoutineCommand({
            schemaVersion: 1,
            userId: routine.userId,
            botId: routine.botId,
            command: routine.command,
          }),
        ) as Record<string, unknown>;
        const decoded = decodeRoutineCommandReceiptV1(receipt);
        return {
          status: decoded.status,
          ...(decoded.status === "applied"
            ? { routineId: decoded.routine.routineId }
            : { routineId: decoded.routineId }),
        };
      },
    };
  }

  /**
   * One published share, of any User.
   *
   * The share id names its owner, so this derives that User's Durable Object
   * and asks it. Nothing here can read another User's storage directly; the
   * owning object still decides, and it answers only for `link` and `public`.
   */
  private async readPublishedShare(
    shareId: string,
  ): Promise<{ hash: string; document: string } | undefined> {
    let ownerId: string;
    try {
      ownerId = parseTemplateShareIdV1(shareId).ownerId;
    } catch {
      return undefined;
    }
    const owner = this.env.USER_CONFIGURATIONS.idFromName(ownerId);
    // SAFETY: USER_CONFIGURATIONS is bound to this class; generated RPC methods are not represented by workers-types.
    const rpc = this.env.USER_CONFIGURATIONS.get(owner) as unknown as {
      resolveTemplateShare(input: unknown): Promise<unknown>;
    };
    const answered = await rpc.resolveTemplateShare({
      schemaVersion: 1,
      shareId,
    });
    if (answered === undefined || answered === null) return undefined;
    const found = rpcJsonSnapshotV1(answered) as Record<string, unknown>;
    return typeof found.hash === "string" && typeof found.document === "string"
      ? { hash: found.hash, document: found.document }
      : undefined;
  }

  /**
   * The immutable template blob store, over the Catalog bucket.
   *
   * The collision check is the whole write rule, and it is the one
   * `apps/cloudflare/src/package-publication.ts` already applies to a published
   * application artifact: identical bytes at an existing key are a no-op, and
   * different bytes are a collision rather than an overwrite.
   */
  private templateBlobStore(): TemplateBlobStoreV1 {
    const bucket = this.env.PACKAGE_CATALOG;
    return {
      putImmutable: async (key, document) => {
        if (!bucket) {
          throw new Error("the template store is not configured");
        }
        const existing = await bucket.get(key);
        if (existing) {
          if ((await existing.text()) !== document) {
            throw new Error(`immutable artifact collision at ${key}`);
          }
          return;
        }
        await bucket.put(key, document, {
          httpMetadata: { contentType: "application/json; charset=utf-8" },
        });
      },
      read: async (key) => {
        if (!bucket) return undefined;
        const object = await bucket.get(key);
        if (!object) return undefined;
        if (object.size > MAX_TEMPLATE_BYTES_V1) {
          throw new Error(`template object "${key}" is too large`);
        }
        return object.text();
      },
    };
  }

  private async botTemplateContribution(): Promise<
    MountedFoundationUserBackend["botTemplate"]
  > {
    return (await this.contributions()).botTemplate;
  }

  async listTemplateShares(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.botTemplateContribution()).listShares(
      request.userId as string,
    );
  }

  async executeTemplateCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeTemplateCommandV1),
    });
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    const command = request.command as TemplateCommandV1;
    if (command.type === "template/stage") {
      // A template is packed from a Bot this User owns, and the Flock is the
      // authority for which those are. Without this, a staging command could
      // name any Bot id and the User Durable Object would carry it.
      if (!(await (await this.flockContribution()).hasBot(command.botId))) {
        throw new BotNotFoundError(command.botId);
      }
    }
    return (await this.botTemplateContribution()).execute(userId, command);
  }

  async listTemplateImports(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.botTemplateContribution()).listImports(
      request.userId as string,
    );
  }

  /**
   * `template/plan-import` and `template/apply-import`.
   *
   * Planning reads and writes a `planned` record; only an explicit apply moves
   * it on. "Nothing is applied before the User confirms" is durable state here,
   * not a client-side guard.
   */
  async executeTemplateImport(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeTemplateCommandV1),
    });
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    return (await this.botTemplateContribution()).executeImport(
      userId,
      request.command,
    );
  }

  /**
   * One published share, for the unauthenticated gateway route.
   *
   * No identity is asserted, and none can be: the caller has proved nothing.
   * The share record decides, and it answers only for `link` and `public`.
   */
  async resolveTemplateShare(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      shareId: rpcString(200),
    });
    const found = await (
      await this.botTemplateContribution()
    ).resolvePublicShare(request.shareId as string);
    return found === undefined
      ? undefined
      : {
          schemaVersion: 1 as const,
          hash: found.share.hash,
          visibility: found.share.visibility,
          document: found.document,
        };
  }

  private async auditContribution(): Promise<
    MountedFoundationUserBackend["audit"]
  > {
    return (await this.contributions()).audit;
  }

  /**
   * Audit entries for one settled Turn, from the Bot Durable Object that owns
   * it.
   *
   * Idempotent on `(botId, runId, occurrenceId)`, which is what makes the Bot
   * object's outbox safe: it delivers at least once, and a redelivery inserts
   * nothing.
   */
  async indexAuditEntries(input: unknown): Promise<{ indexed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      entries: rpcDecodedValue,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    if (!(await (await this.flockContribution()).hasBot(botId))) {
      throw new Error(`Bot "${botId}" is not registered to this User`);
    }
    if (!Array.isArray(request.entries)) {
      throw new Error("RPC request.entries must be an array");
    }
    if (request.entries.length > AUDIT_MAX_ENTRY_PAGE_V1) {
      throw new Error("RPC request.entries exceeds its bound");
    }
    // A Bot audits its own effects and no other's.
    const foreign = request.entries.find(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        (entry as { botId?: unknown }).botId !== botId,
    );
    if (foreign) {
      throw new Error("audit entries name another Bot");
    }
    return (await this.auditContribution()).indexAuditEntries(request.entries);
  }

  /**
   * Throws the audit table away and re-projects it from the Bots' own stored
   * runs. The receipt names the discrepancy count, never a silent gap.
   */
  async rebuildAuditIndex(input: unknown): Promise<AuditRebuildReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.auditContribution()).rebuildAuditIndex();
  }

  /**
   * One filtered, paged answer out of this User's audit table.
   *
   * User-scoped by construction: there is no cross-User store to reach into,
   * and the object refuses any RPC naming a User it is not.
   */
  async readAuditEntries(input: unknown): Promise<ClientAuditPageV1> {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      {
        botId: rpcBotId,
        kind: rpcEnum(AUDIT_KINDS_V1),
        target: rpcString(160),
        before: rpcString(64),
        limit: rpcInteger({ minimum: 1, maximum: AUDIT_MAX_RESULTS_V1 }),
      },
    );
    await this.assertFlockIdentity(request.userId as string);
    const contribution = await this.auditContribution();
    const page = contribution.query({
      ...(request.botId === undefined
        ? {}
        : { botId: request.botId as string }),
      ...(request.kind === undefined ? {} : { kind: request.kind as string }),
      ...(request.target === undefined
        ? {}
        : { target: request.target as string }),
      ...(request.before === undefined
        ? {}
        : { before: request.before as string }),
      ...(request.limit === undefined
        ? {}
        : { limit: request.limit as number }),
    });
    return {
      schemaVersion: 1,
      entries: page.entries,
      page: {
        truncated: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      },
      total: page.total,
      indexState: contribution.state(),
    };
  }

  /** Every entry of one Bot leaves the table. Archiving a Bot calls this. */
  async purgeAuditForBot(input: unknown): Promise<{ removed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.auditContribution()).purgeAuditForBot(
      request.botId as string,
    );
  }

  private async machineContribution(): Promise<
    MountedFoundationUserBackend["machines"]
  > {
    return (await this.contributions()).machines;
  }

  /**
   * The registered-machine RPCs (parity register rows 48, 49, 57g).
   *
   * The four a machine reaches — poll, claim, result, and the enrollment that
   * precedes them — arrive from the gateway's pre-session `publicRoute`, so
   * this object is the first place a *session* was never involved. That is
   * exactly why each carries the token's own claims and its digest rather than
   * a caller's assertion: the claims were verified against the deployment
   * secret at the edge, and the digest is checked here against the machine
   * record, which is the authority. `assertUserIdentity` still runs, so a
   * token naming another User cannot reach this object's state even if the
   * gateway addressed it wrongly.
   */
  async createMachinePairing(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      { label: rpcString(200) },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).createPairing(
      userId,
      request.label === undefined ? {} : { label: request.label as string },
    );
  }

  async enrollMachine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      enrollment: rpcDecodedValue,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).enroll(
      {
        userId,
        machineId: request.machineId as string,
        nonce: "",
      },
      request.enrollment,
    );
  }

  async pollMachine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      waitSeconds: rpcInteger({ minimum: 0, maximum: 25 }),
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).poll(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
      request.waitSeconds as number,
    );
  }

  async claimMachineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      commandId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).claim(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
      request.commandId as string,
    );
  }

  async recordMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      commandId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      result: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).recordResult(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
      request.commandId as string,
      request.result,
    );
  }

  /**
   * One machine and the two counters a control tool checks its quota against.
   *
   * The tool refuses before it asks a person anything, so a card the User
   * approves and the queue then refuses is not a question that wasted their
   * attention.
   */
  async describeMachineTarget(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).describeTarget(
      request.machineId as string,
    );
  }

  /**
   * Take every finished machine command waiting to be told to a Bot.
   *
   * Drained by the Worker that just answered the machine. It is not this
   * object's job to call another Durable Object: a live reference from one to
   * another keeps the caller resident, and presence and eviction are the two
   * things this registry is built not to depend on.
   */
  async takeMachineDeliveries(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).takeDeliveries();
  }

  async listMachines(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).list();
  }

  async revokeMachine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).revoke(
      request.machineId as string,
    );
  }

  /**
   * Put one approved command on a machine's queue.
   *
   * The caller that matters is R3's approval settlement — a command reaches a
   * User's laptop only after a human decided — and it is here in R2 so the
   * queue's own rules have a door.
   */
  async dispatchMachineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).dispatch(request.command);
  }

  /** One command's full result, read on demand rather than pushed. */
  async readMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).readResult(
      request.commandId as string,
    );
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await this.assertUserIdentity(userId);
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }
}
