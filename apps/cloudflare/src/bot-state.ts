import { DurableObject } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationAssignedRuntimePackages,
  createFoundationBackendContributions,
  createFoundationHostedRuntimePackages,
  createFoundationRuntimeApplication,
} from "@frockbot/application-foundation/runtime";
import {
  createFoundationResidentRuntime,
  type FoundationResidentRuntime,
} from "@frockbot/agent-runtime/runtime";
import { Context } from "cordis";
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
import { createShellBotBackendPlugin } from "@frockbot/plugin-shell/backend";
import {
  createFlockBotBackendPlugin,
  type FlockBotBackendContribution,
} from "@frockbot/plugin-flock/bot";
import {
  decodeBotLifecycleCommandV1,
  decodeBotRegistrationV1,
  decodeUpdateSheepCommandV1,
  type BotLifecycleCommandV1,
  type BotRegistrationV1,
} from "@frockbot/plugin-flock/shared";
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
  decodeIsolateAuthorityRequestV1,
  decodeNormalizedModelRequestV1,
} from "@frockbot/kernel-contracts";
import type {
  NormalizedModelRequest,
  WorkspaceFilesV1,
  WorkspaceGenerationsV1,
  WorkspacePathV1,
  WorkspaceSyncEffectsV1,
} from "@frockbot/kernel-contracts";
import { decodeWorkspacePathV1 } from "@frockbot/kernel-contracts";

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
import { createDurableWorkspaceFilesV1 } from "./workspace.js";
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
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcObject,
  rpcString,
} from "./durable-rpc.js";

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
  return {
    userId: request.userId as string,
    botId: request.botId as string,
  };
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
  private mounted:
    | Promise<{
        shell: ShellBotBackendContribution;
        flock: FlockBotBackendContribution;
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
    this.backendEnv = { ...env };
  }

  private contributions(): Promise<{
    shell: ShellBotBackendContribution;
    flock: FlockBotBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      this.mounted = this.compileApplication().then(async (plan) => {
        let shell: ShellBotBackendContribution | undefined;
        let flock: FlockBotBackendContribution | undefined;
        const mounted = await createFoundationBackendContributions<
          ShellBotBackendContribution | FlockBotBackendContribution
        >(plan, {
          backendHost: "bot",
          resolve: (specifier, lifecycle) => {
            if (specifier === "@frockbot/plugin-shell/backend") {
              return createShellBotBackendPlugin(
                {
                  state: this.ctx,
                  env: this.backendEnv,
                  outboundFetch: this.outboundFetch,
                  // The Durable Object owns the kernel authority; the Shell
                  // Package supplies only its configuration and Composition
                  // hooks.
                  createAuthority: (options) =>
                    new BotDurableAuthority(options),
                  // An archived Bot admits no configuration command; the Flock
                  // Contribution owns that durable lifecycle state.
                  assertLifecycleActive: (storage, botId) => {
                    if (!flock) {
                      throw new Error("Flock Bot Contribution is unavailable");
                    }
                    return flock.assertActive(storage, botId);
                  },
                },
                {
                  mount(value) {
                    shell = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            if (specifier === "@frockbot/plugin-flock/bot") {
              return createFlockBotBackendPlugin(
                {
                  storage: this.ctx.storage,
                  materializeSettings: (registration, userId) => {
                    if (!shell)
                      throw new Error("Shell Bot Contribution is unavailable");
                    return shell
                      .materializeSettings(
                        { userId, botId: registration.botId },
                        {
                          name: registration.initialName,
                          ...(registration.initialDescription === undefined
                            ? {}
                            : {
                                description: registration.initialDescription,
                              }),
                          model: registration.initialModel,
                          modelBinding: registration.initialModelBinding,
                        },
                      )
                      .then(async (settings) => {
                        if (
                          registration.initialModel &&
                          registration.initialModelBinding &&
                          settings.assignments.some(
                            (assignment) =>
                              assignment.assignmentId ===
                              registration.initialModelBinding?.assignment
                                .assignmentId,
                          )
                        ) {
                          await this.acknowledgeInitialModelBinding(
                            userId,
                            registration,
                          );
                        }
                      });
                  },
                  archiveEligible: (storage) => {
                    if (!shell)
                      throw new Error("Shell Bot Contribution is unavailable");
                    return shell.archiveEligible(storage);
                  },
                },
                {
                  mount(value) {
                    flock = value;
                    return lifecycle.mount(value);
                  },
                },
              );
            }
            throw new Error(`Unsupported Bot Contribution: ${specifier}`);
          },
        });
        if (!shell || !flock || mounted.contributions.length !== 2) {
          await mounted.dispose();
          throw new Error(
            "Foundation requires Shell and Flock Bot backend Contributions",
          );
        }
        return { shell, flock, dispose: mounted.dispose };
      });
    }
    return this.mounted;
  }

  private async acknowledgeInitialModelBinding(
    userId: string,
    registration: BotRegistrationV1,
  ): Promise<void> {
    const binding = registration.initialModelBinding;
    const model = registration.initialModel;
    if (!binding || !model) return;
    const id = this.env.USER_CONFIGURATIONS.idFromName(userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot infer its generated dependency RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      acknowledgeConnectionDependency(input: unknown): Promise<boolean>;
    };
    if (
      !(await rpc.acknowledgeConnectionDependency({
        schemaVersion: 1,
        userId,
        connectionId: model.connectionId,
        botId: registration.botId,
        generation: binding.generation,
      }))
    ) {
      throw new Error("Initial model dependency was not acknowledged");
    }
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
   * The Bot isolate asked for authority it does not hold. The answer is never
   * a grant: the Bot Durable Object records a durable pending decision and
   * returns its id (plan Step 4, "Self-modification never widens authority").
   */
  async isolateRequestAuthority(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      packageId: rpcIdentifier,
      generationId: rpcIdentifier,
      request: rpcDecoded(decodeIsolateAuthorityRequestV1),
    });
    // The isolate capability path needs the Bot's own authority, not its Flock
    // projection, so it does not materialize the Sheep record.
    const shell = await this.contribution();
    return shell.isolateRequestAuthority({
      botId: request.botId as string,
      packageId: request.packageId as string,
      generationId: request.generationId as string,
      request: request.request,
    });
  }

  /**
   * D6: model invocation as an Assignment-derived binding. Without a matching
   * enabled model Assignment the answer is a pending decision; with one, the
   * request is recorded and the credential lease taken through the existing
   * provider path before any event is streamed back.
   */
  async isolateInvokeModel(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      packageId: rpcIdentifier,
      generationId: rpcIdentifier,
      request: rpcDecoded(decodeNormalizedModelRequestV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const shell = await this.contribution();
    return shell.isolateInvokeModel(identity, {
      packageId: request.packageId as string,
      generationId: request.generationId as string,
      request: request.request as NormalizedModelRequest,
    });
  }

  async markConnectionUnavailable(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      connectionId: rpcIdentifier,
      compensation: rpcObject({
        id: rpcIdentifier,
        expectedGeneration: rpcIdentifier,
      }),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.markConnectionUnavailable(
      identity,
      request.connectionId as string,
      request.compensation as { id: string; expectedGeneration: string },
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

  async listSkills(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return shell.listSkills(identity);
  }

  /**
   * Write one Skill into this Bot's instruction root as its **User**.
   *
   * The import path's only Bot-scoped write. It is the User's own authority —
   * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
   * instruction root — so an imported Skill is loadable on the Bot's first
   * Turn and its provenance records who put it there.
   */
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
    await (await this.contribution()).alarm();
    // The alarm the Bot already has is also the audit outbox's second chance:
    // entries a settlement could not deliver leave on the next firing rather
    // than waiting for the Bot to be spoken to again.
    await this.drainAuditOutbox();
  }
}
