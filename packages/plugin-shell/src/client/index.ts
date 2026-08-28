/// <reference path="../env.d.ts" />

import type {
  ClientNotificationIntent,
  ClientPlugin,
  ClientRun,
  ClientTurnEvent,
} from "@frockbot/client-core";
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

export function projectCompletedRuns(
  messages: WebChatMessage[],
  notifications: readonly ClientNotificationIntent[],
  runs: readonly ClientRun[],
): Set<string> {
  const projected = new Set<string>();
  for (const run of runs) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    const notification = notifications.find(
      (candidate) => candidate.runId === run.runId,
    );
    if (
      !messages.some(
        (message) => message.runId === run.runId && message.role === "user",
      )
    ) {
      messages.push({
        id: `${run.runId}:user`,
        runId: run.runId,
        role: "user",
        text: run.input,
        status: "completed",
        tools: [],
      });
    }
    const assistant: WebChatMessage = {
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
    const assistantIndex = messages.findIndex(
      (message) => message.runId === run.runId && message.role === "assistant",
    );
    if (assistantIndex >= 0) messages[assistantIndex] = assistant;
    else messages.push(assistant);
    if (notification) projected.add(notification.notificationId);
  }
  return projected;
}

interface PendingConnectionOperation {
  commandId: string;
  createdAt: number;
  expiresAt?: number;
}

const CONNECTION_OPERATION_STORAGE_KEY =
  "frockbot.pending-connection-operations.v1";
const CONNECTION_OPERATION_MAX_AGE_MS = 10 * 60_000;

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
            typeof operation.expiresAt !== "number")
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
  if (!isRecord(value) || !Array.isArray(value.packages)) {
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

function selectedBotId(): string {
  try {
    return new URL(window.location.href).searchParams.get("bot") ?? "default";
  } catch {
    return "default";
  }
}

export const shellClientPlugin: ClientPlugin = (ctx) => {
  let activeRequest: AbortController | undefined;
  const botId = selectedBotId();
  const connectionOperations = readConnectionOperations();
  const authorizationOperations = new Map<
    string,
    { nativeReturnNonce?: string }
  >();

  async function deliverNotifications(): Promise<void> {
    const [notifications, runs] = await Promise.all([
      ctx.transport.listNotifications?.() ?? Promise.resolve([]),
      ctx.transport.listRuns?.() ?? Promise.resolve([]),
    ]);
    const projected = projectCompletedRuns(
      web.value.messages,
      notifications,
      runs,
    );
    if (!ctx.transport.acknowledgeNotification) return;
    for (const notification of notifications) {
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
      await ctx.transport.acknowledgeNotification(notification.notificationId);
    }
  }

  const web = ref<FrockBotWebData>({
    connection: "ready",
    modelLabel: "Foundation · Dynamic Worker",
    settingsAvailable: true,
    connectionsAvailable: true,
    messages: [],
    pluginCatalog: [],
    async loadBotSettings(): Promise<void> {
      if (!ctx.transport.readConfiguration) {
        web.value.settingsError = "Settings are unavailable";
        return;
      }
      try {
        web.value.botSettings = (await ctx.transport.readConfiguration({
          schemaVersion: 1,
          type: "bot/get",
          botId,
        })) as BotSettingsViewV1;
        web.value.settingsError = undefined;
        await deliverNotifications();
      } catch (error) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Could not load settings";
      }
    },
    async saveBotProfile(profile: BotProfile): Promise<void> {
      const current = web.value.botSettings;
      if (!current || !ctx.transport.executeConfiguration) {
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
      if (!current || !ctx.transport.executeConfiguration) {
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
        web.value.userSettings = (await ctx.transport.readConfiguration({
          schemaVersion: 1,
          type: "user/get",
        })) as UserSettingsViewV1;
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
        web.value.userSettings = settings as typeof web.value.userSettings;
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
    ): Promise<string> {
      if (!ctx.transport.startConnection) {
        throw new Error("Connections are unavailable");
      }
      const operationKey = `${botId}:${packageId}:${connectionTypeId}`;
      const now = Date.now();
      const existing = connectionOperations[operationKey];
      const expired =
        existing &&
        (existing.expiresAt ??
          existing.createdAt + CONNECTION_OPERATION_MAX_AGE_MS) <= now;
      if (expired) delete connectionOperations[operationKey];
      const operation = connectionOperations[operationKey] ?? {
        commandId: crypto.randomUUID(),
        createdAt: now,
      };
      connectionOperations[operationKey] = operation;
      writeConnectionOperations(connectionOperations);
      let result;
      try {
        result = await ctx.transport.startConnection({
          commandId: operation.commandId,
          packageId,
          connectionTypeId,
          botId,
        });
      } catch (error) {
        if (isDefinitiveConnectionFailure(error)) {
          delete connectionOperations[operationKey];
          writeConnectionOperations(connectionOperations);
        }
        throw error;
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
      const operation = authorizationOperations.get(url);
      if (ctx.transport.openExternalAuthorization) {
        await ctx.transport.openExternalAuthorization(
          url,
          operation?.nativeReturnNonce,
        );
        if (operation) {
          authorizationOperations.delete(url);
        }
        return;
      }
      window.location.assign(url);
    },
    async sendPrompt(text: string): Promise<SendPromptResult> {
      if (web.value.activeRunId) return { accepted: false, error: "busy" };
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
      activeRequest = new AbortController();
      try {
        if (!web.value.botSettings) await web.value.loadBotSettings();
        const result = await ctx.transport.turn(
          text,
          activeRequest.signal,
          pendingRunId,
        );
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
          await deliverNotifications();
        } catch (error) {
          web.value.settingsError =
            error instanceof Error
              ? error.message
              : "Notification delivery failed";
        }
        return { accepted: true, runId: result.runId };
      } catch (error) {
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        replaceMessage(web.value.messages, pendingRunId, {
          id: crypto.randomUUID(),
          runId: pendingRunId,
          role: "assistant",
          text: aborted ? "Request stopped locally." : "Agent request failed.",
          status: aborted ? "aborted" : "error",
          tools: [],
        });
        web.value.error = aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : "Agent request failed";
        return { accepted: true, runId: pendingRunId };
      } finally {
        activeRequest = undefined;
        web.value.activeRunId = undefined;
      }
    },
    async abort() {
      activeRequest?.abort();
    },
    async restart() {
      web.value.connection = "ready";
      web.value.error = undefined;
    },
  });

  return [
    ctx.provide(frockBotWebDataKey, web),
    ctx.slot({
      slot: "authenticated-root",
      order: 10_000,
      component: FrockBotApp,
    }),
    () => activeRequest?.abort(),
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
