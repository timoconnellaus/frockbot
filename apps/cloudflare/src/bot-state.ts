import { DurableObject } from "cloudflare:workers";
import {
  BotStateChannel,
  BOT_STATE_CHANNEL_INTERNAL_PATH,
} from "./bot-state-channel.js";
import {
  compileFoundationApplication,
  createFoundationHostedRuntimePackages,
  createFoundationRuntimeApplication,
} from "@frockbot/application-foundation/runtime";
import {
  computerBotContribution,
  createFoundationBackendContributions,
  createFoundationMountedContributionsV1,
  flockBotContribution,
  plannedFoundationBackendContributions,
  shellBotContribution,
} from "@frockbot/application-foundation/contributions";
import { FIRST_PARTY_PACKAGE_ARTIFACTS_V1 } from "@frockbot/application-foundation/generated/applets-artifact";
import {
  createFoundationResidentRuntime,
  type FoundationResidentRuntime,
} from "@frockbot/agent-runtime/runtime";
import { Context } from "cordis";
import { ComputerRegistry } from "@frockbot/computer-core";
import { createFlySpriteProviderPlugin } from "@frockbot/plugin-fly-sprite/agent";
import { ComputerHostClient } from "@frockbot/plugin-fly-sprite/host-client";
import {
  computerHostEffectRequestWireV1,
  decodeComputerHostEffectResponseV1,
} from "@frockbot/computer-core/host-protocol";
import {
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeCompositionGenerationIdV1,
  decodeRevertCompositionCommandV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type RevertCompositionCommandV1,
} from "@frockbot/configuration-core";
import { BotDurableAuthority } from "@frockbot/kernel-do";
import type {
  BotStateEnv,
  OwnedBotTurnCommand,
  ShellBotBackendContribution,
} from "@frockbot/plugin-shell/backend";
import type {
  BotResidentExecution,
  BotResidentProjection,
} from "@frockbot/plugin-shell/backend-execution";
import { executeResidentBotTurn } from "@frockbot/plugin-shell/backend-runner";
import type { FlockBotBackendContribution } from "@frockbot/plugin-flock/bot";
import type { ComputerBotBackendContribution } from "@frockbot/plugin-computer/bot";
import { decodeComputerCommandV1 } from "@frockbot/plugin-computer/protocol";
import {
  decodeBotLifecycleCommandV1,
  decodeBotRegistrationV1,
  decodeUpdateSheepCommandV1,
  type BotLifecycleCommandV1,
  type BotRegistrationV1,
} from "@frockbot/plugin-flock/shared";
import { decodeBotDebugQueryV1 } from "@frockbot/plugin-shell/debug-protocol";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  type ClientRunListQueryV1,
  type ClientRunLookupQueryV1,
  type ClientRunStopCommandV1,
} from "@frockbot/plugin-shell/run-protocol";
import {
  decodeBotUnreadCommandV1,
  type BotUnreadCommandV1,
} from "@frockbot/plugin-shell/unread";
import {
  decodeApprovalDecisionCommandV1,
  type ApprovalDecisionCommandV1,
} from "@frockbot/plugin-shell/approvals";
import {
  decodePackageIframeToolCommandV1,
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateNotificationRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateAppletsRequestV1,
  decodeIsolateToolRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeNormalizedModelRequestV1,
  decodeWorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import type {
  AppletBuildViewV1,
  AppletSourceViewV1,
  NormalizedModelRequest,
  WorkspaceFilesV1,
  WorkspaceGenerationsV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceSyncEffectsV1,
} from "@frockbot/kernel-contracts";
import {
  APPLET_ID_V1,
  APPLET_SOURCE_MAX_BYTES_V1,
  APPLET_SOURCE_MAX_FILES_V1,
  decodeWorkspacePathV1,
} from "@frockbot/kernel-contracts";

/*
 * Where an Applet's source lives.
 *
 * The Applets Package declares this root in its manifest (plan §7); these are
 * the ids that name it, restated here because the canvas's read is served from
 * the Bot Durable Object rather than from the Package's own module.
 */
const APPLETS_SOURCE_PACKAGE_ID_V1 = "applets";
const APPLETS_SOURCE_ROOT_ID_V1 = "source";

/** Base64 without a Node Buffer: this object runs in workerd. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
import {
  decodeRoutineCommandV1,
  decodeRoutineInboxCommandV1,
  type RoutineCommandV1,
  type RoutineInboxCommandV1,
} from "@frockbot/plugin-routines/shared";
import {
  decodeRoutineHookDeliveryV1,
  type RoutineHookDeliveryV1,
} from "@frockbot/plugin-routines/hook";
import {
  decodeSubagentRunTaskRequestV1,
  type SubagentRunTaskRequestV1,
} from "@frockbot/plugin-shell/backend-subagents";
import {
  decodeTaskOutcomeV1,
  type TaskOutcomeV1,
} from "@frockbot/plugin-subagents/records";
import {
  decodeMachineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "@frockbot/plugin-user-machine/delivery";
import {
  createDurableWorkspaceFilesV1,
  deleteBotWorkspaceRootsV1,
} from "./workspace.js";
import { R2PackageCatalog } from "./package-catalog.js";
import type { BotSkillCatalogReaderV1 } from "@frockbot/plugin-shell/backend-skills";
import type { ClientWorkspaceFileV1 } from "./contracts.js";
import {
  DurableWorkspaceGenerations,
  DurableWorkspaceSyncEffects,
} from "@frockbot/kernel-do";
import type { MemoryProjectsV1 } from "@frockbot/plugin-memory/agent";
import {
  searchRowsFromClientRunV1,
  type SearchSinkV1,
} from "@frockbot/plugin-search";
import {
  createBotSearchRowPageV1,
  createUserSearchSinkV1,
  type UserSearchRpc,
} from "./search.js";
import {
  AuditOutboxV1,
  auditEntriesFromStoredRunV1,
  type AuditSinkV1,
} from "@frockbot/plugin-audit";
import {
  createBotAuditEntryPageV1,
  createUserAuditSinkV1,
  type UserAuditRpc,
} from "./audit.js";
import {
  createRoutedWorkspaceGenerationsV1,
  createUserMemoryProjectsV1,
  createUserWorkspaceGenerationsV1,
  type UserMemoryRpc,
} from "./memory.js";
import {
  createFrockAiGatewayHostV1,
  type FrockAiGatewayHostV1,
} from "./frock-ai.js";
import {
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
  rpcAppletIdOrNull,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcObject,
  rpcPattern,
  rpcString,
} from "./durable-rpc.js";
import { answeredEntryV1, loggedEntryV1 } from "./entry-boundary.js";

function isFrockAiGatewayBindingV1(
  value: BotStateEnv["AI"],
): value is NonNullable<BotStateEnv["AI"]> & Pick<Ai, "gateway"> {
  return (
    value !== undefined && typeof Reflect.get(value, "gateway") === "function"
  );
}

function optionalWorkerVarV1(
  env: BotStateEnv,
  name: string,
): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A Frock AI setting, read under its current name and then under the
 * pre-rename `FLOCK_AI_*` one. The vars are deployment configuration and the
 * secrets are set outside this repo, so the fallback is what lets the rename
 * land before they are re-added under the new names. Remove it once every
 * environment names them `FROCK_AI_*`.
 */
function frockAiWorkerVarV1(
  env: BotStateEnv,
  name: `FROCK_AI_${string}`,
): string | undefined {
  return (
    optionalWorkerVarV1(env, name) ??
    optionalWorkerVarV1(env, `FLOCK_AI_${name.slice("FROCK_AI_".length)}`)
  );
}

export type { BotStateEnv, OwnedBotTurnCommand };

export interface BotStateDependencies {
  compileApplication?: typeof compileFoundationApplication;
  outboundFetch?: typeof fetch;
}

function decodeBotIdentityRpcV1(input: unknown): {
  userId: string;
  botId: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
  });
  if (typeof request.userId !== "string" || typeof request.botId !== "string") {
    throw new Error("Computer identity RPC was not decoded");
  }
  return {
    userId: request.userId,
    botId: request.botId,
  };
}

function decodeIsolateCallRpcV1(
  input: unknown,
  decodeRequest: (value: unknown) => unknown,
) {
  return decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    runId: rpcIdentifier,
    sessionId: rpcString(257),
    turnId: rpcIdentifier,
    packageId: rpcIdentifier,
    generationId: rpcIdentifier,
    request: rpcDecoded(decodeRequest),
  });
}

export class BotState extends DurableObject<BotStateEnv> {
  private readonly compileApplication: typeof compileFoundationApplication;
  private readonly outboundFetch?: typeof fetch;
  /**
   * The environment the Shell Package runs under: the Durable Object's
   * bindings plus the Workspace file surface built over them. `WORKSPACE_FILES`
   * is not a Worker binding — it is `WorkspaceFilesV1` over the durable-root
   * object store, with its generations recorded in this object — so it is
   * constructed here and never reaches the deployed bindings map.
   */
  protected readonly backendEnv: BotStateEnv & {
    FROCK_AI?: FrockAiGatewayHostV1;
    WORKSPACE_FILES?: WorkspaceFilesV1;
    PACKAGE_CATALOG_ENTRIES?: BotSkillCatalogReaderV1;
    MEMORY_WORKSPACE_FILES?: WorkspaceFilesV1;
    MEMORY_PROJECTS?: MemoryProjectsV1;
    WORKSPACE_SYNC_FILES?: WorkspaceFilesV1;
    WORKSPACE_SYNC_EFFECTS?: WorkspaceSyncEffectsV1;
    WORKSPACE_SYNC_GENERATIONS?: WorkspaceGenerationsV1;
    /** The User-scoped transcript index a settled Turn projects into. */
    SEARCH_SINK?: SearchSinkV1;
    /** The User-scoped audit table this object's outbox drains into. */
    AUDIT_SINK?: AuditSinkV1;
  };
  /** The identity the Workspace and Memory surfaces above were built for. */
  private surfacesFor: string | undefined;
  /**
   * This object's generation ledger — one instance, for every root it owns.
   *
   * "The Bot's Durable Object is the authority for everything Bot-scoped", and
   * an authority that exists twice is not one: each instance caches the
   * minting cursor while resident, so two of them can mint the same id for two
   * different files.
   */
  protected readonly workspaceGenerations: DurableWorkspaceGenerations =
    new DurableWorkspaceGenerations({ state: this.ctx });
  /** Durable invalidation log plus hibernatable observer transport. */
  private readonly stateChannel = new BotStateChannel(this.ctx);
  private mounted:
    | Promise<{
        shell: ShellBotBackendContribution;
        flock: FlockBotBackendContribution;
        computer: ComputerBotBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  constructor(
    ctx: DurableObjectState,
    env: BotStateEnv,
    dependencies: BotStateDependencies = {},
  ) {
    super(ctx, env);
    this.compileApplication =
      dependencies.compileApplication ?? compileFoundationApplication;
    this.outboundFetch = dependencies.outboundFetch;
    // The surfaces are built per identity in `bindSurfaces`, not here: they
    // carry the `owner` guard, and a Durable Object learns which User it
    // serves from the RPC that addresses it, never from its constructor.
    this.backendEnv = {
      ...env,
      ...(isFrockAiGatewayBindingV1(env.AI)
        ? {
            FROCK_AI: createFrockAiGatewayHostV1(env.AI, {
              gatewayId: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_ID"),
              autoRoute: frockAiWorkerVarV1(env, "FROCK_AI_AUTO_ROUTE"),
              accountId: frockAiWorkerVarV1(env, "FROCK_AI_ACCOUNT_ID"),
              token: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_TOKEN"),
            }),
          }
        : {}),
    };
  }

  private contributions(): Promise<{
    shell: ShellBotBackendContribution;
    flock: FlockBotBackendContribution;
    computer: ComputerBotBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      const pending = this.compileApplication().then(async (plan) => {
        const root = new Context();
        await root.plugin(ComputerRegistry);
        const computerConfigured = Boolean(
          this.backendEnv.COMPUTER_HOST &&
          this.backendEnv.COMPUTER_HOST_TOKEN?.trim(),
        );
        await root.plugin(
          createFlySpriteProviderPlugin(undefined, {
            ...(computerConfigured
              ? {
                  host: (identity, tenant) =>
                    new ComputerHostClient({
                      fetcher: this.backendEnv.COMPUTER_HOST!,
                      hostToken: this.backendEnv.COMPUTER_HOST_TOKEN!,
                      identity,
                      tenant,
                    }),
                }
              : {}),
          }),
        );
        // Where each descriptor's mounted value lands as the mount runs. The
        // Shell and Flock Contributions need each other, and each reaches the
        // other by naming the table entry it imported.
        const mountedContributions = createFoundationMountedContributionsV1();
        const requireShell = (): ShellBotBackendContribution => {
          const shell = mountedContributions.get(shellBotContribution);
          if (!shell) throw new Error("Shell Bot Contribution is unavailable");
          return shell;
        };
        const mounted = await createFoundationBackendContributions<
          | ShellBotBackendContribution
          | FlockBotBackendContribution
          | ComputerBotBackendContribution
        >(
          plan,
          {
            backendHost: "bot",
            mountedContributions,
            shell: {
              state: this.ctx,
              env: this.backendEnv,
              outboundFetch: this.outboundFetch,
              // One application, compiled once: the Contributions mounted here
              // and the Composition the Shell bootstraps have to be the same
              // plan, or a member could be in one and not the other.
              compileApplication: this.compileApplication,
              // The immutable bytes of every first-party artifact-backed
              // member the application ships (ADR 0022 decision 8). The store
              // reads object storage first and falls back to these, so a
              // deploy needs no seeding step for a Package that is already in
              // this bundle.
              bundledPackageArtifacts: FIRST_PARTY_PACKAGE_ARTIFACTS_V1,
              // The Durable Object owns the kernel authority; the Shell
              // Package supplies only its configuration and Composition
              // hooks.
              // The authority writes through the channel's storage facade, so
              // every committed run write pushes a `runs` invalidation to
              // attached browsers. The kernel is unaware it is observed.
              createAuthority: (options) =>
                new BotDurableAuthority({
                  ...options,
                  state: this.stateChannel.observeRuns(options.state),
                }),
              // The Computer Contribution's projection cache and its share of
              // the authority's one durable alarm, reached through the table
              // once it has mounted.
              invalidateComputerProjectionFile: (userId, botId, kind) => {
                mountedContributions
                  .get(computerBotContribution)
                  ?.invalidateProjectionFile(userId, botId, kind);
                // Dropping the resident cache only makes the next read
                // honest. The notice is what makes an attached browser take
                // that read, so a capture filed mid-Turn reaches the card in
                // about a second instead of at the next projection poll.
                this.stateChannel.noticeComputer();
              },
              scheduledDeadlines: (transaction) =>
                mountedContributions
                  .get(computerBotContribution)
                  ?.scheduledDeadlines(transaction) ?? Promise.resolve([]),
              scheduledWorkInFlight: () =>
                mountedContributions
                  .get(computerBotContribution)
                  ?.scheduledWorkInFlight() ?? false,
              deferScheduledWork: (transaction) =>
                mountedContributions
                  .get(computerBotContribution)
                  ?.deferScheduledWork(transaction) ?? Promise.resolve(),
              settleScheduledWork: () =>
                mountedContributions
                  .get(computerBotContribution)
                  ?.settleScheduledWork() ?? Promise.resolve(),
              // An archived Bot admits no configuration command; the Flock
              // Contribution owns that durable lifecycle state.
              assertLifecycleActive: (storage, botId) => {
                const flock = mountedContributions.get(flockBotContribution);
                if (!flock) {
                  throw new Error("Flock Bot Contribution is unavailable");
                }
                return flock.assertActive(storage, botId);
              },
            },
            flock: {
              storage: this.ctx.storage,
              materializeSettings: async (registration, userId) => {
                await requireShell().materializeSettings(
                  { userId, botId: registration.botId },
                  {
                    name: registration.initialName,
                    ...(registration.initialDescription === undefined
                      ? {}
                      : { description: registration.initialDescription }),
                  },
                );
              },
              archiveEligible: (storage) =>
                requireShell().archiveEligible(storage),
              tearDown: (identity) => this.tearDown(identity),
            },
            computer: {
              storage: this.stateChannel.computerStorage,
              workspace: this.backendEnv.WORKSPACE_FILES,
              providerLabel: "Computer",
              configured: computerConfigured,
              openComputer: (userId, botId, effectId) => {
                const identity = { userId };
                if (!root.computers.assignment(identity)) {
                  root.computers.assign(identity, "fly-sprite");
                }
                return root.computers.open(identity, { botId }, { effectId });
              },
            },
          },
          root,
        );
        // The kernel-declared required core set for a Bot, expressed against
        // the plan's own Contributions: every Bot-host Contribution the plan
        // declares must have mounted, and each of the three the Bot Durable
        // Object depends on must be one of them. A Composition that lacks one
        // never becomes resident.
        const shell = mounted.get(shellBotContribution);
        const flock = mounted.get(flockBotContribution);
        const computer = mounted.get(computerBotContribution);
        if (
          !shell ||
          !flock ||
          !computer ||
          mounted.contributions.length !==
            plannedFoundationBackendContributions(plan).filter(
              (planned) => planned.host === "bot",
            ).length
        ) {
          await mounted.dispose();
          await root.fiber.dispose();
          throw new Error(
            "Foundation requires Shell, Flock and Computer Bot backend Contributions",
          );
        }
        const alarmOwner = shell;
        this.stateChannel.setAlarmRefresher((transaction) =>
          alarmOwner.refreshScheduledWork(transaction),
        );
        return {
          shell,
          flock,
          computer,
          async dispose() {
            await mounted.dispose();
            await root.fiber.dispose();
          },
        };
      });
      this.mounted = pending;
      // A mount that failed is not a durable verdict. Memoizing the rejection
      // made one transient failure — an artifact read, a User RPC, a member
      // that would not resolve — final for the life of the object: every
      // later call awaited the same rejected promise, the recovery alarm
      // included, so nothing could heal it short of eviction. The next call
      // retries instead, exactly as `immutable-application.ts` already does.
      void pending.catch(() => {
        if (this.mounted === pending) this.mounted = undefined;
      });
    }
    return this.mounted;
  }

  private async registration(identity: {
    userId: string;
    botId: string;
  }): Promise<BotRegistrationV1> {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot infer its generated Flock RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      getBotRegistration(input: unknown): Promise<BotRegistrationV1>;
    };
    return decodeBotRegistrationV1(
      structuredClone(
        await rpc.getBotRegistration({ schemaVersion: 1, ...identity }),
      ),
    );
  }

  /** The User Durable Object, as this object's Memory authority. */
  private userMemoryRpc(userId: string): UserMemoryRpc {
    const id = this.env.USER_CONFIGURATIONS.idFromName(userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot
    // infer its generated Memory RPC surface.
    return this.env.USER_CONFIGURATIONS.get(id) as unknown as UserMemoryRpc;
  }

  /**
   * Builds the Workspace and Memory file surfaces for one identity.
   *
   * Three surfaces, deliberately, because the store refuses to be two things
   * at once: `WORKSPACE_FILES` is the kernel surface and refuses every Memory
   * root; `MEMORY_WORKSPACE_FILES` is the Memory Package's and serves Memory
   * roots and nothing else; `WORKSPACE_SYNC_FILES` is the durable-root sync's,
   * the only surface that reads every root and the only one that accepts an
   * `unattributed` writer — a shell wrote the file and nothing recorded who.
   * The Memory surface routes a shared root's generations to the User Durable
   * Object, because "The User's Durable Object is the authority for ... the
   * generation records of User and Project Memory roots", while the Bot's own
   * Memory root stays in this object.
   *
   * The sync's effect records stay here too: a push records its intent in the
   * Bot's Durable Object before it runs (§ Computer and Workspace), so an
   * interrupted push is read back rather than repeated.
   */
  protected bindSurfaces(identity: { userId: string; botId: string }): void {
    const key = `${identity.userId}\u0000${identity.botId}`;
    if (this.surfacesFor === key) return;
    const owner = { userId: identity.userId };
    // One ledger per Durable Object, shared by every surface it builds. A
    // ledger caches its minting cursor while resident, so two instances on one
    // object can read one cursor and mint one generation id twice — two files
    // claiming one generation, which is the single thing the id exists to
    // prevent. The routed ledger is one instance too: the same Bot half serves
    // the Memory and sync surfaces, and only a shared Memory root is routed to
    // the User object.
    const bot = this.workspaceGenerations;
    const workspace = createDurableWorkspaceFilesV1(this.env, {
      owner,
      generations: bot,
    });
    const rpc = this.userMemoryRpc(identity.userId);
    const routed = createRoutedWorkspaceGenerationsV1({
      bot,
      user: createUserWorkspaceGenerationsV1(rpc, identity.userId),
    });
    const memory = createDurableWorkspaceFilesV1(this.env, {
      owner,
      surface: "memory",
      generations: routed,
    });
    const sync = createDurableWorkspaceFilesV1(this.env, {
      owner,
      surface: "sync",
      generations: routed,
    });
    if (workspace) this.backendEnv.WORKSPACE_FILES = workspace;
    // The Catalog reader is identity-independent, but it is bound here beside
    // the other constructed surfaces so the Shell Package reads one
    // environment and names no Cloudflare type.
    if (this.env.PACKAGE_CATALOG && !this.backendEnv.PACKAGE_CATALOG_ENTRIES) {
      this.backendEnv.PACKAGE_CATALOG_ENTRIES = new R2PackageCatalog(
        this.env.PACKAGE_CATALOG,
      );
    }
    if (sync) {
      this.backendEnv.WORKSPACE_SYNC_FILES = sync;
      this.backendEnv.WORKSPACE_SYNC_EFFECTS = new DurableWorkspaceSyncEffects({
        state: this.ctx,
      });
      this.backendEnv.WORKSPACE_SYNC_GENERATIONS = routed;
    }
    if (memory) {
      this.backendEnv.MEMORY_WORKSPACE_FILES = memory;
      this.backendEnv.MEMORY_PROJECTS = createUserMemoryProjectsV1(
        rpc,
        identity,
      );
    }
    // The transcript index is User-scoped state, so its authority is the User
    // Durable Object and this object reaches it through a narrow binding —
    // the same shape as `MEMORY_PROJECTS` above. It is a projection, never an
    // authority, so nothing here waits on it and nothing here reads from it.
    this.backendEnv.SEARCH_SINK = createUserSearchSinkV1(
      rpc as unknown as UserSearchRpc,
      identity,
    );
    // The audit table is User-scoped too, and reached the same way — but
    // through a durable outbox rather than fire-and-forget, because
    // completeness is the parity item (register row 30b).
    this.backendEnv.AUDIT_SINK = createUserAuditSinkV1(
      rpc as unknown as UserAuditRpc,
      identity,
    );
    this.surfacesFor = key;
  }

  /**
   * Everything this Bot owns, destroyed. The Flock Contribution calls this on
   * `bot/delete` and writes its tombstone afterwards.
   *
   * Order matters. The alarm goes first: this object's single alarm is
   * multiplexed by the kernel authority over the active run, the Routine
   * schedules and the Computer's scheduled work, and every one of those
   * deadlines is about to stop existing — an alarm left armed would wake a Bot
   * with no state to recover. The durable keys go next, in one `deleteAll()`:
   * the session event log and its runs, the transcript and conversations, the
   * Bot's Memory and Skills generation ledger, Routines and their schedules,
   * Subagent tasks, approvals, notifications, unread and sidebar preview, the
   * Package composition generations, the Applet mirror, and the state-channel
   * log. Then the two object-store roots the Bot owns, which are the only
   * Bot-scoped state that does not live in this object.
   *
   * The mount memo is dropped last so the next call to this object rebuilds
   * from empty storage, reads the tombstone the caller is about to write, and
   * refuses rather than materializing the Bot again. Dropping it also
   * guarantees no surviving Contribution re-arms the alarm from a stale
   * transaction.
   *
   * Idempotent, because the delete saga replays: an empty object has nothing
   * to delete and an empty prefix has nothing to list.
   */
  private async tearDown(identity: {
    userId: string;
    botId: string;
  }): Promise<void> {
    // The channel is silenced before either, and for the same reason the alarm
    // goes first: a `runs` notice is deferred behind its throttle, so a delete
    // can land while one is still waiting to write. Left running, that notice
    // finished after `deleteAll()` and put `bot-state-channel:meta:v1` and an
    // event back into a tombstoned object — storage the teardown had just
    // removed, describing runs that no longer exist.
    this.stateChannel.silence();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await deleteBotWorkspaceRootsV1(this.env, identity);
    this.mounted = undefined;
    this.surfacesFor = undefined;
  }

  private async materialized(identity: { userId: string; botId: string }) {
    this.bindSurfaces(identity);
    const contributions = await this.contributions();
    const registration = await this.registration(identity);
    await contributions.flock.materialize(registration, identity.userId);
    return { ...contributions, registration };
  }

  private async contribution(): Promise<ShellBotBackendContribution> {
    return (await this.contributions()).shell;
  }

  async readConfiguration(input: unknown) {
    const request = decodeBotConfigurationReadRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return shell.readConfiguration(request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return shell.executeConfiguration(request);
  }

  /** A non-waking projection of this Bot's durable Computer presence. */
  async readComputerPresence(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return computer.read(identity.userId, identity.botId);
  }

  /** One durably admitted User command against this Bot's Computer. */
  async executeComputerPresenceCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeComputerCommandV1),
    });
    if (
      typeof request.userId !== "string" ||
      typeof request.botId !== "string"
    ) {
      throw new Error("Computer command RPC identity was not decoded");
    }
    const command = decodeComputerCommandV1(request.command);
    const identity = {
      userId: request.userId,
      botId: request.botId,
    };
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return computer.execute(identity.userId, identity.botId, command);
  }

  async readSheep(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.read(registration, identity.userId);
  }

  async updateSheep(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateSheepCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    return flock.update(
      registration,
      identity.userId,
      request.command as ReturnType<typeof decodeUpdateSheepCommandV1>,
    );
  }

  async readLifecycle(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.readLifecycle(registration, identity.userId);
  }

  async executeLifecycle(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeBotLifecycleCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const command = request.command as BotLifecycleCommandV1;
    if (command.botId !== identity.botId)
      throw new Error("lifecycle command does not match Bot authority");
    const { flock, registration } = await this.materialized(identity);
    return flock.executeLifecycle(registration, identity.userId, command);
  }

  /**
   * D6: model invocation as a User-enabled binding. Without the resolved
   * model binding the answer is unavailable; with one, the
   * request is recorded and the credential lease taken through the existing
   * provider path before any event is streamed back.
   */
  async isolateInvokeModel(input: unknown) {
    const request = decodeIsolateCallRpcV1(
      input,
      decodeNormalizedModelRequestV1,
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const shell = await this.contribution();
    return shell.isolateInvokeModel(identity, {
      runId: request.runId as string,
      sessionId: request.sessionId as string,
      turnId: request.turnId as string,
      packageId: request.packageId as string,
      generationId: request.generationId as string,
      request: request.request as NormalizedModelRequest,
    });
  }

  async isolateInvokeTool(input: unknown) {
    return (await this.contribution()).isolateInvokeTool(
      decodeIsolateCallRpcV1(input, decodeIsolateToolRequestV1) as never,
    );
  }

  async isolateMemoryRead(input: unknown) {
    return (await this.contribution()).isolateMemoryRead(
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryReadRequestV1) as never,
    );
  }

  async isolateMemoryWrite(input: unknown) {
    return (await this.contribution()).isolateMemoryWrite(
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryWriteRequestV1) as never,
    );
  }

  async isolateMemoryForget(input: unknown) {
    return (await this.contribution()).isolateMemoryForget(
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryWriteRequestV1) as never,
    );
  }

  async isolateWorkspaceRead(input: unknown) {
    return (await this.contribution()).isolateWorkspaceRead(
      decodeIsolateCallRpcV1(input, decodeIsolateWorkspacePathV1) as never,
    );
  }

  async isolateWorkspaceList(input: unknown) {
    return (await this.contribution()).isolateWorkspaceList(
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceListRequestV1,
      ) as never,
    );
  }

  async isolateWorkspaceStat(input: unknown) {
    return (await this.contribution()).isolateWorkspaceStat(
      decodeIsolateCallRpcV1(input, decodeIsolateWorkspacePathV1) as never,
    );
  }

  async isolateWorkspaceWrite(input: unknown) {
    return (await this.contribution()).isolateWorkspaceWrite(
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceWriteRequestV1,
      ) as never,
    );
  }

  async isolateWorkspaceDelete(input: unknown) {
    return (await this.contribution()).isolateWorkspaceDelete(
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceDeleteRequestV1,
      ) as never,
    );
  }

  async isolateConnection(input: unknown) {
    return (await this.contribution()).isolateConnection(
      decodeIsolateCallRpcV1(input, (value) => {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 256
        ) {
          throw new Error("Connection id is invalid");
        }
        return value;
      }) as never,
    );
  }

  async isolateNotify(input: unknown) {
    return (await this.contribution()).isolateNotify(
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateNotificationRequestV1,
      ) as never,
    );
  }

  async isolateSchedule(input: unknown) {
    return (await this.contribution()).isolateSchedule(
      decodeIsolateCallRpcV1(input, decodeIsolateScheduleRequestV1) as never,
    );
  }

  async isolateApplets(input: unknown) {
    return (await this.contribution()).isolateApplets(
      decodeIsolateCallRpcV1(input, decodeIsolateAppletsRequestV1) as never,
    );
  }

  /** The Session's focused Applet (plan §6). One per Session by decision D10. */
  async readFocusedApplet(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    return (await this.contribution()).readFocusedApplet(identity);
  }

  async setFocusedApplet(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      appletId: rpcAppletIdOrNull,
    });
    return (await this.contribution()).setFocusedApplet(
      {
        userId: request.userId as string,
        botId: request.botId as string,
      },
      request.appletId as string | null,
    );
  }

  async resolveConfiguration(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.resolveConfiguration(identity);
  }

  async run(input: unknown) {
    const request = decodeBotRunRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    const turn = await shell.run({ ...identity, ...request.command });
    await this.projectSettledRun(shell, identity, request.command.runId);
    await this.projectSettledAudit(shell, identity, request.command.runId);
    return turn;
  }

  /** This object's bounded, durable audit outbox. */
  private auditOutbox(): AuditOutboxV1 {
    return new AuditOutboxV1(this.ctx.storage);
  }

  /**
   * Queues one settled run's audit entries and drains what is pending.
   *
   * Queue first, deliver second, and never the other way round: the entries
   * are durable in this object before the User object is asked for anything,
   * so a User object that is away, slow, or mid-eviction costs a retry rather
   * than a gap. Whatever a drain leaves behind is picked up by the next
   * settlement or by the alarm this object already has.
   */
  private async projectSettledAudit(
    shell: ShellBotBackendContribution,
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<void> {
    const sink = this.backendEnv.AUDIT_SINK;
    if (!sink) return;
    const outbox = this.auditOutbox();
    try {
      const lookup = await shell.lookupRun({ schemaVersion: 1, runId });
      if (lookup.state !== "not-admitted") {
        const stored = await shell.listRunEventPage();
        const run = stored.runs.find((candidate) => candidate.runId === runId);
        if (run) {
          await outbox.append(
            await auditEntriesFromStoredRunV1(identity.botId, run),
          );
        }
      }
    } catch {
      // A projection this object could not build is a gap a rebuild closes;
      // it is never a reason for an admitted Turn to look as if it failed.
    }
    await this.drainAuditOutbox();
  }

  /**
   * Hands whatever is pending to the User Durable Object.
   *
   * The failure is swallowed *here* and not inside the outbox: the outbox
   * throws so that nothing is cleared that was not delivered, and this call
   * site swallows so that a derived projection never decides whether a Turn
   * settled.
   */
  private async drainAuditOutbox(): Promise<void> {
    const sink = this.backendEnv.AUDIT_SINK;
    if (!sink) return;
    try {
      await this.auditOutbox().drain(sink);
    } catch {
      // Still pending, still durable, still visible as `pending` in the
      // outbox state the Activity surface reads.
    }
  }

  /**
   * One page of this Bot's audit entries, projected from its own stored runs.
   *
   * The durable session events rather than the client projection: the client
   * projection drops `call.input`, and the argument digest needs the exact
   * arguments.
   */
  async projectAuditEntries(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, botId: rpcBotId },
      { cursor: rpcString(512) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const cursor = request.cursor as string | undefined;
    return createBotAuditEntryPageV1(
      identity.botId,
      await shell.listRunEventPage(cursor),
    );
  }

  /**
   * Projects one settled run into the User's transcript index.
   *
   * After settlement, and never before it: the run is already durable in this
   * object, so an index write that fails costs a rebuild rather than a Turn.
   * The failure is swallowed for the same reason — a derived projection must
   * not decide whether the thing it derives from succeeded.
   */
  private async projectSettledRun(
    shell: ShellBotBackendContribution,
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<void> {
    const sink = this.backendEnv.SEARCH_SINK;
    if (!sink) return;
    try {
      const lookup = await shell.lookupRun({ schemaVersion: 1, runId });
      if (lookup.state === "not-admitted") return;
      await sink.indexRows(
        searchRowsFromClientRunV1(identity.botId, lookup.run),
      );
    } catch {
      // Visible as a gap the index state and a rebuild both report; never a
      // reason for an admitted Turn to look as if it failed.
    }
  }

  /**
   * One page of this Bot's rows, projected from its own stored runs.
   *
   * This is what makes the User's index disposable: every row it holds can be
   * read back out of the authority that owns the conversation.
   */
  async projectSearchRows(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, botId: rpcBotId },
      { cursor: rpcString(512) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const cursor = request.cursor as string | undefined;
    return createBotSearchRowPageV1(
      identity.botId,
      await shell.listRuns({
        schemaVersion: 1,
        ...(cursor === undefined ? {} : { before: cursor }),
      }),
    );
  }

  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover. A
   * read: it binds the Workspace surfaces the Turn path binds, and writes
   * nothing.
   */
  /**
   * One durable-root file, read from object storage.
   *
   * The Workspace read path the hosted client needs: a screenshot the Bot
   * filed under a Package-declared root is durable content, and a card that
   * renders it has to be able to fetch it without reaching a Computer. It
   * wakes none — this is R2 and this object's own generation ledger — which is
   * exactly why the durable-root sync exists.
   */
  async readWorkspaceFileV1(input: unknown): Promise<ClientWorkspaceFileV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      path: rpcDecoded(decodeWorkspacePathV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const files = this.backendEnv.WORKSPACE_FILES;
    if (!files) {
      return {
        schemaVersion: 1 as const,
        status: "unavailable" as const,
        reason: "This deployment binds no Workspace object store",
      };
    }
    const outcome = await files.read(request.path as WorkspacePathV1);
    if (outcome.status !== "ok") {
      return {
        schemaVersion: 1 as const,
        status: outcome.status,
        reason: outcome.reason,
      };
    }
    return {
      schemaVersion: 1 as const,
      status: "ok" as const,
      contentHash: outcome.file.generation.contentHash,
      size: outcome.file.generation.size,
      bytesBase64: bytesToBase64(outcome.file.bytes),
    };
  }

  /*
   * An Applet's source, for the canvas's building state.
   *
   * The Workspace store is read and nothing else: the Applets Package's
   * declared root is User-scoped, so this answers from object storage while
   * the Computer is hibernated, exactly as the plan requires ("the store is
   * read, never the Sprite"). Text only and bounded, because this is a
   * projection for a person watching a Bot write code, not a file transfer.
   */
  async readAppletSourceV1(input: unknown): Promise<AppletSourceViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      appletId: rpcPattern(APPLET_ID_V1, 129),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const appletId = request.appletId as string;
    const files = this.backendEnv.WORKSPACE_FILES;
    if (!files) return { appletId, files: [], truncated: false };
    const root: WorkspaceRootV1 = {
      kind: "package-declared",
      userId: identity.userId,
      packageId: APPLETS_SOURCE_PACKAGE_ID_V1,
      rootId: APPLETS_SOURCE_ROOT_ID_V1,
    };
    const listing = await files.list({
      root,
      prefix: appletId,
      limit: APPLET_SOURCE_MAX_FILES_V1,
    });
    if (listing.status !== "ok")
      return { appletId, files: [], truncated: false };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const source: AppletSourceViewV1["files"] = [];
    let bytes = 0;
    let truncated = listing.cursor !== undefined;
    for (const entry of listing.entries) {
      const relative = entry.path.path.slice(appletId.length + 1);
      if (!relative) continue;
      // `dist/` is what `applet build` wrote, not what the Bot wrote: the
      // canvas shows source, and the publish reads the build.
      if (relative === "dist" || relative.startsWith("dist/")) continue;
      if (bytes + entry.generation.size > APPLET_SOURCE_MAX_BYTES_V1) {
        truncated = true;
        continue;
      }
      const outcome = await files.read(entry.path);
      if (outcome.status !== "ok") continue;
      let text: string;
      try {
        text = decoder.decode(outcome.file.bytes);
      } catch {
        // A binary artifact under the root is not source; the canvas says
        // nothing about it rather than drawing mojibake.
        continue;
      }
      bytes += outcome.file.generation.size;
      source.push({
        path: relative,
        text,
        generationId: outcome.file.generation.generationId,
        changedAt: outcome.file.generation.writtenAt,
      });
    }
    return { appletId, files: source, truncated };
  }

  /**
   * The outcome the Bot last recorded for `applet check` or `applet build`.
   * Until the Applet authority records one, this is honestly `unknown` rather
   * than a green tick nobody earned.
   */
  async readAppletBuildV1(input: unknown): Promise<AppletBuildViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      appletId: rpcPattern(APPLET_ID_V1, 129),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return { status: "unknown" };
  }

  async listSkills(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.listSkills(identity);
  }

  async listPackageUi(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.listPackageUi(identity);
  }

  async runPackageUiTool(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodePackageIframeToolCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    const command =
      request.command as import("@frockbot/kernel-contracts").PackageIframeToolCommandV1;
    const turn = await shell.runPackageUiTool(identity, command);
    await this.projectSettledRun(shell, identity, command.commandId);
    await this.projectSettledAudit(shell, identity, command.commandId);
    return turn;
  }

  /**
   * Write one Skill into this Bot's instruction root as its **User**.
   *
   * The import path's only Bot-scoped write. It is the User's own authority —
   * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
   * instruction root — so an imported Skill is loadable on the Bot's first
   * Turn and its provenance records who put it there.
   */
  /**
   * A file written into one of the User's durable roots, as the User. The
   * gateway's seed door calls this in an environment with no Computer; see
   * `writeUserWorkspaceFile` on the Shell Contribution for why it is a User
   * write and nothing wider.
   */
  async writeUserWorkspaceFileV1(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        root: rpcDecoded(decodeWorkspaceRootV1),
        path: rpcString(1_024),
        bytesBase64: rpcString(8 * 1024 * 1024),
      },
      { mediaType: rpcString(128) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.writeUserWorkspaceFile(identity, {
      root: request.root as WorkspaceRootV1,
      path: request.path as string,
      bytes: Uint8Array.from(atob(request.bytesBase64 as string), (character) =>
        character.charCodeAt(0),
      ),
      ...(request.mediaType ? { mediaType: request.mediaType as string } : {}),
    });
  }

  async writeUserSkill(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      slug: rpcString(128),
      name: rpcString(100),
      description: rpcString(1_024),
      body: rpcString(64 * 1024),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.writeUserSkill(identity, {
      slug: request.slug as string,
      name: request.name as string,
      description: request.description as string,
      body: request.body as string,
    });
  }

  /**
   * This Bot's own instruction root, bodies included, for a template export.
   *
   * Read-only, and no wider than what the Turn loader already loads: the
   * managed set and the plugin-borne index are never walked, and a candidate
   * the authority predicate refuses is absent here too.
   */
  async listOwnSkillDocuments(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.listOwnSkillDocuments(identity);
  }

  async stopRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeClientRunStopCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.stopRun(identity, request.command as ClientRunStopCommandV1);
  }

  async reconcileRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      runId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.reconcileRun(identity, request.runId as string);
  }

  /** The Bot's unread projection; the Bot Durable Object derives the count. */
  async readUnread(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.readUnread(identity);
  }

  /** `bot/mark-read` / `bot/mark-unread`, idempotent on the command id. */
  async executeUnreadCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeBotUnreadCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.executeUnreadCommand(
      identity,
      request.command as BotUnreadCommandV1,
    );
  }

  /** The Bot's approvals, newest first, pending and decided alike. */
  async listApprovals(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.listApprovals(identity);
  }

  /**
   * One decision on one approval. First write wins: a replay answers with the
   * decision already recorded rather than overwriting it.
   */
  async decideApproval(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      approvalId: rpcIdentifier,
      command: rpcDecoded(decodeApprovalDecisionCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.decideApproval(
      identity,
      request.approvalId as string,
      request.command as ApprovalDecisionCommandV1,
    );
  }

  async listNotifications(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listNotifications();
  }

  async acknowledgeNotification(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      notificationId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.acknowledgeNotification(request.notificationId as string);
  }

  /**
   * The Bot's subagent tasks. Bot-scoped, so it proves directory membership the
   * same way the other Bot RPCs do: a Bot that is not this User's is not found.
   *
   * This is the *parent* object's answer. A Subagent Durable Object has no
   * route of its own and holds no task list: it holds one Session, and ADR 0017
   * leaves every authority here.
   */
  async listTasks(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listTasks(identity);
  }

  /** One task, by id. The parent object's answer; a child holds no list. */
  async readTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.readTask(identity, request.taskId as string);
  }

  /**
   * The User's own cancellation of one task.
   *
   * The same durable act `task_stop` performs, through a second authenticated
   * door: explicit, authenticated, and terminal — never a second mechanism.
   */
  async stopTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.stopTaskForUser(identity, request.taskId as string);
  }

  /** The Subagent Durable Object's cancellation door (ADR 0017). */
  async stopSubagentTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.stopSubagentTask(identity, request.taskId as string);
  }

  /**
   * The Subagent Durable Object's door (ADR 0017).
   *
   * It records the task and arms its own alarm; the Turn runs on that alarm.
   * The parent is still inside the Turn that dispatched when this returns, so
   * anything longer than a write here would block it.
   */
  async runTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      request: rpcDecoded(decodeSubagentRunTaskRequestV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.acceptSubagentTask(
      identity,
      request.request as SubagentRunTaskRequestV1,
    );
  }

  /** What a Subagent Durable Object holds for one task, for reconciliation. */
  async readSubagentTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.readSubagentTaskContext(request.taskId as string);
  }

  /**
   * The messages a parent has queued for one of its tasks, claimed by the
   * child that is running it (ADR 0017).
   *
   * The claim marks what it hands over in the parent's own transaction, so a
   * child that retries a step reads the marks back rather than the message.
   */
  async claimTaskMessages(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.claimTaskMessages(identity, request.taskId as string);
  }

  /** One terminal task outcome, recorded on the parent. Idempotent per task. */
  async settleTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
      outcome: rpcDecoded(decodeTaskOutcomeV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.settleTask(
      identity,
      request.taskId as string,
      request.outcome as TaskOutcomeV1,
    );
  }

  /**
   * The Bot's Routines. Bot-scoped, so it proves directory membership the same
   * way the other Bot RPCs do: a Bot that is not this User's is not found.
   */
  async listRoutines(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRoutines(identity);
  }

  /** One Routine command, applied durably with the User recorded as writer. */
  async executeRoutineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRoutineCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.executeRoutineCommand(
      identity,
      request.command as RoutineCommandV1,
    );
  }

  /**
   * One webhook delivery, forwarded by the gateway after it verified the key's
   * signature. The Bot re-checks the key against its own durable record: the
   * edge proved the token was minted by this deployment, not that it is still
   * this Routine's key.
   *
   * Directory membership is deliberately *not* proved here. The caller is an
   * external system with no session; the key is the whole credential, and it
   * names the User the token was minted for.
   */
  async deliverRoutineHook(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      delivery: rpcDecoded(decodeRoutineHookDeliveryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.deliverRoutineHook(request.delivery as RoutineHookDeliveryV1);
  }

  /**
   * One finished machine command, handed over by the Worker that answered the
   * machine.
   *
   * It names the Bot the command record named — a Bot cannot be told about a
   * command it never asked for, because it is the command that carries the
   * `botId`.
   */
  async deliverMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      delivery: rpcDecoded(decodeMachineResultDeliveryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.deliverMachineResult(
      request.delivery as MachineResultDeliveryV1,
    );
  }

  /** One Routine's bounded run log, newest first. */
  async listRoutineRuns(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRoutineRuns(identity, request.routineId as string);
  }

  /**
   * One automation run, read-only. It is not in the visible transcript and
   * never will be; the Routine's run log is the only door to it.
   */
  async readRoutineRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
      runId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.readRoutineRun(
      identity,
      request.routineId as string,
      request.runId as string,
    );
  }

  /** The completion inbox: what the Bot's firings left for its User. */
  async listRoutineInbox(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRoutineInbox(identity);
  }

  /** Acknowledging inbox entries; an explicit command, never a read. */
  async executeRoutineInboxCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRoutineInboxCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.executeRoutineInboxCommand(
      identity,
      request.command as RoutineInboxCommandV1,
    );
  }

  /**
   * The Bot's durable Composition generations, newest first. Bot-scoped, so it
   * proves directory membership the same way the other Bot RPCs do.
   */
  async listCompositionGenerations(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcObject(
        {
          limit: rpcInteger({
            minimum: 1,
            maximum: MAX_COMPOSITION_GENERATION_PAGE_V1,
          }),
        },
        { cursor: rpcString(512) },
      ),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listCompositionGenerations(
      identity,
      request.query as { limit: number; cursor?: string },
    );
  }

  /**
   * One generation, including the recorded source of each isolate member once
   * authoring records exist (plan Step 5); the member list until then.
   */
  async getCompositionGeneration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      generationId: rpcDecoded(decodeCompositionGenerationIdV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.getCompositionGeneration(
      identity,
      request.generationId as string,
    );
  }

  /** Reverting records a new pending generation; it never mutates a record. */
  async revertComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRevertCompositionCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const command = request.command as RevertCompositionCommandV1;
    if (command.botId !== identity.botId) {
      throw new Error("Composition revert command does not match its Bot");
    }
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.revertComposition(identity, command);
  }

  async listConversations(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listConversations();
  }

  async startConversation(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.startConversation(identity);
  }

  async listRuns(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunListQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRuns(request.query as ClientRunListQueryV1);
  }

  /**
   * The operator snapshot behind `/api/debug`. Bot-scoped like every other
   * Bot RPC — the debug token authorizes the *caller*, it does not widen what
   * a Bot will answer about itself.
   */
  async debugSnapshot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeBotDebugQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.debugSnapshot(identity, request.query);
  }

  async lookupRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.lookupRun(request.query as ClientRunLookupQueryV1);
  }

  async fenceRunAdmission(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.fenceRunAdmission(
      identity,
      request.query as ClientRunLookupQueryV1,
    );
  }

  async alarm(): Promise<void> {
    // The outbox drain is in a `finally` for the same reason the kernel's
    // re-arm is: it is the audit trail's second chance, and a throw anywhere in
    // the Bot's own settlement must not be what stops entries leaving.
    //
    // Both halves are then wrapped: an alarm has no caller, so anything that
    // escapes here is an uncaught exception in the object — which is one of the
    // ways the dev Worker died. The alarm is rescheduled by whatever owns it,
    // so recording the failure and letting the next firing try again is the
    // whole of the recovery.
    await loggedEntryV1("Bot alarm", async () => {
      try {
        await (await this.contribution()).alarm();
      } finally {
        // The alarm the Bot already has is also the audit outbox's second
        // chance: entries a settlement could not deliver leave on the next
        // firing rather than waiting for the Bot to be spoken to again.
        await loggedEntryV1("Bot audit outbox drain", () =>
          this.drainAuditOutbox(),
        );
      }
    });
  }

  /**
   * Internal fetch surface reached only after the gateway authenticates
   * ownership.
   *
   * This is the state-channel upgrade, and it is where a `BotNotFoundError`
   * escaped and took the dev Worker down twice: a Durable Object's own `fetch`
   * is an entry point, so a throw here has no caller inside the object to catch
   * it. A Bot that is not there is a 404, and every other failure is a 500 that
   * still carries a reason.
   */
  fetch(request: Request): Promise<Response> {
    return answeredEntryV1("Bot-state channel failed", () =>
      this.#openChannel(request),
    );
  }

  async #openChannel(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== BOT_STATE_CHANNEL_INTERNAL_PATH) {
      return new Response("Not found", { status: 404 });
    }
    const userId = request.headers.get("x-frockbot-user-id");
    const botId = request.headers.get("x-frockbot-bot-id");
    if (!userId || !botId) {
      return Response.json(
        { error: "authenticated Bot identity required" },
        { status: 401 },
      );
    }
    const identity = { userId, botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return this.stateChannel.upgrade(request, identity);
  }

  // Three more entry points with no caller. A throw in any of them is an
  // uncaught exception in the object, and none of them has anybody to answer.
  webSocketMessage(
    socket: WebSocket,
    _message: string | ArrayBuffer,
  ): Promise<void> {
    return loggedEntryV1("Bot-state channel message", () =>
      this.stateChannel.message(socket),
    );
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    return loggedEntryV1("Bot-state channel close", () =>
      this.stateChannel.close(socket, code, reason),
    );
  }

  webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    return loggedEntryV1("Bot-state channel error", () =>
      this.stateChannel.error(socket),
    );
  }
}
