/// <reference path="../env.d.ts" />

import {
  decodeExternalAuthorizationUrl,
  type ClientNotificationIntent,
  type ClientPlugin,
  type ClientRun,
  type ClientTurnEvent,
} from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import type {
  BotNotificationPolicy,
  BotProfile,
  BotSettingsViewV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { ref } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type PluginCatalogItem,
  type SendPromptResult,
  type WebActiveRun,
  type WebChatMessage,
  type WebToolActivity,
} from "../shared.js";
import FrockBotApp from "./FrockBotApp.vue";
import "@frockbot/client-core/fonts.css";
import "./styles.css";

function toolsFrom(events: ClientTurnEvent[]): WebToolActivity[] {
  const tools = new Map<string, WebToolActivity>();
  for (const event of events) {
    if (event.type === "tool/call" && event.call) {
      tools.set(event.call.id, {
        id: event.call.id,
        name: event.call.name,
        status: "running",
      });
    }
    if (event.type === "tool/result" && event.callId) {
      const tool = tools.get(event.callId);
      if (tool) {
        tool.status = event.isError ? "failed" : "completed";
        tool.text = event.content;
      }
    }
  }
  return [...tools.values()];
}

type DurableRunProjectionState = Pick<
  FrockBotWebData,
  "messages" | "activeRunId" | "activeRun" | "error"
>;

function activeRunView(run: ClientRun): WebActiveRun | undefined {
  if (run.status === "running") {
    return {
      runId: run.runId,
      status: run.status,
      message: run.stopRequestedAt
        ? "Stop accepted; waiting for durable settlement."
        : "This Turn is still running in the backend.",
      canResume: false,
    };
  }
  if (run.status === "reconciliation-required") {
    return {
      runId: run.runId,
      status: run.status,
      message: run.stopRequestedAt
        ? "Stop accepted; reconciling the provider outcome before cancelling."
        : (run.recovery?.message ??
          run.failure ??
          "This Turn requires provider reconciliation before it can continue."),
      canResume: !run.stopRequestedAt && run.recovery?.action === "resume",
    };
  }
  return undefined;
}

function isTerminalRun(run: ClientRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

function assistantMessage(
  run: ClientRun,
  notification: ClientNotificationIntent | undefined,
): WebChatMessage {
  if (run.status === "running") {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: run.responseText ?? "Working…",
      status: "streaming",
      tools: toolsFrom(run.events),
    };
  }
  if (run.status === "reconciliation-required") {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text:
        run.recovery?.message ??
        run.failure ??
        "Provider reconciliation is required before this Turn can continue.",
      status: "reconciliation-required",
      tools: toolsFrom(run.events),
    };
  }
  if (run.status === "cancelled") {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: run.failure ?? "Stopped by an authenticated Stop command.",
      status: "aborted",
      tools: toolsFrom(run.events),
    };
  }
  return {
    id: `${run.runId}:assistant`,
    runId: run.runId,
    role: "assistant",
    text:
      run.status === "failed"
        ? (run.failure ?? "Agent request failed.")
        : (run.responseText ?? notification?.body ?? ""),
    status: run.status === "failed" ? "error" : "completed",
    tools: toolsFrom(run.events),
  };
}

export function projectDurableRuns(
  state: DurableRunProjectionState,
  notifications: readonly ClientNotificationIntent[],
  runs: readonly ClientRun[],
): Set<string> {
  const projected = new Set<string>();
  const observedRunId = state.activeRunId;
  let activeRun: WebActiveRun | undefined;
  for (const run of runs) {
    const notification = notifications.find(
      (candidate) => candidate.runId === run.runId,
    );
    if (
      !state.messages.some(
        (message) => message.runId === run.runId && message.role === "user",
      )
    ) {
      state.messages.push({
        id: `${run.runId}:user`,
        runId: run.runId,
        role: "user",
        text: run.input,
        status: "completed",
        tools: [],
      });
    }
    const assistant = assistantMessage(run, notification);
    const assistantIndex = state.messages.findIndex(
      (message) => message.runId === run.runId && message.role === "assistant",
    );
    if (assistantIndex >= 0) state.messages[assistantIndex] = assistant;
    else state.messages.push(assistant);

    activeRun = activeRunView(run) ?? activeRun;
    if (notification && isTerminalRun(run)) {
      projected.add(notification.notificationId);
    }
  }

  if (observedRunId && runs.some((run) => run.runId === observedRunId)) {
    state.error = undefined;
  }

  if (activeRun) {
    state.activeRunId = activeRun.runId;
    state.activeRun = activeRun;
  } else {
    const terminalRunIds = new Set(
      runs.filter(isTerminalRun).map((run) => run.runId),
    );
    if (state.activeRunId && terminalRunIds.has(state.activeRunId)) {
      state.activeRunId = undefined;
    }
    if (state.activeRun && terminalRunIds.has(state.activeRun.runId)) {
      state.activeRun = undefined;
    }
  }
  return projected;
}

export function projectCompletedRuns(
  messages: WebChatMessage[],
  notifications: readonly ClientNotificationIntent[],
  runs: readonly ClientRun[],
): Set<string> {
  return projectDurableRuns(
    { messages },
    notifications,
    runs.filter(isTerminalRun),
  );
}

interface PendingConnectionOperation {
  commandId: string;
  createdAt: number;
  expiresAt?: number;
  nativeReturnNonce?: string;
}

const CONNECTION_OPERATION_STORAGE_KEY =
  "frockbot.pending-connection-operations.v1";

function readConnectionOperations(): Record<
  string,
  PendingConnectionOperation
> {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return {};
    const value: unknown = JSON.parse(
      storage.getItem(CONNECTION_OPERATION_STORAGE_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, candidate]) => {
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          return [];
        }
        const operation = candidate as Record<string, unknown>;
        if (
          typeof operation.commandId !== "string" ||
          typeof operation.createdAt !== "number" ||
          (operation.expiresAt !== undefined &&
            typeof operation.expiresAt !== "number") ||
          (operation.nativeReturnNonce !== undefined &&
            typeof operation.nativeReturnNonce !== "string")
        ) {
          return [];
        }
        return [
          [
            key,
            {
              commandId: operation.commandId,
              createdAt: operation.createdAt,
              ...(typeof operation.expiresAt === "number"
                ? { expiresAt: operation.expiresAt }
                : {}),
              ...(typeof operation.nativeReturnNonce === "string"
                ? { nativeReturnNonce: operation.nativeReturnNonce }
                : {}),
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}

function writeConnectionOperations(
  operations: Record<string, PendingConnectionOperation>,
): void {
  try {
    globalThis.localStorage?.setItem(
      CONNECTION_OPERATION_STORAGE_KEY,
      JSON.stringify(operations),
    );
  } catch {
    return;
  }
}

function synchronizeConnectionOperations(
  operations: Record<string, PendingConnectionOperation>,
): void {
  for (const key of Object.keys(operations)) delete operations[key];
  Object.assign(operations, readConnectionOperations());
}

async function reserveConnectionOperation(
  operations: Record<string, PendingConnectionOperation>,
  operationKey: string,
  create: () => PendingConnectionOperation,
): Promise<PendingConnectionOperation> {
  const reserve = () => {
    synchronizeConnectionOperations(operations);
    const operation = operations[operationKey] ?? create();
    operations[operationKey] = operation;
    writeConnectionOperations(operations);
    return operation;
  };
  const locks = globalThis.navigator?.locks;
  return locks
    ? locks.request(
        `${CONNECTION_OPERATION_STORAGE_KEY}:${operationKey}`,
        reserve,
      )
    : reserve();
}

function retireSettledConnectionOperations(
  operations: Record<string, PendingConnectionOperation>,
  settings: UserSettingsViewV1,
): void {
  synchronizeConnectionOperations(operations);
  let changed = false;
  for (const [key, operation] of Object.entries(operations)) {
    const connection = settings.connections.find(
      (candidate) => candidate.connectionId === operation.commandId,
    );
    if (
      connection &&
      (connection.state === "ready" ||
        connection.state === "failed" ||
        connection.state === "revoked")
    ) {
      delete operations[key];
      changed = true;
    }
  }
  if (changed) writeConnectionOperations(operations);
}

function isDefinitiveConnectionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "definitive" in error &&
    error.definitive === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePluginCatalog(value: unknown): PluginCatalogItem[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.packages)
  ) {
    throw new Error("Application manifest is invalid");
  }
  return value.packages.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.configuration)) return [];
    const connectionTypes = candidate.configuration.connectionTypes;
    if (!Array.isArray(connectionTypes) || connectionTypes.length === 0) {
      return [];
    }
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.version !== "string"
    ) {
      throw new Error("Application Package metadata is invalid");
    }
    const decodedConnections = connectionTypes.map((connection) => {
      if (
        !isRecord(connection) ||
        !isRecord(connection.authorization) ||
        typeof connection.id !== "string" ||
        typeof connection.displayName !== "string" ||
        typeof connection.allowMultiple !== "boolean" ||
        (connection.authorization.kind !== "oauth2" &&
          connection.authorization.kind !== "api-key" &&
          connection.authorization.kind !== "custom") ||
        !Array.isArray(connection.capabilities) ||
        !connection.capabilities.every((item) => typeof item === "string")
      ) {
        throw new Error("Application Connection Type metadata is invalid");
      }
      const authorizationKind: PluginCatalogItem["connectionTypes"][number]["authorizationKind"] =
        connection.authorization.kind;
      return {
        id: connection.id,
        displayName: connection.displayName,
        allowMultiple: connection.allowMultiple,
        authorizationKind,
        capabilities: connection.capabilities as string[],
      };
    });
    return [
      {
        packageId: candidate.id,
        displayName:
          typeof candidate.displayName === "string"
            ? candidate.displayName
            : candidate.id,
        version: candidate.version,
        connectionTypes: decodedConnections,
      },
    ];
  });
}

export const shellClientPlugin: ClientPlugin = (ctx) => {
  const surfaces = createClientSurfaceRegistry();
  let activeRequest: AbortController | undefined;
  let admissionObserver: AbortController | undefined;
  let runObserver: AbortController | undefined;
  let selectionGeneration = 0;
  const connectionOperations = readConnectionOperations();
  const stopCommands = new Map<string, string>();
  const authorizationOperations = new Map<
    string,
    { nativeReturnNonce?: string }
  >();

  async function waitForRunLookup(
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, delayMs);
      function finish() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  async function observeWhileAttached<T>(
    operation: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
    }
  }

  async function reconcileUncertainAdmission(
    botId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<"admitted" | "not-admitted" | "detached"> {
    web.value.activeRun = {
      runId,
      status: "running",
      message: "Confirming whether this Turn was admitted.",
      canResume: false,
    };
    if (!ctx.transport.lookupRun || !ctx.transport.fenceRunAdmission) {
      return "detached";
    }
    let delayMs = 250;
    let reconciliationError: string | undefined;
    const clearReconciliationError = () => {
      if (web.value.settingsError === reconciliationError) {
        web.value.settingsError = undefined;
      }
      reconciliationError = undefined;
    };
    while (!signal.aborted) {
      try {
        const observed = await observeWhileAttached(
          ctx.transport.lookupRun(botId, runId),
          signal,
        );
        clearReconciliationError();
        const run =
          observed ??
          (await observeWhileAttached(
            ctx.transport.fenceRunAdmission(botId, runId),
            signal,
          ));
        clearReconciliationError();
        if (signal.aborted) return "detached";
        if (!run) {
          web.value.activeRun = undefined;
          return "not-admitted";
        }
        projectDurableRuns(web.value, [], [run]);
        if (isTerminalRun(run)) return "admitted";
      } catch (error) {
        if (signal.aborted) return "detached";
        reconciliationError = `${
          error instanceof Error
            ? error.message
            : "Turn admission lookup failed"
        } Retrying…`;
        web.value.settingsError = reconciliationError;
      }
      await waitForRunLookup(delayMs, signal);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
    return "detached";
  }

  async function observeRunUntilTerminal(
    botId: string,
    runId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!ctx.transport.lookupRun) return;
    let delayMs = 250;
    let observationError: string | undefined;
    while (!signal.aborted) {
      try {
        const run = await observeWhileAttached(
          ctx.transport.lookupRun(botId, runId),
          signal,
        );
        if (
          signal.aborted ||
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        ) {
          return;
        }
        if (!run) throw new Error("Stopped Turn is unavailable");
        if (web.value.settingsError === observationError) {
          web.value.settingsError = undefined;
        }
        observationError = undefined;
        projectDurableRuns(web.value, [], [run]);
        if (isTerminalRun(run)) return;
      } catch (error) {
        if (signal.aborted) return;
        observationError = `${
          error instanceof Error ? error.message : "Turn lookup failed"
        } Retrying…`;
        web.value.settingsError = observationError;
      }
      await waitForRunLookup(delayMs, signal);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }

  async function deliverNotifications(
    botId: string,
    generation = selectionGeneration,
  ): Promise<void> {
    const runs = await (ctx.transport.listRuns?.(botId) ?? Promise.resolve([]));
    if (generation !== selectionGeneration || web.value.activeBotId !== botId)
      return;
    projectDurableRuns(web.value, [], runs);
    let notifications: ClientNotificationIntent[];
    try {
      notifications = await (ctx.transport.listNotifications?.(botId) ??
        Promise.resolve([]));
      if (generation !== selectionGeneration || web.value.activeBotId !== botId)
        return;
    } catch (error) {
      if (generation !== selectionGeneration || web.value.activeBotId !== botId)
        return;
      web.value.settingsError =
        error instanceof Error ? error.message : "Could not load notifications";
      return;
    }
    if (generation !== selectionGeneration || web.value.activeBotId !== botId)
      return;
    const projected = projectDurableRuns(web.value, notifications, runs);
    if (!ctx.transport.acknowledgeNotification) return;
    for (const notification of notifications) {
      if (generation !== selectionGeneration || web.value.activeBotId !== botId)
        return;
      if (!projected.has(notification.notificationId)) {
        web.value.settingsError = "A completed Bot result is waiting to load";
        continue;
      }
      if (document.hidden) {
        if (
          !("Notification" in window) ||
          Notification.permission !== "granted"
        ) {
          web.value.settingsError =
            "A completed Bot notification is waiting for permission";
          continue;
        }
        new Notification(notification.title, { body: notification.body });
      }
      await ctx.transport.acknowledgeNotification(
        botId,
        notification.notificationId,
      );
    }
  }

  const web = ref<FrockBotWebData>({
    connection: "ready",
    modelLabel: "Foundation · Dynamic Worker",
    settingsAvailable: true,
    connectionsAvailable: ctx.transport.connectionsAvailable !== false,
    activeBotId: undefined,
    composerContext: undefined,
    messages: [],
    pluginCatalog: [],
    async selectBot(botId: string): Promise<void> {
      activeRequest?.abort();
      admissionObserver?.abort();
      runObserver?.abort();
      selectionGeneration += 1;
      web.value.activeBotId = botId;
      web.value.composerContext = botId;
      web.value.botSettings = undefined;
      web.value.messages = [];
      web.value.activeRun = undefined;
      web.value.activeRunId = undefined;
      const url = URL.parse(window.location.href);
      if (url) {
        url.searchParams.set("bot", botId);
        window.history.replaceState(null, "", url);
      }
      await web.value.loadBotSettings();
    },
    async loadBotSettings(): Promise<void> {
      if (!ctx.transport.readConfiguration) {
        web.value.settingsError = "Settings are unavailable";
        return;
      }
      const botId = web.value.activeBotId;
      if (!botId) return;
      const generation = selectionGeneration;
      try {
        const settings = (await ctx.transport.readConfiguration({
          schemaVersion: 1,
          type: "bot/get",
          botId,
        })) as BotSettingsViewV1;
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.botSettings = settings;
        web.value.settingsError = undefined;
        await deliverNotifications(botId, generation);
      } catch (error) {
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.settingsError =
          error instanceof Error ? error.message : "Could not load settings";
      }
    },
    async saveBotProfile(profile: BotProfile): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        profile,
      });
      await web.value.loadBotSettings();
    },
    async saveBotNotifications(
      notifications: BotNotificationPolicy,
    ): Promise<void> {
      if (
        notifications.enabled &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          throw new Error("Notification permission was not granted");
        }
      }
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        notifications,
      });
      await web.value.loadBotSettings();
    },
    async loadUserSettings(): Promise<void> {
      if (!ctx.transport.readConfiguration) {
        web.value.settingsError = "Settings are unavailable";
        return;
      }
      try {
        const settings = (await ctx.transport.readConfiguration({
          schemaVersion: 1,
          type: "user/get",
        })) as UserSettingsViewV1;
        retireSettledConnectionOperations(connectionOperations, settings);
        web.value.userSettings = settings;
        web.value.settingsError = undefined;
      } catch (error) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Could not load settings";
      }
    },
    async saveUserProfile(profile: {
      name: string;
      email?: string;
    }): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/update-profile",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        profile,
      });
      await web.value.loadUserSettings();
    },
    async loadPluginCatalog(): Promise<void> {
      if (
        !ctx.transport.readApplicationManifest ||
        !ctx.transport.readConfiguration
      ) {
        web.value.settingsError = "Plugins are unavailable";
        return;
      }
      try {
        const [manifest, settings] = await Promise.all([
          ctx.transport.readApplicationManifest(),
          ctx.transport.readConfiguration({
            schemaVersion: 1,
            type: "user/get",
          }),
        ]);
        web.value.pluginCatalog = decodePluginCatalog(manifest);
        const userSettings = settings as UserSettingsViewV1;
        retireSettledConnectionOperations(connectionOperations, userSettings);
        web.value.userSettings = userSettings;
        web.value.settingsError = undefined;
      } catch (error) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Could not load Plugins";
      }
    },
    async installPackage(packageId: string, version: string): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Plugins are unavailable");
      }
      await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/install-package",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
        version,
      });
      await web.value.loadPluginCatalog();
    },
    async startConnection(
      packageId: string,
      connectionTypeId: string,
    ): Promise<string | undefined> {
      if (!ctx.transport.startConnection) {
        throw new Error("Connections are unavailable");
      }
      const userId = await ctx.transport.readAuthenticatedUserId?.();
      if (!userId) {
        throw new Error("Authenticated User identity is unavailable");
      }
      const operationKey = JSON.stringify([
        userId,
        packageId,
        connectionTypeId,
      ]);
      const operation = await reserveConnectionOperation(
        connectionOperations,
        operationKey,
        () => ({
          commandId: crypto.randomUUID(),
          createdAt: Date.now(),
          ...("frockbotDesktop" in (globalThis.window ?? {})
            ? { nativeReturnNonce: crypto.randomUUID() }
            : {}),
        }),
      );
      let result;
      try {
        result = await ctx.transport.startConnection({
          commandId: operation.commandId,
          packageId,
          connectionTypeId,
          nativeReturnNonce: operation.nativeReturnNonce,
        });
      } catch (error) {
        if (isDefinitiveConnectionFailure(error)) {
          delete connectionOperations[operationKey];
          writeConnectionOperations(connectionOperations);
        }
        throw error;
      }
      if (result.status === "ready") {
        delete connectionOperations[operationKey];
        writeConnectionOperations(connectionOperations);
        return undefined;
      }
      const expiresAt = Date.parse(result.expiresAt);
      if (Number.isFinite(expiresAt)) operation.expiresAt = expiresAt;
      writeConnectionOperations(connectionOperations);
      authorizationOperations.set(result.redirectUrl, {
        nativeReturnNonce: result.nativeReturnNonce,
      });
      return result.redirectUrl;
    },
    async revokeConnection(
      packageId: string,
      connectionId: string,
    ): Promise<void> {
      if (!ctx.transport.revokeConnection) {
        throw new Error("Connections are unavailable");
      }
      await ctx.transport.revokeConnection(packageId, connectionId);
      await web.value.loadPluginCatalog();
    },
    async openConnectionAuthorization(url: string): Promise<void> {
      const authorizationUrl = decodeExternalAuthorizationUrl(url);
      const operation = authorizationOperations.get(authorizationUrl);
      if (ctx.transport.openExternalAuthorization) {
        await ctx.transport.openExternalAuthorization(
          authorizationUrl,
          operation?.nativeReturnNonce,
        );
        if (operation) {
          authorizationOperations.delete(authorizationUrl);
        }
        return;
      }
      window.location.assign(authorizationUrl);
    },
    async sendPrompt(text: string): Promise<SendPromptResult> {
      if (web.value.activeRunId) return { accepted: false, error: "busy" };
      const botId = web.value.activeBotId;
      if (!botId) return { accepted: false, error: "no-bot" };
      const generation = selectionGeneration;
      const pendingRunId = crypto.randomUUID();
      web.value.activeRunId = pendingRunId;
      web.value.error = undefined;
      web.value.messages.push(
        {
          id: crypto.randomUUID(),
          runId: pendingRunId,
          role: "user",
          text,
          status: "completed",
          tools: [],
        },
        {
          id: crypto.randomUUID(),
          runId: pendingRunId,
          role: "assistant",
          text: "",
          status: "streaming",
          tools: [],
        },
      );
      const requestController = new AbortController();
      activeRequest = requestController;
      try {
        if (!web.value.botSettings) await web.value.loadBotSettings();
        if (
          requestController.signal.aborted ||
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return { accepted: true, runId: pendingRunId };
        const result = await ctx.transport.turn(
          botId,
          text,
          requestController.signal,
          pendingRunId,
        );
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return { accepted: true, runId: result.runId };
        for (const message of web.value.messages) {
          if (message.runId === pendingRunId) message.runId = result.runId;
        }
        replaceMessage(web.value.messages, result.runId, {
          id: crypto.randomUUID(),
          runId: result.runId,
          role: "assistant",
          text: result.text,
          status: "completed",
          tools: toolsFrom(result.events),
        });
        try {
          await deliverNotifications(botId, generation);
        } catch (error) {
          if (
            generation === selectionGeneration &&
            web.value.activeBotId === botId
          )
            web.value.settingsError =
              error instanceof Error
                ? error.message
                : "Notification delivery failed";
        }
        return { accepted: true, runId: result.runId };
      } catch (error) {
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return { accepted: true, runId: pendingRunId };
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        replaceMessage(web.value.messages, pendingRunId, {
          id: crypto.randomUUID(),
          runId: pendingRunId,
          role: "assistant",
          text: aborted
            ? "Request stopped locally; admission may still be durable."
            : "Confirming whether this Turn was admitted.",
          status: "interrupted",
          tools: [],
        });
        web.value.error = aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : "Agent request failed";
        const observer = new AbortController();
        admissionObserver = observer;
        let disposition: "admitted" | "not-admitted" | "detached";
        try {
          disposition = await reconcileUncertainAdmission(
            botId,
            pendingRunId,
            observer.signal,
          );
        } finally {
          if (admissionObserver === observer) admissionObserver = undefined;
        }
        if (disposition === "not-admitted") {
          replaceMessage(web.value.messages, pendingRunId, {
            id: crypto.randomUUID(),
            runId: pendingRunId,
            role: "assistant",
            text: "Turn was not admitted.",
            status: "error",
            tools: [],
          });
          web.value.error = "Turn was not admitted";
          return { accepted: false, error: "Turn was not admitted" };
        }
        return { accepted: true, runId: pendingRunId };
      } finally {
        if (activeRequest === requestController) activeRequest = undefined;
        if (
          web.value.activeRunId === pendingRunId &&
          web.value.activeRun?.runId !== pendingRunId
        ) {
          web.value.activeRunId = undefined;
        }
      }
    },
    async resumeRun(runId: string): Promise<void> {
      if (!ctx.transport.reconcileRun) {
        web.value.settingsError = "Turn reconciliation is unavailable";
        return;
      }
      if (web.value.activeRun?.runId !== runId) return;
      web.value.activeRun = {
        runId,
        status: "running",
        message: "Reconciliation requested; waiting for durable progress.",
        canResume: false,
      };
      const botId = web.value.activeBotId;
      if (!botId) return;
      try {
        await ctx.transport.reconcileRun(botId, runId);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Reconciliation failed";
      }
      try {
        await deliverNotifications(botId);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not refresh the reconciled Turn";
      }
    },
    async stopRun(): Promise<void> {
      const botId = web.value.activeBotId;
      const runId = web.value.activeRun?.runId ?? web.value.activeRunId;
      if (!botId || !runId) return;
      if (!ctx.transport.stopRun) {
        web.value.settingsError = "Stop is unavailable";
        return;
      }
      const generation = selectionGeneration;
      // One durable command per observed run, so repeated Stops replay exactly.
      const commandId = stopCommands.get(runId) ?? crypto.randomUUID();
      stopCommands.set(runId, commandId);
      try {
        const run = await ctx.transport.stopRun(botId, runId, commandId);
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        projectDurableRuns(web.value, [], [run]);
        if (!isTerminalRun(run) && ctx.transport.lookupRun) {
          runObserver?.abort();
          const observer = new AbortController();
          runObserver = observer;
          try {
            await observeRunUntilTerminal(
              botId,
              runId,
              generation,
              observer.signal,
            );
          } finally {
            if (runObserver === observer) runObserver = undefined;
          }
        }
      } catch (error) {
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.settingsError =
          error instanceof Error ? error.message : "Stop failed";
      }
    },
    async abort() {
      activeRequest?.abort();
    },
  });

  return [
    ctx.provide(clientSurfaceRegistryKey, surfaces),
    ctx.provide(frockBotWebDataKey, web),
    ctx.slot({
      slot: "authenticated-root",
      order: 10_000,
      component: FrockBotApp,
    }),
    () => {
      activeRequest?.abort();
      admissionObserver?.abort();
      runObserver?.abort();
    },
  ];
};

function replaceMessage(
  messages: WebChatMessage[],
  runId: string,
  replacement: WebChatMessage,
): void {
  const index = messages.findIndex(
    (message) => message.runId === runId && message.role === "assistant",
  );
  if (index >= 0) messages[index] = replacement;
}

export default shellClientPlugin;
