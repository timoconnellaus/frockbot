import type {
  ApprovalDecisionReceiptV1,
  ApprovalListViewV1,
} from "@frockbot/plugin-shell/approvals";
import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import type { ConnectionCommandReceiptV1 } from "@frockbot/connection-core";
import { createSettingsBackendContribution } from "@frockbot/plugin-settings/backend";
import { applyBotProfilePatchV1 } from "@frockbot/configuration-core";
import type {
  BotConfigurationReadRpcV1,
  BotSettingsViewV1,
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
  UserConfigurationReadRpcV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { StoredRun } from "@frockbot/plugin-shell/backend-contracts";
import type { DeploymentPolicyV1 } from "@frockbot/plugin-admin/shared";
import { createFlockBackendContribution } from "@frockbot/plugin-flock/backend";
import {
  bootstrapCompositionGeneration,
  createShellCompositionHost,
} from "@frockbot/plugin-shell/backend-composition";
import { executeBotTurn } from "@frockbot/plugin-shell/backend-runner";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import { randomSheepRecipeV1 } from "@frockbot/plugin-flock/shared";
import {
  createClientRunStopReceiptV1,
  decodeClientRunLookupV1,
  decodeClientRunListV1,
  decodeClientRunStopReceiptV1,
  decodeClientTurnV1,
  projectClientRunLookupV1,
  projectClientRunListV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupQueryV1,
  type ClientRunLookupV1,
  type ClientRunListQueryV1,
  type ClientRunListV1,
  type ClientRunStopCommandV1,
  type ClientRunStopReceiptV1,
} from "@frockbot/plugin-shell/run-protocol";
import type {
  BotNotificationIntent,
  BotConfigurationBinding,
  BotStateBinding,
  BotTurnCommand,
  BotTurnResult,
  CatalogGatewayStore,
  ConnectionBinding,
  GatewayAuth,
  GatewayDependencies,
  LoadedWorker,
  UserBotStateBinding,
  UserConfigurationBinding,
  WorkerCode,
  WorkerLoader,
} from "./contracts.js";
import { RoutineStore } from "@frockbot/plugin-routines/store";
import { RoutineInboxStore } from "@frockbot/plugin-routines/inbox-store";
import { createMemoryRoutineStorageV1 } from "@frockbot/plugin-routines/testing";
import { executeResidentBotTurn } from "./bot-runner.js";
import { applicationDeploymentId, createGateway } from "./gateway.js";
import { createUserApplication } from "./user-application.js";

class MemoryBotState implements BotStateBinding {
  private readonly runs = new Map<string, StoredRun[]>();
  private readonly sessions = new Map<string, SessionEvent[]>();
  private readonly admissionFences = new Set<string>();
  readonly notifications = new Map<string, BotNotificationIntent[]>();

  async run(botId: string, command: BotTurnCommand): Promise<BotTurnResult> {
    if (this.admissionFences.has(`${botId}:${command.runId}`)) {
      throw new Error(`run "${command.runId}" admission was fenced`);
    }
    const runs = this.runs.get(botId) ?? [];
    const existing = runs.find(
      (candidate) => candidate.runId === command.runId,
    );
    if (existing?.status === "completed") {
      return projectClientTurnV1({
        runId: existing.runId,
        text: existing.responseText ?? "",
        events: structuredClone(existing.events),
      });
    }
    if (existing) throw new Error("duplicate run is still active");
    if (runs.some((candidate) => candidate.status === "running")) {
      throw new Error("bot already has an active run");
    }
    const previousEvents = this.sessions.get(botId) ?? [];
    const generation = await bootstrapCompositionGeneration(
      await compileFoundationApplication(),
      "2026-01-01T00:00:00.000Z",
    );
    const run: StoredRun = {
      runId: command.runId,
      commandFingerprint: "internal-command-fingerprint",
      sessionId: command.sessionId,
      acceptedAt: command.acceptedAt,
      input: command.text,
      events: [],
      effectAdmissions: [],
      status: "running",
      phase: "admitted",
      compositionGenerationId: generation.generationId,
      configurationSnapshot: {
        schemaVersion: 1,
        botId,
        revision: 0,
        profile: { name: "Internal Bot configuration" },
        notifications: { enabled: false },
        packageValues: {},
      },
      previousEventCount: previousEvents.length,
    };
    runs.push(run);
    this.runs.set(botId, runs);
    try {
      const composition = await createShellCompositionHost({
        botId,
        sessionId: command.sessionId,
        sessionEvents: previousEvents,
        admitEffect: () => Promise.resolve(true),
      }).mount(generation, new AbortController().signal);
      const result = await executeBotTurn({
        command,
        previousEvents,
        composition,
      });
      run.events = structuredClone(result.events);
      run.status = "completed";
      run.responseText = result.text;
      this.sessions.set(botId, [...previousEvents, ...result.events]);
      return projectClientTurnV1(result);
    } catch (error) {
      run.status = "failed";
      run.failure = error instanceof Error ? error.message : "Bot turn failed";
      throw error;
    }
  }

  listRuns(
    botId: string,
    _query: ClientRunListQueryV1,
  ): Promise<ClientRunListV1> {
    return Promise.resolve(
      projectClientRunListV1(structuredClone(this.runs.get(botId) ?? [])),
    );
  }

  lookupRun(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1> {
    return Promise.resolve(
      projectClientRunLookupV1(
        structuredClone(this.runs.get(botId) ?? []).find(
          (run) => run.runId === query.runId,
        ),
      ),
    );
  }

  fenceRunAdmission(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1> {
    const run = structuredClone(this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === query.runId,
    );
    if (!run) this.admissionFences.add(`${botId}:${query.runId}`);
    return Promise.resolve(projectClientRunLookupV1(run));
  }

  storedRuns(botId: string): StoredRun[] {
    return structuredClone(this.runs.get(botId) ?? []);
  }

  /** Approvals are Bot-scoped durable state; this double keeps none. */
  listApprovals(botId: string): Promise<ApprovalListViewV1> {
    return Promise.resolve({
      schemaVersion: 1,
      botId,
      approvals: [],
      pending: 0,
    });
  }

  decideApproval(): Promise<ApprovalDecisionReceiptV1> {
    return Promise.reject(new Error("approvals are not wired in this test"));
  }

  listNotifications(botId: string): Promise<BotNotificationIntent[]> {
    return Promise.resolve(
      structuredClone(this.notifications.get(botId) ?? []),
    );
  }

  acknowledgeNotification(
    botId: string,
    notificationId: string,
  ): Promise<void> {
    this.notifications.set(
      botId,
      (this.notifications.get(botId) ?? []).filter(
        (notification) => notification.notificationId !== notificationId,
      ),
    );
    return Promise.resolve();
  }

  stopRun(
    botId: string,
    command: ClientRunStopCommandV1,
  ): Promise<ClientRunStopReceiptV1> {
    const run = (this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === command.runId,
    );
    if (!run) {
      return Promise.reject(
        new Error(`run "${command.runId}" was not admitted`),
      );
    }
    run.stopRequestedAt = run.stopRequestedAt ?? new Date().toISOString();
    return Promise.resolve(
      createClientRunStopReceiptV1(
        command,
        projectClientRunV1(structuredClone(run)),
      ),
    );
  }

  reconcileRun(botId: string, runId: string): Promise<BotTurnResult> {
    const run = (this.runs.get(botId) ?? []).find(
      (candidate) => candidate.runId === runId,
    );
    if (!run || run.status !== "completed") {
      return Promise.reject(new Error("run does not require reconciliation"));
    }
    return Promise.resolve(
      projectClientTurnV1({
        runId,
        text: run.responseText ?? "",
        events: structuredClone(run.events),
      }),
    );
  }
}

function rpcBindingFor(state: BotStateBinding): UserBotStateBinding {
  return {
    assertRegistered: () => Promise.resolve(),
    listApplets: () =>
      Promise.resolve({ schemaVersion: 1, revision: 0, applets: [] }),
    mintAppletViewerToken: () =>
      Promise.reject(new Error("Applet is unavailable")),
    readAppletUi: () => Promise.reject(new Error("Applet is unavailable")),
    readFocusedApplet: () =>
      Promise.resolve({
        schemaVersion: 1,
        appletId: null,
        changedAt: new Date(0).toISOString(),
      }),
    setFocusedApplet: ({ appletId }) =>
      Promise.resolve({
        schemaVersion: 1,
        appletId,
        changedAt: new Date(0).toISOString(),
      }),
    listSkills: () =>
      Promise.resolve({ schemaVersion: 1 as const, skills: [] }),
    listPackageUi: ({ botId }) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        botId,
        generationId: "foundation-v1",
        contributions: [],
      }),
    runPackageUiTool: ({ botId, command }) =>
      state.run(botId, {
        runId: command.commandId,
        sessionId: `session:${botId}`,
        acceptedAt: new Date().toISOString(),
        text: command.name,
      }),
    readWorkspaceFileV1: () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "not-found" as const,
        reason: "no workspace in this test",
      }),
    readAppletSourceV1: ({ appletId }) =>
      Promise.resolve({ appletId, files: [], truncated: false }),
    readAppletBuildV1: () => Promise.resolve({ status: "unknown" as const }),
    run: ({ botId, command }) => state.run(botId, command),
    listRuns: ({ botId, query }) => state.listRuns(botId, query),
    listConversations: () =>
      Promise.resolve({ schemaVersion: 1 as const, conversations: [] }),
    startConversation: () =>
      Promise.resolve({ schemaVersion: 1 as const, conversations: [] }),
    lookupRun: ({ botId, query }) => state.lookupRun(botId, query),
    fenceRunAdmission: ({ botId, query }) =>
      state.fenceRunAdmission(botId, query),
    listNotifications: ({ botId }) => state.listNotifications(botId),
    listApprovals: ({ botId }) => state.listApprovals(botId),
    decideApproval: ({ botId, approvalId, command }) =>
      state.decideApproval(botId, approvalId, command),
    acknowledgeNotification: ({ botId, notificationId }) =>
      state.acknowledgeNotification(botId, notificationId),
    reconcileRun: ({ botId, runId }) => state.reconcileRun(botId, runId),
    stopRun: ({ botId, command }) => state.stopRun(botId, command),
  };
}

class MemoryConfiguration
  implements UserConfigurationBinding, BotConfigurationBinding
{
  private user: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "FrockBot user" },
    packages: [],
    connections: [],
  };
  private readonly bots = new Map<string, BotSettingsViewV1>();
  private readonly receipts = new Map<string, OperationReceiptV1>();
  private readonly lifecycles = new Map<string, "active" | "archived">();
  private readonly connectionReceipts = new Map<
    string,
    ConnectionCommandReceiptV1
  >();
  private connectionReceiptOverride: unknown;
  private configurationReadOverride: unknown;
  private operationReceiptOverride: unknown;

  setConnectionReceiptOverride(receipt: unknown): void {
    this.connectionReceiptOverride = receipt;
  }

  setConfigurationReadOverride(configuration: unknown): void {
    this.configurationReadOverride = configuration;
  }

  setOperationReceiptOverride(receipt: unknown): void {
    this.operationReceiptOverride = receipt;
  }

  private read(query: ConfigurationQueryV1): Promise<ConfigurationViewV1> {
    if (query.type === "user/get") return Promise.resolve(this.user);
    const current = this.bots.get(query.botId) ?? {
      schemaVersion: 1 as const,
      botId: query.botId,
      revision: 0,
      profile: { name: query.botId },
      notifications: { enabled: false },
      packageValues: {},
    };
    this.bots.set(query.botId, current);
    return Promise.resolve(current);
  }

  private async execute(
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1> {
    const duplicate = this.receipts.get(command.commandId);
    if (duplicate) return duplicate;
    const current = await this.read(
      "botId" in command
        ? { schemaVersion: 1, type: "bot/get", botId: command.botId }
        : { schemaVersion: 1, type: "user/get" },
    );
    if (current.revision !== command.expectedRevision) {
      throw new Error(`configuration revision is ${current.revision}`);
    }
    const revision = current.revision + 1;
    if ("botId" in command) {
      const bot = current as BotSettingsViewV1;
      this.bots.set(command.botId, {
        ...bot,
        revision,
        ...(command.type === "bot/update-profile"
          ? { profile: command.profile }
          : command.type === "bot/set-profile"
            ? {
                profile: applyBotProfilePatchV1(
                  bot.profile,
                  command.profile,
                  command.namedBy ?? "user",
                ),
              }
            : command.type === "bot/update-notifications"
              ? { notifications: command.notifications }
              : {
                  packageValues: {
                    ...bot.packageValues,
                    [command.packageId]: {
                      ...bot.packageValues[command.packageId],
                      ...command.values,
                    },
                  },
                }),
      });
    } else {
      const user = current as UserSettingsViewV1;
      if (command.type === "user/update-profile") {
        this.user = { ...user, revision, profile: command.profile };
      } else if (command.type === "user/set-platform-model") {
        this.user = {
          ...user,
          revision,
          platformModel: command.model,
        };
      } else if (command.type === "user/install-package") {
        this.user = {
          ...user,
          revision,
          packages: [
            ...user.packages.filter(
              (pkg) => pkg.packageId !== command.packageId,
            ),
            {
              packageId: command.packageId,
              version: command.version,
              state: command.enabled === false ? "disabled" : "installed",
            },
          ],
        };
      } else if (command.type === "user/uninstall-package") {
        this.user = {
          ...user,
          revision,
          packages: user.packages.filter(
            (pkg) => pkg.packageId !== command.packageId,
          ),
        };
      } else if (command.type === "user/set-package-enabled") {
        this.user = {
          ...user,
          revision,
          packages: user.packages.map((pkg) =>
            pkg.packageId === command.packageId
              ? {
                  ...pkg,
                  state: command.enabled ? "installed" : "disabled",
                }
              : pkg,
          ),
        };
      } else {
        this.user = {
          ...user,
          revision,
          packages: user.packages.map((pkg) =>
            pkg.packageId === command.packageId
              ? { ...pkg, values: { ...pkg.values, ...command.values } }
              : pkg,
          ),
        };
      }
    }
    const receipt: OperationReceiptV1 = {
      schemaVersion: 1,
      commandId: command.commandId,
      revision,
      status: "applied",
    };
    this.receipts.set(command.commandId, receipt);
    return receipt;
  }

  readConfiguration(
    request: UserConfigurationReadRpcV1,
  ): Promise<UserSettingsViewV1>;
  readConfiguration(
    request: BotConfigurationReadRpcV1,
  ): Promise<BotSettingsViewV1>;
  readConfiguration(
    request:
      | Parameters<UserConfigurationBinding["readConfiguration"]>[0]
      | Parameters<BotConfigurationBinding["readConfiguration"]>[0],
  ): Promise<ConfigurationViewV1> {
    if (this.configurationReadOverride !== undefined) {
      return Promise.resolve(
        this.configurationReadOverride as ConfigurationViewV1,
      );
    }
    return this.read(
      "botId" in request
        ? { schemaVersion: 1, type: "bot/get", botId: request.botId }
        : { schemaVersion: 1, type: "user/get" },
    );
  }

  executeConfiguration(
    request:
      | Parameters<UserConfigurationBinding["executeConfiguration"]>[0]
      | Parameters<BotConfigurationBinding["executeConfiguration"]>[0],
  ): Promise<OperationReceiptV1> {
    if (this.operationReceiptOverride !== undefined) {
      return Promise.resolve(
        this.operationReceiptOverride as OperationReceiptV1,
      );
    }
    return this.execute(request.command);
  }

  executeConnection(
    request: Parameters<UserConfigurationBinding["executeConnection"]>[0],
  ): ReturnType<UserConfigurationBinding["executeConnection"]> {
    if (this.connectionReceiptOverride !== undefined) {
      return Promise.resolve(this.connectionReceiptOverride) as ReturnType<
        UserConfigurationBinding["executeConnection"]
      >;
    }
    const connectionId =
      "connectionId" in request.command
        ? request.command.connectionId
        : "connection-test";
    const receipt = {
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      connectionId,
      status: "applied" as const,
    };
    this.connectionReceipts.set(request.command.commandId, receipt);
    return Promise.resolve(receipt);
  }

  readMcpServers(): ReturnType<UserConfigurationBinding["readMcpServers"]> {
    return Promise.reject(new Error("MCP status is not used in these tests"));
  }

  executeMcpCommand(): ReturnType<
    UserConfigurationBinding["executeMcpCommand"]
  > {
    return Promise.reject(
      new Error("MCP lifecycle is not used in these tests"),
    );
  }

  recordMcpMountOutcome(): Promise<void> {
    return Promise.reject(
      new Error("MCP outcomes are not used in these tests"),
    );
  }

  startMcpAuthorization(): ReturnType<
    UserConfigurationBinding["startMcpAuthorization"]
  > {
    return Promise.reject(
      new Error("MCP authorization is not used in these tests"),
    );
  }

  completeMcpAuthorization(): ReturnType<
    UserConfigurationBinding["completeMcpAuthorization"]
  > {
    return Promise.reject(
      new Error("MCP authorization is not used in these tests"),
    );
  }

  revokeMcpAuthorization(): ReturnType<
    UserConfigurationBinding["revokeMcpAuthorization"]
  > {
    return Promise.reject(
      new Error("MCP authorization is not used in these tests"),
    );
  }

  lookupConnectionCommand(
    request: Parameters<UserConfigurationBinding["lookupConnectionCommand"]>[0],
  ): ReturnType<UserConfigurationBinding["lookupConnectionCommand"]> {
    return Promise.resolve(this.connectionReceipts.get(request.commandId));
  }

  getConnection(
    request: Parameters<UserConfigurationBinding["getConnection"]>[0],
  ) {
    return Promise.resolve(
      this.user.connections.find(
        (connection) => connection.connectionId === request.connectionId,
      ),
    );
  }

  leaseModelCredential(): ReturnType<
    UserConfigurationBinding["leaseModelCredential"]
  > {
    return Promise.reject(new Error("Credential leases are not configured"));
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  listBots() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      revision: this.bots.size,
      bots: [...this.bots.keys()].map((botId) => ({
        schemaVersion: 1 as const,
        botId,
        registeredAt: "2026-08-29T00:00:00.000Z",
        initialName: botId,
        sheep: randomSheepRecipeV1(() => 0),
      })),
    });
  }
  listBotLifecycles() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      lifecycles: [...this.bots.keys()].map((botId) => ({
        schemaVersion: 1 as const,
        botId,
        status: this.lifecycles.get(botId) ?? ("active" as const),
        revision: 0,
      })),
    });
  }
  executeBotLifecycle(
    request: Parameters<UserConfigurationBinding["executeBotLifecycle"]>[0],
  ) {
    const status: "active" | "archived" =
      request.command.type === "bot/archive" ? "archived" : "active";
    this.lifecycles.set(request.command.botId, status);
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      botId: request.command.botId,
      status: "applied" as const,
      lifecycle: {
        schemaVersion: 1 as const,
        botId: request.command.botId,
        status,
        revision: 1,
      },
    });
  }
  createBot(request: Parameters<UserConfigurationBinding["createBot"]>[0]) {
    void this.read({
      schemaVersion: 1,
      type: "bot/get",
      botId: request.command.botId,
    });
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      revision: this.bots.size,
    });
  }
  getBotRegistration(
    request: Parameters<UserConfigurationBinding["getBotRegistration"]>[0],
  ) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      registeredAt: "2026-08-29T00:00:00.000Z",
      initialName: request.botId,
      sheep: randomSheepRecipeV1(() => 0),
    });
  }
  hasBot(request: Parameters<UserConfigurationBinding["hasBot"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      registered: true,
    });
  }
  readPackageRevisions() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      revision: 0,
      revisions: [],
    });
  }
  publishPackage(): Promise<never> {
    return Promise.reject(
      new Error("publication is not configured in this test"),
    );
  }
  rollbackPackage(): Promise<never> {
    return Promise.reject(new Error("rollback is not configured in this test"));
  }
  activeApplicationHash(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  listTemplateShares() {
    return Promise.resolve({ schemaVersion: 1 as const, shares: [] });
  }
  executeTemplateCommand(): never {
    throw new Error("template commands are not exercised here");
  }
  resolveTemplateShare(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  listTemplateImports() {
    return Promise.resolve({ schemaVersion: 1 as const, imports: [] });
  }
  executeTemplateImport(): never {
    throw new Error("template imports are not exercised here");
  }
  readSheep(request: Parameters<BotConfigurationBinding["readSheep"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      revision: 0,
      sheep: randomSheepRecipeV1(() => 0),
    });
  }
  updateSheep(request: Parameters<BotConfigurationBinding["updateSheep"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      revision: request.command.expectedRevision + 1,
    });
  }
  private compositionGeneration(
    botId: string,
    generationId: string,
    isCurrent: boolean,
  ) {
    return {
      schemaVersion: 1 as const,
      botId,
      generationId,
      createdAt: "2026-08-31T00:00:00.000Z",
      status: (isCurrent ? "active" : "superseded") as "active" | "superseded",
      origin: { kind: "bootstrap" as const },
      isCurrent,
      members: [],
      failures: [],
    };
  }
  listCompositionGenerations(
    request: Parameters<
      BotConfigurationBinding["listCompositionGenerations"]
    >[0],
  ) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      currentGenerationId: COMPOSITION_GENERATION_ID,
      generations: [
        this.compositionGeneration(
          request.botId,
          COMPOSITION_GENERATION_ID,
          true,
        ),
      ],
    });
  }
  getCompositionGeneration(
    request: Parameters<BotConfigurationBinding["getCompositionGeneration"]>[0],
  ) {
    return Promise.resolve(
      request.generationId === COMPOSITION_GENERATION_ID
        ? this.compositionGeneration(request.botId, request.generationId, true)
        : undefined,
    );
  }
  revertComposition(
    request: Parameters<BotConfigurationBinding["revertComposition"]>[0],
  ) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      generationId: COMPOSITION_REVERTED_GENERATION_ID,
      currentGenerationId: request.command.expectedGenerationId,
    });
  }

  // Routines are Bot Durable Object state; this fake stands in for that object
  // with the Package's own store over in-memory storage, so the gateway is
  // exercised against the real command semantics rather than a stub.
  private readonly routines = new Map<string, RoutineStore>();

  private routineStore(botId: string): RoutineStore {
    const existing = this.routines.get(botId);
    if (existing) return existing;
    const created = new RoutineStore(createMemoryRoutineStorageV1());
    this.routines.set(botId, created);
    return created;
  }

  listRoutines(
    request: Parameters<BotConfigurationBinding["listRoutines"]>[0],
  ) {
    return this.routineStore(request.botId).list(request.botId);
  }

  listTasks(request: Parameters<BotConfigurationBinding["listTasks"]>[0]) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      botId: request.botId,
      active: 0,
      tasks: [],
    });
  }

  readTask(
    request: Parameters<BotConfigurationBinding["readTask"]>[0],
  ): ReturnType<BotConfigurationBinding["readTask"]> {
    return Promise.reject(new Error(`task "${request.taskId}" is unknown`));
  }

  stopTask(
    request: Parameters<BotConfigurationBinding["stopTask"]>[0],
  ): ReturnType<BotConfigurationBinding["stopTask"]> {
    return Promise.reject(new Error(`task "${request.taskId}" is unknown`));
  }

  executeRoutineCommand(
    request: Parameters<BotConfigurationBinding["executeRoutineCommand"]>[0],
  ) {
    return this.routineStore(request.botId).execute(request.command, {
      kind: "user",
    });
  }

  listRoutineRuns(
    request: Parameters<BotConfigurationBinding["listRoutineRuns"]>[0],
  ) {
    return this.routineStore(request.botId).listRuns(
      request.botId,
      request.routineId,
    );
  }

  deliverRoutineHook(
    request: Parameters<BotConfigurationBinding["deliverRoutineHook"]>[0],
  ): Promise<{ status: "accepted" | "duplicate"; fireId: string }> {
    return this.routineStore(request.botId).deliverHook(request.delivery);
  }

  /** Machine deliveries reach a real Bot Durable Object, never this stub. */
  readonly machineDeliveries: Array<
    Parameters<BotConfigurationBinding["deliverMachineResult"]>[0]
  > = [];

  async deliverMachineResult(
    request: Parameters<BotConfigurationBinding["deliverMachineResult"]>[0],
  ): Promise<{ status: "accepted" }> {
    this.machineDeliveries.push(request);
    return { status: "accepted" };
  }

  private readonly routineInboxes = new Map<string, RoutineInboxStore>();

  private routineInbox(botId: string): RoutineInboxStore {
    const existing = this.routineInboxes.get(botId);
    if (existing) return existing;
    const created = new RoutineInboxStore(createMemoryRoutineStorageV1());
    this.routineInboxes.set(botId, created);
    return created;
  }

  private async routineInboxView(botId: string) {
    const entries = await this.routineInbox(botId).list();
    return {
      schemaVersion: 1 as const,
      botId,
      entries: entries.map((entry) => ({
        schemaVersion: 1 as const,
        entryId: entry.entryId,
        runId: entry.runId,
        routineId: entry.routineId,
        text: entry.text,
        attribution: entry.attribution,
        createdAt: entry.createdAt,
        acknowledged: entry.acknowledged,
      })),
      unacknowledged: entries.filter((entry) => !entry.acknowledged).length,
    };
  }

  listRoutineInbox(
    request: Parameters<BotConfigurationBinding["listRoutineInbox"]>[0],
  ) {
    return this.routineInboxView(request.botId);
  }

  async executeRoutineInboxCommand(
    request: Parameters<
      BotConfigurationBinding["executeRoutineInboxCommand"]
    >[0],
  ) {
    await this.routineInbox(request.botId).acknowledge(
      request.command.entryIds,
    );
    return {
      schemaVersion: 1 as const,
      commandId: request.command.commandId,
      status: "applied" as const,
      inbox: await this.routineInboxView(request.botId),
    };
  }

  readRoutineRun(
    request: Parameters<BotConfigurationBinding["readRoutineRun"]>[0],
  ) {
    const error = new Error(`run "${request.runId}" is unknown`);
    error.name = "RoutineNotFoundError";
    return Promise.reject(error);
  }
}

const COMPOSITION_GENERATION_ID = "2026-08-31T00:00:00.000Z:0123456789abcdef";
const COMPOSITION_REVERTED_GENERATION_ID =
  "2026-09-01T00:00:00.000Z:0123456789abcdef";

class MemoryConnections implements ConnectionBinding {
  completed: Array<{ connectionId: string; connectedAccountId: string }> = [];

  start(input: {
    commandId: string;
    connectionTypeId: string;
    botId: string;
    alias?: string;
  }) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      status: "authorization-required" as const,
      connectionId: `connection-${input.connectionTypeId}`,
      redirectUrl: "https://connect.composio.dev/link/test",
      expiresAt: "2026-08-28T01:00:00.000Z",
    });
  }

  complete(input: {
    connectionId: string;
    connectedAccountId: string;
  }): Promise<{
    returnTarget: "browser" | "desktop";
    status: "ready" | "pending";
  }> {
    this.completed.push(input);
    return Promise.resolve({ returnTarget: "browser", status: "ready" });
  }

  fail(
    _connectionId: string,
    _message: string,
  ): Promise<{
    returnTarget: "browser" | "desktop";
    status: "ready" | "pending";
  }> {
    return Promise.resolve({ returnTarget: "browser", status: "ready" });
  }

  revoke(_connectionId: string) {
    return Promise.resolve({
      schemaVersion: 1 as const,
      status: "revoked" as const,
    });
  }
}

class DirectWorkerLoader implements WorkerLoader {
  readonly ids: string[] = [];
  readonly codes: WorkerCode[] = [];
  private readonly fetchApplication = createUserApplication();

  get(id: string, callback: () => Promise<WorkerCode>): LoadedWorker {
    this.ids.push(id);
    return {
      getEntrypoint: () => ({
        fetch: async (request) => {
          const code = await callback();
          this.codes.push(code);
          return this.fetchApplication(request, code.env);
        },
      }),
    };
  }
}

const unauthenticatedAuth: GatewayAuth = {
  handler: () => Promise.resolve(new Response("auth handler")),
  getSession: () => Promise.resolve(null),
};

const closedDeploymentPolicy: DeploymentPolicyV1 = {
  schemaVersion: 1,
  revision: 0,
  signups: { open: false },
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "deployment-default",
};

function createTestGateway(
  applicationHashFor: (userId: string) => Promise<string> = () =>
    Promise.resolve("foundation-v1"),
  auth: GatewayAuth = unauthenticatedAuth,
  allowDevelopmentIdentity = true,
  allowedClientOrigins?: string[],
  catalog?: CatalogGatewayStore,
  signup?: {
    userExists?: (userId: string) => Promise<boolean>;
    policy?: DeploymentPolicyV1;
    adminEmails?: string;
  },
  openBotStateChannel?: NonNullable<GatewayDependencies["openBotStateChannel"]>,
  workspaceSeed?: NonNullable<GatewayDependencies["workspaceSeed"]>,
) {
  const loader = new DirectWorkerLoader();
  const states = new Map<string, MemoryBotState>();
  const configurations = new Map<string, MemoryConfiguration>();
  const configurationRoutes: string[] = [];
  const connections = new Map<string, MemoryConnections>();
  const configurationFor = (userId: string) => {
    const configuration =
      configurations.get(userId) ?? new MemoryConfiguration();
    configurations.set(userId, configuration);
    return configuration;
  };
  const gateway = createGateway({
    loader,
    artifacts: { load: () => Promise.resolve("export default {}") },
    auth,
    userExists: signup?.userExists ?? (() => Promise.resolve(true)),
    readDeploymentPolicy: () =>
      Promise.resolve(signup?.policy ?? closedDeploymentPolicy),
    ...(signup?.adminEmails ? { adminEmails: signup.adminEmails } : {}),
    applicationHashFor,
    botStateFor: (userId) => {
      const state = states.get(userId) ?? new MemoryBotState();
      states.set(userId, state);
      return rpcBindingFor(state);
    },
    userConfigurationFor: (userId) => {
      configurationRoutes.push(`user:${userId}`);
      return configurationFor(userId);
    },
    botConfigurationFor: (userId, botId) => {
      configurationRoutes.push(`bot:${userId}:${botId}`);
      return configurationFor(userId);
    },
    ...(openBotStateChannel ? { openBotStateChannel } : {}),
    ...(workspaceSeed ? { workspaceSeed } : {}),
    backendContributions: [
      createFlockBackendContribution({
        listBots: (userId) => configurationFor(userId).listBots(),
        createBot: (userId, command) =>
          configurationFor(userId).createBot({
            schemaVersion: 1,
            userId,
            command,
          }),
        listBotLifecycles: (userId) =>
          configurationFor(userId).listBotLifecycles(),
        executeBotLifecycle: (userId, command) =>
          configurationFor(userId).executeBotLifecycle({
            schemaVersion: 1,
            userId,
            command,
          }),
        readSheep: (userId, botId) =>
          configurationFor(userId).readSheep({
            schemaVersion: 1,
            userId,
            botId,
          }),
        updateSheep: (userId, botId, command) =>
          configurationFor(userId).updateSheep({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        listBotIdentities: () =>
          Promise.resolve({ schemaVersion: 1 as const, identities: [] }),
        listBotUnread: () =>
          Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
        listBotNotifications: () =>
          Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
        executeBotUnreadCommand: () =>
          Promise.reject(new Error("unread is not wired in this test")),
      }),
      createSettingsBackendContribution({
        executeConnection: (userId, command) => {
          const configuration =
            configurations.get(userId) ?? new MemoryConfiguration();
          configurations.set(userId, configuration);
          return configuration.executeConnection({
            schemaVersion: 1,
            userId,
            command,
          });
        },
        listCompositionGenerations: (userId, botId, query) => {
          const configuration =
            configurations.get(userId) ?? new MemoryConfiguration();
          configurations.set(userId, configuration);
          return configuration.listCompositionGenerations({
            schemaVersion: 1,
            userId,
            botId,
            query,
          });
        },
        getCompositionGeneration: (userId, botId, generationId) => {
          const configuration =
            configurations.get(userId) ?? new MemoryConfiguration();
          configurations.set(userId, configuration);
          return configuration.getCompositionGeneration({
            schemaVersion: 1,
            userId,
            botId,
            generationId,
          });
        },
        revertComposition: (userId, botId, command) => {
          const configuration =
            configurations.get(userId) ?? new MemoryConfiguration();
          configurations.set(userId, configuration);
          return configuration.revertComposition({
            schemaVersion: 1,
            userId,
            botId,
            command,
          });
        },
        lookupConnectionCommand: (userId, packageId, commandId) => {
          const configuration =
            configurations.get(userId) ?? new MemoryConfiguration();
          configurations.set(userId, configuration);
          return configuration.lookupConnectionCommand({
            schemaVersion: 1,
            userId,
            packageId,
            commandId,
          });
        },
      }),
      {
        packageId: "composio",
        async route(request, url, context) {
          if (!url.pathname.startsWith("/api/plugins/composio/")) {
            return undefined;
          }
          if (!context.userId) {
            return Response.json(
              { error: "authentication required" },
              { status: 401 },
            );
          }
          const connection =
            connections.get(context.userId) ?? new MemoryConnections();
          connections.set(context.userId, connection);
          if (url.pathname === "/api/plugins/composio/connections") {
            const input = (await request.json()) as Parameters<
              ConnectionBinding["start"]
            >[0];
            return Response.json(await connection.start(input), {
              status: 201,
            });
          }
          if (url.pathname === "/api/plugins/composio/callback") {
            const connectionId = url.searchParams.get("connection") ?? "";
            const connectedAccountId =
              url.searchParams.get("connected_account_id") ?? "";
            await connection.complete({ connectionId, connectedAccountId });
            return Response.redirect(
              new URL("/?connection=composio-ready", url.origin),
              303,
            );
          }
          const connectionId = decodeURIComponent(
            url.pathname.split("/").at(-2) ?? "",
          );
          return Response.json(await connection.revoke(connectionId));
        },
      },
    ],
    allowDevelopmentIdentity,
    ...(allowedClientOrigins ? { allowedClientOrigins } : {}),
    ...(catalog ? { catalog } : {}),
  });
  return {
    gateway,
    loader,
    states,
    configurations,
    connections,
    configurationRoutes,
  };
}

function request(path: string, userId: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("x-frockbot-user-id", userId);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

describe("Cloudflare user application gateway", () => {
  test("uses an immutable user and application deployment id", () => {
    expect(
      applicationDeploymentId({
        userId: "alice",
        applicationHash: "sha256-abcd",
      }),
    ).toBe("alice:sha256-abcd");
    expect(() =>
      applicationDeploymentId({ userId: "../alice", applicationHash: "valid" }),
    ).toThrow("invalid user id");
  });

  test("selects each user's active immutable application", async () => {
    const { gateway, loader } = createTestGateway((userId) =>
      Promise.resolve(userId === "alice" ? "application-a" : "application-b"),
    );
    await gateway(request("/", "alice"));
    await gateway(request("/", "bob"));
    expect(loader.ids).toEqual(["alice:application-a", "bob:application-b"]);
  });

  test("reads and durably commands User and Bot settings before loading the app", async () => {
    const { gateway, loader, configurationRoutes } = createTestGateway();

    const initial = await gateway(
      request("/api/bots/primary/settings", "alice"),
    );
    expect(await initial.json()).toMatchObject({
      schemaVersion: 1,
      botId: "primary",
      revision: 0,
      notifications: { enabled: false },
    });

    const saved = await gateway(
      request("/api/bots/primary/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "profile-1",
          botId: "primary",
          expectedRevision: 0,
          profile: {
            name: "Housework",
            label: "Research, marketing, admin",
            description: "Keeps the household organized.",
          },
        }),
      }),
    );
    expect((await saved.json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "profile-1",
      revision: 1,
      status: "applied",
    });

    const reloaded = await gateway(
      request("/api/bots/primary/settings", "alice"),
    );
    expect(await reloaded.json()).toMatchObject({
      revision: 1,
      profile: { name: "Housework" },
    });
    const initialUser = await gateway(request("/api/settings", "alice"));
    expect(await initialUser.json()).toMatchObject({ revision: 0 });
    const savedUser = await gateway(
      request("/api/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "user-profile-1",
          expectedRevision: 0,
          profile: { name: "Alice" },
        }),
      }),
    );
    expect(await savedUser.json()).toMatchObject({
      commandId: "user-profile-1",
      status: "applied",
    });
    expect(configurationRoutes).toEqual([
      "bot:alice:primary",
      "bot:alice:primary",
      "bot:alice:primary",
      "user:alice",
      "user:alice",
    ]);
    expect(loader.ids).toEqual([]);
  });

  test("rejects malformed configuration RPC results at the gateway seam", async () => {
    {
      const { gateway, configurations } = createTestGateway();
      const configuration = new MemoryConfiguration();
      configuration.setConfigurationReadOverride({
        schemaVersion: 1,
        revision: 0,
        profile: { name: "Alice" },
        packages: [],
        connections: [],
        secret: "must-not-cross-the-seam",
      });
      configurations.set("alice", configuration);
      expect((await gateway(request("/api/settings", "alice"))).status).toBe(
        400,
      );
    }
    {
      const { gateway, configurations } = createTestGateway();
      const configuration = new MemoryConfiguration();
      configuration.setConfigurationReadOverride({
        schemaVersion: 1,
        botId: "primary",
        revision: 0,
        profile: { name: "Bot" },
        notifications: { enabled: false },
        packageValues: {},
        secret: "must-not-cross-the-seam",
      });
      configurations.set("alice", configuration);
      expect(
        (await gateway(request("/api/bots/primary/settings", "alice"))).status,
      ).toBe(400);
    }
    {
      const { gateway, configurations } = createTestGateway();
      const configuration = new MemoryConfiguration();
      configuration.setOperationReceiptOverride({
        schemaVersion: 1,
        commandId: "profile-malformed",
        revision: 1,
        status: "applied",
        secret: "must-not-cross-the-seam",
      });
      configurations.set("alice", configuration);
      const response = await gateway(
        request("/api/settings", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "user/update-profile",
            commandId: "profile-malformed",
            expectedRevision: 0,
            profile: { name: "Alice" },
          }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  test("admits API-key Connections only through the authenticated generic seam", async () => {
    const { gateway } = createTestGateway();
    const body = JSON.stringify({
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "ollama-connect-1",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "write-only-secret",
    });

    expect(
      (
        await gateway(
          new Request("https://bot.frockbot.com/api/connections", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(401);
    const response = await gateway(
      request("/api/connections", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });
    expect(
      (
        await gateway(
          new Request(
            "https://bot.frockbot.com/api/connection-commands?packageId=provider-ollama-cloud&commandId=ollama-connect-1",
          ),
        )
      ).status,
    ).toBe(401);
    const lookup = await gateway(
      request(
        "/api/connection-commands?packageId=provider-ollama-cloud&commandId=ollama-connect-1",
        "alice",
      ),
    );
    expect((await lookup.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });
    expect(
      (
        await gateway(
          request("/api/connections", "alice", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              schemaVersion: 1,
              type: "connection/refresh-models",
              commandId: "lost response",
              connectionId: "connection-test",
            }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await gateway(
          request(
            "/api/connection-commands?packageId=provider-ollama-cloud&commandId=lost%20response",
            "alice",
          ),
        )
      ).status,
    ).toBe(400);
  });

  test("rejects malformed Connection receipts from the User Durable Object", async () => {
    const { gateway, configurations } = createTestGateway();
    const configuration = new MemoryConfiguration();
    configuration.setConnectionReceiptOverride({
      schemaVersion: 1,
      commandId: "ollama-connect-malformed",
      connectionId: "connection-test",
      status: "applied",
      credential: "must-not-cross-the-seam",
    });
    configurations.set("alice", configuration);

    const response = await gateway(
      request("/api/connections", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/create-api-key",
          commandId: "ollama-connect-malformed",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          label: "Work",
          apiKey: "write-only-secret",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  test("rejects invalid encoded Bot settings paths before configuration lookup", async () => {
    const { gateway, configurationRoutes } = createTestGateway();
    for (const botId of [
      "invalid%2Fbot",
      "%",
      "bad:bot",
      "bad@bot",
      "b".repeat(129),
    ]) {
      for (const method of ["GET", "POST"]) {
        const response = await gateway(
          request(`/api/bots/${botId}/settings`, "alice", { method }),
        );
        expect(response.status).toBe(400);
      }
    }
    expect(configurationRoutes).toEqual([]);
  });

  test("routes authenticated Bot archive and lifecycle projection", async () => {
    const { gateway } = createTestGateway();
    await gateway(request("/api/bots/primary/settings", "alice"));
    const archived = await gateway(
      request("/api/bots/primary/lifecycle", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "bot/archive",
          commandId: "archive-primary",
          botId: "primary",
        }),
      }),
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    const lifecycles = await gateway(request("/api/bots/lifecycles", "alice"));
    expect(await lifecycles.json()).toMatchObject({
      lifecycles: [{ botId: "primary", status: "archived" }],
    });
  });

  test("writes enablement only through an authenticated, receipted User command", async () => {
    const { gateway } = createTestGateway();
    await gateway(
      request("/api/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/install-package",
          commandId: "install-composio-disabled",
          expectedRevision: 0,
          packageId: "composio",
          version: "0.0.1",
          enabled: false,
        }),
      }),
    );
    const body = JSON.stringify({
      schemaVersion: 1,
      type: "user/set-package-enabled",
      commandId: "enable-composio",
      expectedRevision: 1,
      packageId: "composio",
      enabled: true,
    });

    expect(
      (
        await gateway(
          new Request("https://bot.frockbot.com/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        )
      ).status,
    ).toBe(401);
    const enable = () =>
      gateway(
        request("/api/settings", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );

    expect((await (await enable()).json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "enable-composio",
      revision: 2,
      status: "applied",
    });
    expect((await (await enable()).json()) as OperationReceiptV1).toEqual({
      schemaVersion: 1,
      commandId: "enable-composio",
      revision: 2,
      status: "applied",
    });
    const settings = await gateway(request("/api/settings", "alice"));
    expect(await settings.json()).toMatchObject({
      revision: 2,
      packages: [{ packageId: "composio", state: "installed" }],
    });
  });

  test("refuses a client command that attempts to set the platform model", async () => {
    const { gateway } = createTestGateway();
    const response = await gateway(
      request("/api/settings", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "user/set-platform-model",
          commandId: "client-platform-model",
          expectedRevision: 0,
          model: {
            connectionId: "flock-default",
            providerModelId: "@frock/auto",
          },
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toEqual({
      error: "Platform model can only be set by a backend Contribution",
    });
    expect(
      await (await gateway(request("/api/settings", "alice"))).json(),
    ).toMatchObject({ revision: 0 });
  });

  test("replays and acknowledges durable Bot notification intents", async () => {
    const { gateway, states } = createTestGateway();
    await gateway(request("/api/bots/primary/turns", "alice"));
    states.get("alice")?.notifications.set("primary", [
      {
        notificationId: "run-1",
        runId: "run-1",
        createdAt: "2026-08-28T01:00:00.000Z",
        title: "Housework replied",
        body: "Done.",
      },
    ]);

    const pending = await gateway(
      request("/api/bots/primary/notifications", "alice"),
    );
    expect(await pending.json()).toMatchObject({
      notifications: [{ notificationId: "run-1" }],
    });

    const acknowledged = await gateway(
      request("/api/bots/primary/notifications", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          action: "acknowledge",
          notificationId: "run-1",
        }),
      }),
    );
    expect(acknowledged.status).toBe(200);
    expect(states.get("alice")?.notifications.get("primary")).toEqual([]);
  });

  test("starts and verifies Composio Connections through the authenticated backend", async () => {
    const { gateway, connections } = createTestGateway();
    const started = await gateway(
      request("/api/plugins/composio/connections", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "connection-command-1",
          connectionTypeId: "gmail",
          alias: "personal",
        }),
      }),
    );
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      connectionId: "connection-gmail",
      redirectUrl: "https://connect.composio.dev/link/test",
    });

    const callback = await gateway(
      request(
        "/api/plugins/composio/callback?connection=connection-gmail&connected_account_id=ca_123",
        "alice",
      ),
    );
    expect(callback.status).toBe(303);
    expect(connections.get("alice")?.completed).toEqual([
      { connectionId: "connection-gmail", connectedAccountId: "ca_123" },
    ]);
  });

  test("serves UI and agent behavior through the same user application", async () => {
    const { gateway, loader } = createTestGateway();

    const page = await gateway(request("/", "alice"));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-frockbot-user-id="alice"');
    expect(html).toContain('data-frockbot-user-application="foundation-v1"');
    const script = await gateway(request("/app.js", "alice"));
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const stylesheet = await gateway(request("/app.css", "alice"));
    expect(stylesheet.headers.get("content-type")).toContain("text/css");

    const turn = await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "/echo hello workers",
          commandId: "workers-turn-1",
        }),
      }),
    );
    expect(turn.status).toBe(200);
    const publicTurn: unknown = await turn.json();
    expect(decodeClientTurnV1(publicTurn)).toMatchObject({
      text: "Echo: hello workers",
      events: [
        {
          type: "tool/call",
          call: {
            name: "call_dynamic_tool",
            input: {
              namespace: "frockbot",
              toolName: "echo",
              argumentsJson: '{"text":"hello workers"}',
            },
          },
        },
        { type: "tool/result", content: "hello workers" },
      ],
    });
    const wire = JSON.stringify(publicTurn);
    expect(Object.keys(publicTurn as Record<string, unknown>).sort()).toEqual([
      "events",
      "runId",
      "schemaVersion",
      "text",
    ]);
    expect(wire).not.toContain("model/request");
    expect(wire).not.toContain("input/queued");
    expect(wire).not.toContain("tool-input-secret");
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
    expect(
      loader.codes.every((code) => code.globalOutbound === undefined),
    ).toBe(true);
    expect(Object.keys(loader.codes[0]?.env ?? {}).sort()).toEqual([
      "BOT_STATE",
      "DEPLOYMENT",
    ]);
  });

  test("replays a duplicate Turn command without another model effect", async () => {
    const { gateway, states } = createTestGateway();
    const turn = () =>
      gateway(
        request("/api/bots/primary/turns", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: "hello",
            commandId: "stable-turn-1",
          }),
        }),
      );

    const first = await turn();
    const second = await turn();

    expect(await first.json()).toEqual(await second.json());
    expect(
      (await states.get("alice")?.listRuns("primary", { schemaVersion: 1 }))
        ?.runs,
    ).toHaveLength(1);
  });

  test("shares the user deployment while isolating bot state", async () => {
    const { gateway, loader } = createTestGateway();
    for (const botId of ["alpha", "beta"]) {
      const response = await gateway(
        request(`/api/bots/${botId}/turns`, "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: `hello ${botId}`,
            commandId: `turn-${botId}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const alpha = await gateway(request("/api/bots/alpha/turns", "alice"));
    const beta = await gateway(request("/api/bots/beta/turns", "alice"));
    const alphaRuns = decodeClientRunListV1(await alpha.json());
    const betaRuns = decodeClientRunListV1(await beta.json());
    expect(alphaRuns).toHaveLength(1);
    expect(betaRuns).toHaveLength(1);
    expect(alphaRuns[0]?.input).toBe("hello alpha");
    expect(betaRuns[0]?.input).toBe("hello beta");
    expect(new Set(loader.ids)).toEqual(new Set(["alice:foundation-v1"]));
  });

  test("reads one admitted Turn without issuing another command", async () => {
    const { gateway, states } = createTestGateway();
    const admitted = await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "lookup-turn-1",
        }),
      }),
    );
    expect(admitted.status).toBe(200);

    const response = await gateway(
      request("/api/bots/primary/turns/lookup-turn-1", "alice"),
    );

    expect(response.status).toBe(200);
    expect(decodeClientRunLookupV1(await response.json())).toMatchObject({
      state: "terminal",
      run: { runId: "lookup-turn-1", status: "completed" },
    });
    expect(states.get("alice")?.storedRuns("primary")).toHaveLength(1);
  });

  test("routes an authenticated Stop to the owning Bot and back", async () => {
    const { gateway, states } = createTestGateway();
    await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "stop-turn-1",
        }),
      }),
    );

    const stop = (userId: string, body: unknown) =>
      gateway(
        request("/api/bots/primary/turns/stop-turn-1/stop", userId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const accepted = await stop("alice", {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(accepted.status).toBe(200);
    expect(decodeClientRunStopReceiptV1(await accepted.json())).toMatchObject({
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(
      states.get("alice")?.storedRuns("primary")[0]?.stopRequestedAt,
    ).toBeString();

    // Another authenticated user reaches only their own isolated Bot state.
    const isolated = await stop("bob", {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-command-1",
      runId: "stop-turn-1",
    });
    expect(isolated.status).toBe(409);
    expect((await isolated.json()) as { error: string }).toEqual({
      error: 'run "stop-turn-1" was not admitted',
    });

    for (const invalid of [
      { schemaVersion: 1, action: "stop", commandId: "stop-command-2" },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-command-2",
        runId: "other-run",
      },
      {
        schemaVersion: 2,
        action: "stop",
        commandId: "stop-command-2",
        runId: "stop-turn-1",
      },
    ]) {
      expect((await stop("alice", invalid)).status).toBe(400);
    }
  });

  test("returns only the versioned client run wire contract", async () => {
    const { gateway } = createTestGateway();
    await gateway(
      request("/api/bots/primary/turns", "alice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "hello",
          commandId: "wire-turn-1",
        }),
      }),
    );

    const response = await gateway(request("/api/bots/primary/turns", "alice"));
    const value = (await response.json()) as Record<string, unknown>;
    const runs = value.runs as Array<Record<string, unknown>>;

    expect(Object.keys(value).sort()).toEqual([
      "page",
      "runs",
      "schemaVersion",
    ]);
    expect(value.schemaVersion).toBe(1);
    expect(value.page).toEqual({ truncated: false });
    expect(Object.keys(runs[0] ?? {}).sort()).toEqual([
      "admittedAt",
      "events",
      "input",
      "outcome",
      "runId",
      "schemaVersion",
      "status",
    ]);
    const wire = JSON.stringify(value);
    for (const internalField of [
      "commandFingerprint",
      "sessionId",
      "compositionGenerationId",
      "configurationSnapshot",
      "phase",
      "previousEventCount",
      "deadline",
      "receipt",
    ]) {
      expect(wire).not.toContain(internalField);
    }
  });

  test("rehydrates one bot session across disposable application runtimes", async () => {
    const { gateway, states } = createTestGateway();
    const responses: BotTurnResult[] = [];
    for (const text of ["first turn", "second turn"]) {
      const response = await gateway(
        request("/api/bots/continuing/turns", "alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text,
            commandId: `turn-${responses.length + 1}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
      responses.push((await response.json()) as BotTurnResult);
    }
    expect(responses.every((response) => response.schemaVersion === 1)).toBe(
      true,
    );
    expect(JSON.stringify(responses)).not.toContain("turn/start");
    const stored = states.get("alice")?.storedRuns("continuing") ?? [];
    expect(
      stored.map(
        (run) => run.events.find((event) => event.type === "turn/start")?.turn,
      ),
    ).toEqual([1, 2]);

    const history = await gateway(
      request("/api/bots/continuing/turns", "alice"),
    );
    const runs = decodeClientRunListV1(await history.json());
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.input)).toEqual(["first turn", "second turn"]);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
  });

  test("separates different users and durably accepts before execution", async () => {
    const { gateway, loader, states } = createTestGateway();
    for (const userId of ["alice", "bob"]) {
      const response = await gateway(
        request("/api/bots/default/turns", userId, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            text: `hello ${userId}`,
            commandId: `turn-${userId}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    expect(new Set(loader.ids)).toEqual(
      new Set(["alice:foundation-v1", "bob:foundation-v1"]),
    );
    const aliceRuns = states.get("alice")?.storedRuns("default");
    const bobRuns = states.get("bob")?.storedRuns("default");
    expect(aliceRuns?.[0]?.input).toBe("hello alice");
    expect(bobRuns?.[0]?.input).toBe("hello bob");
    expect(aliceRuns?.[0]?.events[0]?.type).toBe("session/created");
    expect(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "model/request",
      ),
    ).toBeLessThan(
      aliceRuns?.[0]?.events.findIndex(
        (event) => event.type === "assistant/message",
      ) ?? -1,
    );
  });

  test("persists the browser development identity from the query seam", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(
      new Request("https://frockbot.test/?as_user=alice"),
    );
    expect(page.status).toBe(200);
    expect(await page.clone().text()).toContain(
      'data-frockbot-auth-mode="development"',
    );
    expect(page.headers.get("set-cookie")).toContain("frockbot_dev_user=alice");
    const script = await gateway(
      new Request("https://frockbot.test/app.js", {
        headers: { cookie: "frockbot_dev_user=alice" },
      }),
    );
    expect(script.status).toBe(200);
  });

  test("consumes the development identity before strict hosted query decoding", async () => {
    const { gateway, loader } = createTestGateway();
    const response = await gateway(
      new Request(
        "https://frockbot.test/api/bots/default/turns?as_user=mobile-development",
      ),
    );

    expect(response.status).toBe(200);
    expect(decodeClientRunListV1(await response.json())).toEqual([]);
    expect(loader.ids).toEqual(["mobile-development:foundation-v1"]);
  });

  test("serves the public shell but rejects unauthenticated application APIs", async () => {
    const { gateway } = createTestGateway();
    const page = await gateway(new Request("https://frockbot.test/"));
    expect(page.status).toBe(200);
    const publicHtml = await page.text();
    expect(publicHtml).toContain('data-frockbot-user-id="anonymous"');
    expect(publicHtml).toContain('data-frockbot-auth-mode="anonymous"');

    const response = await gateway(
      new Request("https://frockbot.test/api/bots/default/turns"),
    );
    expect(response.status).toBe(401);
  });

  test("serves the site icon without an authenticated identity", async () => {
    const { gateway } = createTestGateway();

    // A browser asks for the site icon before anyone signs in, so it has to be
    // a public asset alongside the shell it decorates.
    const icon = await gateway(
      new Request("https://frockbot.test/favicon.ico"),
    );

    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
  });

  test("ignores development identity headers unless explicitly enabled", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
    );
    const response = await gateway(request("/api/bots/default/turns", "alice"));
    expect(response.status).toBe(401);
  });

  test("mounts Better Auth routes before application routing", async () => {
    const { gateway, loader } = createTestGateway();
    const response = await gateway(
      new Request("https://frockbot.test/api/auth/get-session"),
    );
    expect(await response.text()).toBe("auth handler");
    expect(loader.ids).toEqual([]);
  });

  test("routes hosted sign-out only through Better Auth", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const auth: GatewayAuth = {
      handler: (request) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });
        return Promise.resolve(
          Response.json(
            { success: true },
            { headers: { "set-cookie": "session=; Max-Age=0" } },
          ),
        );
      },
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);

    const response = await gateway(
      new Request("https://frockbot.test/api/auth/sign-out", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ success: true });
    expect(requests).toEqual([
      { method: "POST", pathname: "/api/auth/sign-out" },
    ]);
    expect(loader.ids).toEqual([]);
  });

  test("derives the application identity from the Better Auth session", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);
    const response = await gateway(
      new Request("https://frockbot.test/", {
        headers: { "x-frockbot-auth-session-v1": "development" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      'data-frockbot-auth-mode="better-auth"',
    );
    expect(loader.ids).toEqual(["signed-in-user:foundation-v1"]);
  });

  test("projects authenticated identity through the hosted transport seam", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () => Promise.resolve({ user: { id: "signed-in-user" } }),
    };
    const { gateway, loader } = createTestGateway(undefined, auth);

    const response = await gateway(
      new Request("https://frockbot.test/api/identity"),
    );

    expect(response.status).toBe(200);
    const identity: unknown = await response.json();
    expect(identity).toEqual({
      schemaVersion: 1,
      userId: "signed-in-user",
      isAdmin: false,
    });
    expect(loader.ids).toEqual([]);
  });

  test("refuses a first-time signed-in User while signups are closed", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () =>
        Promise.resolve({
          user: { id: "new-user", email: "new@example.com" },
        }),
    };
    let applicationHashReads = 0;
    const { gateway, loader } = createTestGateway(
      () => {
        applicationHashReads += 1;
        return Promise.resolve("foundation-v1");
      },
      auth,
      false,
      undefined,
      undefined,
      { userExists: () => Promise.resolve(false) },
    );

    const response = await gateway(new Request("https://frockbot.test/"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain(
      "FrockBot isn't taking new signups right now.",
    );
    expect(applicationHashReads).toBe(0);
    expect(loader.ids).toEqual([]);
  });

  test("admits a first-time signed-in User while signups are open", async () => {
    const auth: GatewayAuth = {
      handler: unauthenticatedAuth.handler,
      getSession: () =>
        Promise.resolve({
          user: { id: "new-user", email: "new@example.com" },
        }),
    };
    const { gateway, loader } = createTestGateway(
      undefined,
      auth,
      false,
      undefined,
      undefined,
      {
        userExists: () => Promise.resolve(false),
        policy: {
          ...closedDeploymentPolicy,
          revision: 1,
          signups: { open: true },
        },
      },
    );

    const response = await gateway(new Request("https://frockbot.test/"));

    expect(response.status).toBe(200);
    expect(loader.ids).toEqual(["new-user:foundation-v1"]);
  });

  test("admits existing Users and configured admins while signups are closed", async () => {
    const users = [
      { id: "existing-user", email: "member@example.com", exists: true },
      { id: "owner-user", email: "OWNER@example.com", exists: false },
    ];
    for (const user of users) {
      const auth: GatewayAuth = {
        handler: unauthenticatedAuth.handler,
        getSession: () => Promise.resolve({ user }),
      };
      let existenceChecks = 0;
      const { gateway, loader } = createTestGateway(
        undefined,
        auth,
        false,
        undefined,
        undefined,
        {
          userExists: () => {
            existenceChecks += 1;
            return Promise.resolve(user.exists);
          },
          adminEmails: "owner@example.com",
        },
      );

      const response = await gateway(new Request("https://frockbot.test/"));

      expect(response.status).toBe(200);
      expect(loader.ids).toEqual([`${user.id}:foundation-v1`]);
      expect(existenceChecks).toBe(user.exists ? 1 : 0);
    }
  });

  test("admits development identities regardless of signup policy", async () => {
    let existenceChecks = 0;
    const { gateway, loader } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      true,
      undefined,
      undefined,
      {
        userExists: () => {
          existenceChecks += 1;
          return Promise.resolve(false);
        },
        adminEmails: "owner@example.com",
      },
    );

    const response = await gateway(
      new Request("https://frockbot.test/?as_user=developer"),
    );

    expect(response.status).toBe(200);
    expect(loader.ids).toEqual(["developer:foundation-v1"]);
    expect(existenceChecks).toBe(0);
  });

  test("turns the closed-signup page link into a Better Auth sign-out", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const auth: GatewayAuth = {
      handler: (request) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, pathname: url.pathname });
        return Promise.resolve(
          Response.json(
            { success: true },
            { headers: { "set-cookie": "session=; Max-Age=0" } },
          ),
        );
      },
      getSession: () =>
        Promise.resolve({
          user: { id: "new-user", email: "new@example.com" },
        }),
    };
    const { gateway } = createTestGateway(
      undefined,
      auth,
      false,
      undefined,
      undefined,
      { userExists: () => Promise.resolve(false) },
    );

    const response = await gateway(
      new Request("https://frockbot.test/sign-out"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(requests).toEqual([
      { method: "POST", pathname: "/api/auth/sign-out" },
    ]);
  });
});

const MOBILE_ORIGIN = "capacitor://localhost";

const rejectingAuth: GatewayAuth = {
  handler: () => Promise.reject(new Error("auth handler was invoked")),
  getSession: () => Promise.reject(new Error("session was resolved")),
};

describe("Bot-state WebSocket gateway", () => {
  const channelPath = "/api/bots/scout/state-channel?version=1";

  test("refuses an unauthenticated upgrade before it reaches a Bot", async () => {
    let opened = false;
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
      undefined,
      undefined,
      undefined,
      () => {
        opened = true;
        return Promise.resolve(Response.json({ opened: true }));
      },
    );
    const response = await gateway(
      new Request(`https://frockbot.test${channelPath}`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(401);
    expect(opened).toBe(false);
  });

  test("maps a cross-User ownership refusal to the same Bot 404", async () => {
    const { gateway } = createTestGateway(
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      (userId, botId) => {
        expect(userId).toBe("mallory");
        expect(botId).toBe("scout");
        return Promise.reject(
          Object.assign(new Error("foreign Bot"), {
            name: "ComputerBotNotFoundError",
          }),
        );
      },
    );
    const response = await gateway(
      request(channelPath, "mallory", {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      error: "Bot not found",
    });
  });

  test("forwards the authenticated development identity and admin projection", async () => {
    let context: unknown;
    const { gateway } = createTestGateway(
      undefined,
      undefined,
      true,
      ["capacitor://localhost"],
      undefined,
      { adminEmails: "" },
      (userId, botId, _request, forwarded) => {
        context = { userId, botId, ...forwarded };
        return Promise.resolve(Response.json({ opened: true }));
      },
    );
    const response = await gateway(
      request(channelPath, "alice", { headers: { upgrade: "websocket" } }),
    );
    expect(response.status).toBe(200);
    expect(context).toEqual({
      userId: "alice",
      botId: "scout",
      isAdmin: true,
      authMode: "development",
    });
  });

  test("rejects a WebSocket Origin outside ALLOWED_CLIENT_ORIGINS", async () => {
    let opened = false;
    const { gateway } = createTestGateway(
      undefined,
      undefined,
      true,
      ["capacitor://localhost"],
      undefined,
      undefined,
      () => {
        opened = true;
        return Promise.resolve(Response.json({ opened: true }));
      },
    );
    const response = await gateway(
      request(channelPath, "alice", {
        headers: {
          upgrade: "websocket",
          origin: "https://attacker.example",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(opened).toBe(false);
  });

  test("allows the configured Electron and mobile WebView origins", async () => {
    const origins = ["frockbot://localhost", "capacitor://localhost"];
    const opened: string[] = [];
    const { gateway } = createTestGateway(
      undefined,
      undefined,
      true,
      origins,
      undefined,
      undefined,
      (_userId, _botId, request) => {
        opened.push(request.headers.get("origin") ?? "");
        return Promise.resolve(Response.json({ opened: true }));
      },
    );
    for (const origin of origins) {
      const response = await gateway(
        request(channelPath, "alice", {
          headers: { upgrade: "websocket", origin },
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(opened).toEqual(origins);
  });
});

const bearerAuth: GatewayAuth = {
  handler: () =>
    Promise.resolve(
      new Response("auth handler", {
        headers: { "set-auth-token": "test-token" },
      }),
    ),
  getSession: (headers) =>
    Promise.resolve(
      headers.get("authorization") === "Bearer test-token"
        ? { user: { id: "mobile-user" } }
        : null,
    ),
};

function mobileRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("origin", MOBILE_ORIGIN);
  return new Request(`https://frockbot.test${path}`, { ...init, headers });
}

describe("Cross-origin access for mobile clients", () => {
  test("answers preflight for allowed origins without touching auth", async () => {
    const { gateway, loader } = createTestGateway(
      undefined,
      rejectingAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toBe("origin");
    expect(loader.ids).toEqual([]);
  });

  test("denies cross-origin sharing to origins outside the allow list", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const preflight = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        method: "OPTIONS",
        headers: { origin: "https://attacker.test" },
      }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("vary")).toBeNull();
  });

  test("rejects credential mutations from an untrusted origin", async () => {
    const { gateway } = createTestGateway(
      undefined,
      unauthenticatedAuth,
      true,
      [MOBILE_ORIGIN],
    );
    const response = await gateway(
      new Request("https://frockbot.test/api/connections", {
        method: "POST",
        headers: {
          origin: "https://attacker.test",
          cookie: "frockbot_dev_user=alice",
          "content-type": "text/plain",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/create-api-key",
          commandId: "csrf-connection",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          label: "Injected",
          apiKey: "stolen-context",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toEqual({
      error: "request origin is not allowed",
    });

    const sameOrigin = await gateway(
      new Request("https://frockbot.test/api/connections", {
        method: "POST",
        headers: {
          origin: "https://frockbot.test",
          cookie: "frockbot_dev_user=alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/create-api-key",
          commandId: "same-origin-connection",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          label: "Allowed",
          apiKey: "write-only-secret",
        }),
      }),
    );
    expect(sameOrigin.status).toBe(200);
  });

  test("shares authenticated bearer turns with the mobile origin", async () => {
    const { gateway, loader } = createTestGateway(
      undefined,
      bearerAuth,
      false,
      [MOBILE_ORIGIN],
    );
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          text: "/echo hello mobile",
          commandId: "mobile-turn-1",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: "Echo: hello mobile" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "set-auth-token",
    );
    expect(response.headers.get("vary")).toBe("origin");
    expect(loader.ids).toEqual(["mobile-user:foundation-v1"]);
  });

  test("shares rejections so the mobile client can read the status", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const response = await gateway(mobileRequest("/api/bots/primary/turns"));
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("vary")).toBe("origin");
  });

  test("exposes the sign-in token header from Better Auth routes", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const response = await gateway(
      mobileRequest("/api/auth/sign-in/social", { method: "POST" }),
    );
    expect(response.headers.get("set-auth-token")).toBe("test-token");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      MOBILE_ORIGIN,
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "set-auth-token",
    );
  });

  test("leaves same-origin and asset requests unchanged", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false, [
      MOBILE_ORIGIN,
    ]);
    const page = await gateway(new Request("https://frockbot.test/"));
    expect(page.status).toBe(200);
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("vary")).toBeNull();

    const asset = await gateway(mobileRequest("/app.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("carries no cross-origin headers when none are configured", async () => {
    const { gateway } = createTestGateway(undefined, bearerAuth, false);
    const response = await gateway(
      mobileRequest("/api/bots/primary/turns", { method: "OPTIONS" }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("authenticates bearer sessions through the identity seam", async () => {
    const { gateway, loader } = createTestGateway(undefined, bearerAuth, false);
    const rejected = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns"),
    );
    expect(rejected.status).toBe(401);
    expect(loader.ids).toEqual([]);

    const accepted = await gateway(
      new Request("https://frockbot.test/api/bots/primary/turns", {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(loader.ids).toEqual(["mobile-user:foundation-v1"]);
  });
});

describe("the remote Package Catalog routes", () => {
  const indexDocument = JSON.stringify({
    schemaVersion: 1,
    generation: "gen-one",
    entries: [],
  });
  const entryDocument = JSON.stringify({
    schemaVersion: 1,
    catalogId: "clock",
  });

  function catalogGateway(overrides: Partial<CatalogGatewayStore> = {}) {
    const catalog: CatalogGatewayStore = {
      readIndexDocument: (generation) =>
        Promise.resolve(
          generation !== undefined && generation !== "gen-one"
            ? undefined
            : {
                generation: "gen-one",
                hash: "a".repeat(64),
                document: indexDocument,
              },
        ),
      readEntryDocument: (catalogId) =>
        Promise.resolve(
          catalogId === "clock"
            ? {
                generation: "gen-one",
                hash: "b".repeat(64),
                document: entryDocument,
              }
            : undefined,
        ),
      ...overrides,
    };
    return createTestGateway(undefined, undefined, true, undefined, catalog);
  }

  test("serves the index with its content hash as an etag", async () => {
    const { gateway } = catalogGateway();
    const response = await gateway(request("/catalog/v1/index", "alice"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(indexDocument);
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    expect(response.headers.get("x-frockbot-catalog-generation")).toBe(
      "gen-one",
    );
    // The live read follows a pointer that moves, so it revalidates.
    expect(response.headers.get("cache-control")).toContain("must-revalidate");
  });

  test("a pinned generation is immutable and cached as such", async () => {
    const { gateway } = catalogGateway();
    const response = await gateway(
      request("/catalog/v1/index?generation=gen-one", "alice"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test("answers a matching etag with 304 and no body", async () => {
    const { gateway } = catalogGateway();
    const response = await gateway(
      request("/catalog/v1/index", "alice", {
        headers: { "if-none-match": `"${"a".repeat(64)}"` },
      }),
    );

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  test("serves one entry and 404s an entry the generation does not carry", async () => {
    const { gateway } = catalogGateway();

    expect(
      await (await gateway(request("/catalog/v1/entry/clock", "alice"))).text(),
    ).toBe(entryDocument);
    expect(
      (await gateway(request("/catalog/v1/entry/weather", "alice"))).status,
    ).toBe(404);
  });

  test("is authenticated, read-only, and refuses an unknown query", async () => {
    const { gateway } = catalogGateway();

    expect(
      (await gateway(new Request("https://frockbot.test/catalog/v1/index")))
        .status,
    ).toBe(401);
    expect(
      (await gateway(request("/catalog/v1/index", "alice", { method: "POST" })))
        .status,
    ).toBe(405);
    expect(
      (await gateway(request("/catalog/v1/index?q=1", "alice"))).status,
    ).toBe(400);
  });

  test("reports an unconfigured Catalog rather than falling through", async () => {
    const { gateway } = createTestGateway();
    const response = await gateway(request("/catalog/v1/index", "alice"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "Package Catalog is not configured",
    });
  });

  test("a generation that fails verification is a broken publish, not a body", async () => {
    const { gateway } = catalogGateway({
      readIndexDocument: () =>
        Promise.reject(
          new Error("catalog index failed content hash verification"),
        ),
    });
    const response = await gateway(request("/catalog/v1/index", "alice"));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "catalog index failed content hash verification",
    });
  });
});

describe("the Workspace seed door", () => {
  const seedRequest = (token: string | undefined, body: unknown) =>
    new Request("https://frockbot.test/api/workspace-seed/alice/bot-1", {
      method: "PUT",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const body = {
    root: {
      kind: "package-declared",
      userId: "alice",
      packageId: "applets",
      rootId: "source",
    },
    path: "u.applet/dist/server.js",
    bytesBase64: Buffer.from("export {}", "utf8").toString("base64"),
    mediaType: "application/javascript",
  };

  test("does not exist in a deployment that sets no seed token", async () => {
    const { gateway } = createTestGateway();
    expect((await gateway(seedRequest("anything", body))).status).toBe(404);
  });

  test("refuses a missing or wrong token and lands a User write with the right one", async () => {
    const writes: unknown[] = [];
    const { gateway } = createTestGateway(
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        token: "seed-secret",
        write: (userId, botId, request) => {
          writes.push({ userId, botId, ...request });
          return Promise.resolve({ status: "written", generationId: "g-1" });
        },
      },
    );
    expect((await gateway(seedRequest(undefined, body))).status).toBe(401);
    expect((await gateway(seedRequest("wrong", body))).status).toBe(401);
    expect(writes).toEqual([]);

    const response = await gateway(seedRequest("seed-secret", body));
    expect(response.status).toBe(200);
    const answer = (await response.json()) as {
      status: string;
      generationId: string;
    };
    expect(answer).toEqual({ status: "written", generationId: "g-1" });
    expect(writes).toEqual([{ userId: "alice", botId: "bot-1", ...body }]);
  });
});
