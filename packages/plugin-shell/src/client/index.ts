/// <reference path="../env.d.ts" />

import {
  decodeExternalAuthorizationUrl,
  type AgentTransport,
  type ClientAnnouncement,
  type ClientNotificationIntent,
  type ClientPlugin,
  type ClientRun,
  type ClientStartConnectionResult,
  type ClientTurnEvent,
} from "@frockbot/client-core";
import { clientSurfaceRegistryKey } from "@frockbot/client-core";
// Connection mutations use the provider-neutral hosted command contract.
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
} from "@frockbot/connection-core";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import { decodeSendToUserPayloadV1 } from "@frockbot/kernel-contracts";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import { decodeBotAvatarUploadReceiptV1 } from "@frockbot/configuration-core";
import type {
  BotAvatarContentTypeV1,
  BotNameProvenanceV1,
  BotNotificationPolicy,
  BotProfile,
  BotProfilePatchV1,
  BotSettingsViewV1,
  ConfigurationCommandV1,
  JsonValue,
  ModelAssignment,
  OperationReceiptV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeCatalogEntryV1,
  decodeCatalogIndexV1,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
} from "@frockbot/catalog-core";
import type { SkillRefV1 } from "@frockbot/kernel-contracts";
import {
  decodeMcpLifecycleReceiptV1,
  decodeMcpServerStatusViewV1,
} from "@frockbot/plugin-mcp/records";
import {
  MCP_CONNECTIONS_ROUTE,
  MCP_SERVERS_ROUTE,
} from "@frockbot/plugin-mcp/backend";
import { MCP_OAUTH_CONNECTION_TYPE_ID } from "@frockbot/plugin-mcp/agent";
import { decodeStartConnectionResultV1 } from "@frockbot/connection-core";
import { decodeClientSkillCatalogV1 } from "../skill-protocol.js";
import {
  decodeApprovalDecisionReceiptV1,
  decodeApprovalListViewV1,
} from "../approvals.js";
import { ref } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  type PluginCatalogItem,
  type SendPromptResult,
  type WebActiveRun,
  type WebChatMessage,
  type WebSendPayload,
  type WebToolActivity,
} from "../shared.js";
import FrockBotApp from "./FrockBotApp.vue";
import { modelRuntimeLabel } from "./model-presentation.js";
import { showClientNotificationV1 } from "./notify.js";
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
        if (event.attachments && event.attachments.length > 0) {
          tool.attachments = event.attachments.map((attachment) => ({
            kind: attachment.kind,
            mediaType: attachment.mediaType,
            contentHash: attachment.contentHash,
            path: attachment.path,
          }));
        }
      }
    }
  }
  return [...tools.values()];
}

/**
 * The Turn's sends, decoded for the thread. A payload this client cannot
 * decode becomes an `unsupported` entry: a run has to render on a client older
 * than the Bot that produced it, so an unknown shape is a line in the
 * conversation and never an exception.
 */
function sendsFrom(events: ClientTurnEvent[]): WebSendPayload[] {
  const sends: WebSendPayload[] = [];
  for (const event of events) {
    if (event.type !== "send/to-user") continue;
    try {
      sends.push({
        kind: "payload",
        payload: decodeSendToUserPayloadV1(event.payload),
      });
    } catch {
      sends.push({ kind: "unsupported" });
    }
  }
  return sends;
}

type DurableRunProjectionState = Pick<
  FrockBotWebData,
  "messages" | "activeRunId" | "activeRun" | "error"
>;

/**
 * The banner exists for Turns the User has to act on. A running Turn is shown
 * by the animated Bot avatar in the thread, so it produces no banner.
 */
function activeRunView(run: ClientRun): WebActiveRun | undefined {
  if (run.status === "running") {
    // A plain running Turn is shown by the animated Bot avatar, so it has no
    // banner. Once a durable Stop has been accepted the User is waiting on a
    // settlement they asked for, and the banner reports it.
    if (!run.stopRequestedAt) return undefined;
    return {
      runId: run.runId,
      status: run.status,
      message: "Stop accepted; waiting for durable settlement.",
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
    // A streaming Turn carries only the text the model has produced. Until
    // there is any, the thread shows the animated avatar and no bubble.
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: run.responseText ?? "",
      status: "streaming",
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
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
      sends: sendsFrom(run.events),
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
      sends: sendsFrom(run.events),
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
    sends: sendsFrom(run.events),
  };
}

/**
 * Projects the Session's announcements as system lines. They carry an `at`
 * timestamp so the thread can place them among the Turns they happened
 * between, and they replace rather than duplicate on every reload.
 */
export function projectAnnouncements(
  messages: WebChatMessage[],
  announcements: readonly ClientAnnouncement[],
): void {
  for (const announcement of announcements) {
    const message: WebChatMessage = {
      id: announcement.announcementId,
      runId: announcement.announcementId,
      role: "system",
      text: `Renamed to ${announcement.to} by ${announcement.namedBy}`,
      at: announcement.at,
      status: "completed",
      tools: [],
      sends: [],
    };
    const index = messages.findIndex(
      (candidate) => candidate.id === announcement.announcementId,
    );
    if (index >= 0) messages[index] = message;
    else messages.push(message);
  }
}

export function projectDurableRuns(
  state: DurableRunProjectionState,
  notifications: readonly ClientNotificationIntent[],
  runs: readonly ClientRun[],
): Set<string> {
  const projected = new Set<string>();
  const observedRunId = state.activeRunId;
  let activeRun: WebActiveRun | undefined;
  // Busy state and the banner are separate: a running Turn keeps the composer
  // busy without producing a banner of its own.
  let busyRunId: string | undefined;
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
        ...(run.admittedAt ? { at: run.admittedAt } : {}),
        status: "completed",
        tools: [],
        sends: [],
      });
    }
    const assistant = assistantMessage(run, notification);
    if (run.admittedAt) assistant.at = run.admittedAt;
    const assistantIndex = state.messages.findIndex(
      (message) => message.runId === run.runId && message.role === "assistant",
    );
    if (assistantIndex >= 0) state.messages[assistantIndex] = assistant;
    else state.messages.push(assistant);

    activeRun = activeRunView(run) ?? activeRun;
    if (run.status === "running" || run.status === "reconciliation-required") {
      busyRunId = run.runId;
    }
    if (notification && isTerminalRun(run)) {
      projected.add(notification.notificationId);
    }
  }

  if (observedRunId && runs.some((run) => run.runId === observedRunId)) {
    state.error = undefined;
  }

  const terminalRunIds = new Set(
    runs.filter(isTerminalRun).map((run) => run.runId),
  );
  if (busyRunId) state.activeRunId = busyRunId;
  else if (state.activeRunId && terminalRunIds.has(state.activeRunId)) {
    state.activeRunId = undefined;
  }
  if (activeRun) state.activeRun = activeRun;
  else if (
    state.activeRun &&
    runs.some((run) => run.runId === state.activeRun?.runId)
  ) {
    // The Turn this banner described has moved on to a state that needs none.
    state.activeRun = undefined;
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
  packageId?: string;
  connectionId?: string;
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
        const allowed = new Set([
          "commandId",
          "createdAt",
          "expiresAt",
          "nativeReturnNonce",
          "packageId",
          "connectionId",
        ]);
        if (
          Object.keys(operation).some((field) => !allowed.has(field)) ||
          typeof operation.commandId !== "string" ||
          typeof operation.createdAt !== "number" ||
          (operation.expiresAt !== undefined &&
            typeof operation.expiresAt !== "number") ||
          (operation.nativeReturnNonce !== undefined &&
            typeof operation.nativeReturnNonce !== "string") ||
          (operation.packageId !== undefined &&
            typeof operation.packageId !== "string") ||
          (operation.connectionId !== undefined &&
            typeof operation.connectionId !== "string")
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
              ...(typeof operation.packageId === "string"
                ? { packageId: operation.packageId }
                : {}),
              ...(typeof operation.connectionId === "string"
                ? { connectionId: operation.connectionId }
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
  settled?: (operation: PendingConnectionOperation) => Promise<boolean>,
): Promise<PendingConnectionOperation> {
  const reserve = async () => {
    synchronizeConnectionOperations(operations);
    let operation: PendingConnectionOperation | undefined =
      operations[operationKey];
    if (operation && settled && (await settled(operation))) {
      delete operations[operationKey];
      operation = undefined;
    }
    operation ??= create();
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
    if (operation.connectionId !== undefined) continue;
    const connection = settings.connections.find(
      (candidate) =>
        candidate.connectionId === operation.commandId ||
        candidate.safeMetadata.creationCommandId === operation.commandId,
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

async function reconcileRetainedConnectionCommands(
  operations: Record<string, PendingConnectionOperation>,
  lookup: AgentTransport["lookupConnectionCommand"] | undefined,
): Promise<void> {
  if (!lookup) return;
  synchronizeConnectionOperations(operations);
  let changed = false;
  for (const [key, operation] of Object.entries(operations)) {
    if (!operation.packageId || !operation.connectionId) continue;
    try {
      const receipt = await lookup(operation.packageId, operation.commandId);
      if (!receipt) continue;
      delete operations[key];
      changed = true;
    } catch (error) {
      void error;
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

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

export function decodePluginCatalog(value: unknown): PluginCatalogItem[] {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "schemaVersion",
      "deployment",
      "applicationHash",
      "packages",
    ]) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.deployment) ||
    !hasExactFields(value.deployment, ["userId", "applicationHash"]) ||
    typeof value.deployment.userId !== "string" ||
    value.deployment.userId.length === 0 ||
    value.deployment.userId.length > 256 ||
    typeof value.deployment.applicationHash !== "string" ||
    value.deployment.applicationHash.length === 0 ||
    value.deployment.applicationHash.length > 256 ||
    typeof value.applicationHash !== "string" ||
    value.applicationHash.length === 0 ||
    value.applicationHash.length > 256 ||
    // `deployment.applicationHash` names the artifact bytes the gateway
    // loaded; `applicationHash` is the compiled plan's digest. They differ
    // by construction, so each is checked on its own and never against
    // the other.
    !Array.isArray(value.packages) ||
    value.packages.length > 256
  ) {
    throw new Error("Application manifest is invalid");
  }
  return value.packages.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      // A Package that declares no configuration is serialised without the
      // key (JSON drops an undefined field), so the key is owned but optional.
      !hasExactFields(
        candidate,
        Object.hasOwn(candidate, "configuration")
          ? ["id", "displayName", "version", "contributions", "configuration"]
          : ["id", "displayName", "version", "contributions"],
      ) ||
      typeof candidate.id !== "string" ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.version !== "string" ||
      !Array.isArray(candidate.contributions) ||
      candidate.contributions.length > 5 ||
      new Set(candidate.contributions).size !==
        candidate.contributions.length ||
      !candidate.contributions.every(
        (kind) =>
          kind === "backend" ||
          kind === "runtime" ||
          kind === "client" ||
          kind === "desktop" ||
          kind === "mobile",
      )
    ) {
      throw new Error("Application Package metadata is invalid");
    }
    const decoded = decodeFrockBotManifest({
      // v5, so a Capability carrying an admission ceiling or the `channel`
      // kind decodes here too. Both are durable manifest state the Plugins
      // surface does not render; refusing the manifest over either would hide
      // the whole Package.
      schemaVersion: 5,
      id: candidate.id,
      displayName: candidate.displayName,
      version: candidate.version,
      compatibility: { frockbot: "*" },
      dependencies: {},
      contributions: { runtime: { entry: "./manifest-validation.js" } },
      permissions: [],
      configuration: candidate.configuration,
    });
    const connectionTypes = decoded.configuration?.connectionTypes ?? [];
    const decodedCapabilities = (decoded.configuration?.capabilities ?? []).map(
      (capability) => ({
        id: capability.id,
        kind: capability.kind,
        connectionTypes: capability.connectionTypes,
      }),
    );
    // A Package with neither a Connection Type nor a Capability contributes
    // nothing the Plugins surface can install or assign. A Capability that
    // takes no Connection still counts: a tool Package a User installs and
    // assigns without any credential is exactly that shape.
    if (connectionTypes.length === 0 && decodedCapabilities.length === 0) {
      return [];
    }
    const decodedConnections = connectionTypes.map((connection) => {
      const authorizationKind: PluginCatalogItem["connectionTypes"][number]["authorizationKind"] =
        connection.authorization.kind;
      return {
        id: connection.id,
        displayName: connection.displayName,
        allowMultiple: connection.allowMultiple,
        authorizationKind,
        capabilities: connection.capabilities,
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
        capabilities: decodedCapabilities,
        connectionTypes: decodedConnections,
        // User-scoped settings only: a `bot`-scoped one is not the Plugins
        // surface's to edit, and a Connection-scoped one is edited with its
        // Connection.
        settings: (decoded.configuration?.settings ?? []).filter((setting) =>
          setting.scopes.includes("user"),
        ),
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
  let userSettingsGeneration = 0;
  let pluginCatalogGeneration = 0;
  let packageCatalogGeneration = 0;
  const settingsLoadErrors = new Map<
    "bot" | "user" | "catalog" | "package-catalog",
    string
  >();
  const connectionOperations = readConnectionOperations();
  const stopCommands = new Map<string, string>();
  const authorizationOperations = new Map<
    string,
    { nativeReturnNonce?: string }
  >();

  async function executeRetainedApiKeyCommand(
    identity: readonly string[],
    create: (commandId: string) => ConnectionCommandV1,
    pending: Pick<
      PendingConnectionOperation,
      "packageId" | "connectionId"
    > = {},
  ): Promise<ConnectionCommandReceiptV1> {
    if (!ctx.transport.executeConnection) {
      throw new Error("Connections are unavailable");
    }
    const userId = await ctx.transport.readAuthenticatedUserId?.();
    if (!userId) {
      throw new Error("Authenticated User identity is unavailable");
    }
    const operationKey = JSON.stringify(["api-key", userId, ...identity]);
    const operation = await reserveConnectionOperation(
      connectionOperations,
      operationKey,
      () => ({
        commandId: crypto.randomUUID(),
        createdAt: Date.now(),
        ...pending,
      }),
      pending.packageId &&
        pending.connectionId &&
        ctx.transport.lookupConnectionCommand
        ? async (existing) =>
            Boolean(
              await ctx.transport.lookupConnectionCommand!(
                pending.packageId!,
                existing.commandId,
              ),
            )
        : undefined,
    );
    try {
      const result = await ctx.transport.executeConnection(
        create(operation.commandId),
      );
      delete connectionOperations[operationKey];
      writeConnectionOperations(connectionOperations);
      return result;
    } catch (error) {
      if (isDefinitiveConnectionFailure(error)) {
        delete connectionOperations[operationKey];
        writeConnectionOperations(connectionOperations);
      }
      throw error;
    }
  }

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
    try {
      const announcements = await (ctx.transport.listAnnouncements?.(botId) ??
        Promise.resolve([]));
      if (generation === selectionGeneration && web.value.activeBotId === botId)
        projectAnnouncements(web.value.messages, announcements);
    } catch {
      // Announcements are conversational history, never admission: a Session
      // that cannot read them still shows every Turn.
    }
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
    // A decision may have been recorded on another device since the last poll,
    // and an expiry is recorded by an alarm nobody clicked.
    await web.value.loadApprovals();
    if (generation !== selectionGeneration || web.value.activeBotId !== botId)
      return;
    if (!ctx.transport.acknowledgeNotification) return;
    for (const notification of notifications) {
      if (generation !== selectionGeneration || web.value.activeBotId !== botId)
        return;
      if (!projected.has(notification.notificationId)) {
        web.value.settingsError = "A completed Bot result is waiting to load";
        continue;
      }
      if (document.hidden) {
        // One seam: the desktop or mobile notifications Package when the shell
        // exposes it, the web API when it does not.
        const delivery = await showClientNotificationV1({
          title: notification.title,
          body: notification.body,
          // An approval is recorded at `critical` whatever the Bot's
          // notification policy says; the shell decides what critical means.
          ...(notification.urgency === undefined
            ? {}
            : { urgency: notification.urgency }),
        });
        if (delivery === "unavailable") {
          web.value.settingsError =
            "A completed Bot notification is waiting for permission";
          continue;
        }
      }
      await ctx.transport.acknowledgeNotification(
        botId,
        notification.notificationId,
      );
    }
  }

  async function executeAssignmentOperation(
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/assign-capability"
          | "bot/replace-capability"
          | "bot/unassign-capability";
      }
    >,
  ): Promise<void> {
    const execute = ctx.transport.executeConfiguration;
    if (!execute) throw new Error("Settings are unavailable");
    const receipt = (await execute(command)) as OperationReceiptV1;
    await web.value.loadBotSettings();
    if (receipt.status === "rejected") {
      const failure = receipt.failure ?? "Assignment operation was rejected";
      web.value.settingsError = failure;
      throw new Error(failure);
    }
    if (receipt.status === "pending") {
      web.value.settingsError = "Assignment operation is retrying.";
    }
  }

  function updateSettingsLoadError(
    source: "bot" | "user" | "catalog" | "package-catalog",
    message?: string,
  ): void {
    settingsLoadErrors.delete(source);
    if (message) settingsLoadErrors.set(source, message);
    web.value.settingsError = [...settingsLoadErrors.values()].at(-1);
  }

  /**
   * The Bot runs on its own model when it has one and on the User's default
   * otherwise, so readiness and the composer label follow the effective model.
   * A Bot following the default is ready as soon as the User's Connection is:
   * the Bot's own Assignment for that Connection is claimed durably when the
   * Turn is admitted.
   */
  function updateModelLabel(): void {
    const bot = web.value.botSettings;
    const user = web.value.userSettings;
    const model = bot?.model ?? user?.newBotModelTemplate;
    web.value.modelSource = bot?.model ? "bot" : model ? "default" : "none";
    const connection = (user?.connections ?? []).find(
      (candidate) => candidate.connectionId === model?.connectionId,
    );
    const packageInstalled = (user?.packages ?? []).some(
      (pkg) =>
        pkg.packageId === connection?.packageId && pkg.state === "installed",
    );
    const catalogPackage = web.value.pluginCatalog.find(
      (pkg) => pkg.packageId === connection?.packageId,
    );
    const connectionType = catalogPackage?.connectionTypes.find(
      (candidate) => candidate.id === connection?.connectionTypeId,
    );
    const modelCapabilities = new Set(
      catalogPackage?.capabilities.flatMap((capability) =>
        capability.kind === "model" &&
        connectionType?.capabilities.includes(capability.id)
          ? [capability.id]
          : [],
      ) ?? [],
    );
    const authorized =
      web.value.modelSource === "bot"
        ? Boolean(
            bot?.assignments.some(
              (assignment) =>
                assignment.connectionId === model?.connectionId &&
                assignment.packageId === connection?.packageId &&
                assignment.state === "enabled" &&
                modelCapabilities.has(assignment.capabilityId),
            ),
          )
        : modelCapabilities.size > 0;
    web.value.modelReady = Boolean(
      model && connection?.state === "ready" && packageInstalled && authorized,
    );
    const catalogModel = connection?.modelCatalog?.models.find(
      (candidate) => candidate.providerModelId === model?.providerModelId,
    );
    web.value.modelLabel = modelRuntimeLabel({
      modelDisplayName: catalogModel?.displayName,
      providerModelId: model?.providerModelId,
      packageDisplayName: catalogPackage?.displayName,
      connectionDisplayName: connection?.displayName,
      hasModel: Boolean(model),
    });
  }

  /**
   * One MCP lifecycle command, followed by a fresh status read. A refusal —
   * a stdio server, a quota breach — comes back as a receipt, not an
   * exception, and the surface shows it beside the servers rather than as an
   * error that loses the reason.
   */
  async function executeMcpCommand(command: unknown): Promise<void> {
    if (!ctx.transport.hostedRequest) {
      throw new Error("MCP lifecycle is unavailable");
    }
    try {
      const receipt = decodeMcpLifecycleReceiptV1(
        await ctx.transport.hostedRequest(
          MCP_SERVERS_ROUTE,
          "POST",
          JSON.stringify(command),
        ),
      );
      if (receipt.status !== "applied") {
        web.value.settingsError =
          receipt.failure ?? "The MCP command was refused";
      } else {
        web.value.settingsError = undefined;
      }
    } catch (error) {
      web.value.settingsError =
        error instanceof Error ? error.message : "The MCP command failed";
    }
    await web.value.loadMcpServers();
  }

  const web = ref<FrockBotWebData>({
    connection: "ready",
    modelLabel: "No default model",
    modelReady: false,
    modelSource: "none",
    settingsAvailable: true,
    connectionsAvailable: ctx.transport.connectionsAvailable !== false,
    activeBotId: undefined,
    composerContext: undefined,
    messages: [],
    pluginCatalog: [],
    packageCatalog: [],
    skillCatalog: [],
    approvals: [],
    async selectBot(botId: string): Promise<void> {
      activeRequest?.abort();
      admissionObserver?.abort();
      runObserver?.abort();
      selectionGeneration += 1;
      web.value.activeBotId = botId;
      web.value.composerContext = botId;
      web.value.botSettings = undefined;
      web.value.modelReady = false;
      web.value.messages = [];
      web.value.activeRun = undefined;
      web.value.activeRunId = undefined;
      web.value.skillCatalog = [];
      web.value.approvals = [];
      const url = URL.parse(window.location.href);
      if (url) {
        url.searchParams.set("bot", botId);
        window.history.replaceState(null, "", url);
      }
      await web.value.loadBotSettings();
    },
    async loadSkillCatalog(): Promise<void> {
      // A missing transport method or an unreadable catalog is an empty
      // popover, never a visible error: a Skill list the User did not ask for
      // must not put a banner over their conversation.
      const read = ctx.transport.readSkillCatalog;
      const botId = web.value.activeBotId;
      if (!read || !botId) return;
      const generation = selectionGeneration;
      try {
        const catalog = decodeClientSkillCatalogV1(await read(botId));
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.skillCatalog = catalog.skills;
      } catch {
        if (
          generation === selectionGeneration &&
          web.value.activeBotId === botId
        )
          web.value.skillCatalog = [];
      }
    },
    async loadApprovals(): Promise<void> {
      // A deployment with no approvals route, or one that cannot be read, is
      // an empty list rather than a banner: the cards in the transcript then
      // simply say they cannot be answered here.
      const read = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!read || !botId) return;
      const generation = selectionGeneration;
      try {
        const view = decodeApprovalListViewV1(
          await read(`/api/bots/${encodeURIComponent(botId)}/approvals`),
        );
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.approvals = view.approvals;
      } catch {
        if (
          generation === selectionGeneration &&
          web.value.activeBotId === botId
        )
          web.value.approvals = [];
      }
    },
    async decideApproval(
      approvalId: string,
      decision: "approved" | "denied",
    ): Promise<void> {
      const post = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!post || !botId) return;
      try {
        // The receipt carries what was actually recorded, which on a replay is
        // somebody else's earlier answer. Rendering the receipt rather than the
        // click is what keeps this client from becoming a second authority.
        const receipt = decodeApprovalDecisionReceiptV1(
          await post(
            `/api/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approvalId)}`,
            "POST",
            JSON.stringify({ schemaVersion: 1, decision }),
          ),
        );
        if (web.value.activeBotId !== botId) return;
        const others = web.value.approvals.filter(
          (approval) => approval.approvalId !== approvalId,
        );
        web.value.approvals = [receipt.approval, ...others];
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not record the decision";
      }
    },
    async loadBotSettings(): Promise<void> {
      if (!ctx.transport.readConfiguration) {
        updateSettingsLoadError("bot", "Settings are unavailable");
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
        // The effective model may be the User's default, so Bot readiness
        // needs the User settings too. Loading them never fails this read:
        // `loadUserSettings` reports its own failure.
        if (!web.value.userSettings) await web.value.loadUserSettings();
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        updateModelLabel();
        updateSettingsLoadError("bot");
        await deliverNotifications(botId, generation);
      } catch (error) {
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        updateSettingsLoadError(
          "bot",
          error instanceof Error ? error.message : "Could not load settings",
        );
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
    async setBotProfile(
      profile: BotProfilePatchV1,
      namedBy?: BotNameProvenanceV1,
    ): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/set-profile",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        ...(namedBy ? { namedBy } : {}),
        profile,
      });
      await web.value.loadBotSettings();
      // A rename produces a durable announcement; reload the Session so the
      // system line appears without waiting for the next Turn.
      await deliverNotifications(botId);
    },
    async uploadBotAvatar(input: {
      contentType: BotAvatarContentTypeV1;
      bytes: string;
    }): Promise<void> {
      const botId = web.value.activeBotId;
      if (!botId || !ctx.transport.hostedRequest) {
        throw new Error("Avatar upload is unavailable");
      }
      const receipt = decodeBotAvatarUploadReceiptV1(
        await ctx.transport.hostedRequest(
          `/api/bots/${encodeURIComponent(botId)}/avatar`,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            type: "bot/upload-avatar",
            botId,
            contentType: input.contentType,
            bytes: input.bytes,
          }),
        ),
      );
      await web.value.setBotProfile({ avatar: receipt.avatar });
    },
    async clearBotAvatar(): Promise<void> {
      await web.value.setBotProfile({ avatar: { kind: "sheep" } });
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
    async assignCapability(assignment): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await executeAssignmentOperation({
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        assignment,
      });
    },
    async replaceCapability(assignment): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await executeAssignmentOperation({
        schemaVersion: 1,
        type: "bot/replace-capability",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        assignment,
      });
    },
    async unassignCapability(assignmentId): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      await executeAssignmentOperation({
        schemaVersion: 1,
        type: "bot/unassign-capability",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        assignmentId,
      });
    },
    async saveBotModel(model: ModelAssignment): Promise<void> {
      const current = web.value.botSettings;
      const user = web.value.userSettings;
      const botId = web.value.activeBotId;
      if (!current || !user || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      const modelChanged =
        current.model?.connectionId !== model.connectionId ||
        current.model?.providerModelId !== model.providerModelId;
      const connection = user.connections.find(
        (candidate) => candidate.connectionId === model.connectionId,
      );
      if (!modelChanged && connection?.state !== "ready") return;
      const pkg = web.value.pluginCatalog.find(
        (candidate) => candidate.packageId === connection?.packageId,
      );
      const connectionType = pkg?.connectionTypes.find(
        (candidate) => candidate.id === connection?.connectionTypeId,
      );
      const capability = pkg?.capabilities.find(
        (candidate) =>
          candidate.kind === "model" &&
          connectionType?.capabilities.includes(candidate.id),
      );
      if (!connection || connection.state !== "ready" || !pkg || !capability) {
        throw new Error("The selected Connection has no model capability");
      }
      const assigned = current.assignments.some(
        (assignment) =>
          assignment.state === "enabled" &&
          assignment.packageId === pkg.packageId &&
          assignment.capabilityId === capability.id &&
          assignment.connectionId === connection.connectionId,
      );
      if (assigned && !modelChanged) return;
      if (!assigned) {
        // The binding commits inside the Assignment saga's commit phase, so
        // the Connection claim and the Bot's model are one durable unit. An
        // existing model Assignment on another Connection is replaced
        // atomically rather than unassigned and assigned again.
        const superseded = current.assignments.find(
          (assignment) =>
            assignment.packageId === pkg.packageId &&
            assignment.capabilityId === capability.id,
        );
        await executeAssignmentOperation({
          schemaVersion: 1,
          type: superseded ? "bot/replace-capability" : "bot/assign-capability",
          commandId: crypto.randomUUID(),
          botId,
          expectedRevision: current.revision,
          assignment: {
            assignmentId: superseded?.assignmentId ?? crypto.randomUUID(),
            packageId: pkg.packageId,
            capabilityId: capability.id,
            connectionId: connection.connectionId,
          },
          model,
        });
        return;
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/select-model",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        model,
      });
      await web.value.loadBotSettings();
      if (receipt.status === "rejected") {
        throw new Error(receipt.failure);
      }
    },
    async clearBotModel(): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current?.model || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      const assignment = current.assignments.find((candidate) => {
        const capability = web.value.pluginCatalog
          .find((pkg) => pkg.packageId === candidate.packageId)
          ?.capabilities.find(
            (declared) => declared.id === candidate.capabilityId,
          );
        return (
          (candidate.state === "enabled" ||
            candidate.state === "unavailable") &&
          candidate.connectionId === current.model?.connectionId &&
          capability?.kind === "model"
        );
      });
      if (!assignment) throw new Error("Bot model assignment is unavailable");
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/unbind-model",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        assignmentId: assignment.assignmentId,
      });
      await web.value.loadBotSettings();
      if (receipt.status === "rejected") throw new Error(receipt.failure);
    },
    async loadUserSettings(): Promise<void> {
      if (!ctx.transport.readConfiguration) {
        updateSettingsLoadError("user", "Settings are unavailable");
        return;
      }
      const generation = ++userSettingsGeneration;
      try {
        const settings = (await ctx.transport.readConfiguration({
          schemaVersion: 1,
          type: "user/get",
        })) as UserSettingsViewV1;
        retireSettledConnectionOperations(connectionOperations, settings);
        await reconcileRetainedConnectionCommands(
          connectionOperations,
          ctx.transport.lookupConnectionCommand,
        );
        if (generation !== userSettingsGeneration) return;
        web.value.userSettings = settings;
        updateModelLabel();
        updateSettingsLoadError("user");
      } catch (error) {
        if (generation !== userSettingsGeneration) return;
        updateSettingsLoadError(
          "user",
          error instanceof Error ? error.message : "Could not load settings",
        );
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
    async saveDefaultModel(model: ModelAssignment | undefined): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      const current = settings.newBotModelTemplate;
      if (
        current?.connectionId === model?.connectionId &&
        current?.providerModelId === model?.providerModelId
      ) {
        return;
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/set-new-bot-model",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        ...(model ? { model } : {}),
      });
      await web.value.loadUserSettings();
      if (receipt.status === "rejected") throw new Error(receipt.failure);
    },
    async loadPluginCatalog(): Promise<void> {
      if (
        !ctx.transport.readApplicationManifest ||
        !ctx.transport.readConfiguration
      ) {
        updateSettingsLoadError("catalog", "Plugins are unavailable");
        return;
      }
      const userGeneration = ++userSettingsGeneration;
      const catalogGeneration = ++pluginCatalogGeneration;
      try {
        const [manifest, settings] = await Promise.all([
          ctx.transport.readApplicationManifest(),
          ctx.transport.readConfiguration({
            schemaVersion: 1,
            type: "user/get",
          }),
        ]);
        const pluginCatalog = decodePluginCatalog(manifest);
        const userSettings = settings as UserSettingsViewV1;
        retireSettledConnectionOperations(connectionOperations, userSettings);
        await reconcileRetainedConnectionCommands(
          connectionOperations,
          ctx.transport.lookupConnectionCommand,
        );
        let committed = false;
        if (catalogGeneration === pluginCatalogGeneration) {
          web.value.pluginCatalog = pluginCatalog;
          updateSettingsLoadError("catalog");
          committed = true;
        }
        if (userGeneration === userSettingsGeneration) {
          web.value.userSettings = userSettings;
          updateSettingsLoadError("user");
          committed = true;
        }
        if (committed) updateModelLabel();
      } catch (error) {
        if (catalogGeneration !== pluginCatalogGeneration) return;
        updateSettingsLoadError(
          "catalog",
          error instanceof Error ? error.message : "Could not load Plugins",
        );
      }
    },
    /**
     * The MCP status projection. A separate read from the settings view: a
     * restart changes a server's state without touching the User settings
     * revision a client is holding an `expectedRevision` against.
     */
    async loadMcpServers(): Promise<void> {
      if (!ctx.transport.hostedRequest) return;
      try {
        web.value.mcpServers = decodeMcpServerStatusViewV1(
          await ctx.transport.hostedRequest(MCP_SERVERS_ROUTE),
        );
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not load the MCP servers";
      }
    },
    async setMcpInstructions(
      serverId: string,
      instructions: string,
    ): Promise<void> {
      await executeMcpCommand({
        schemaVersion: 1,
        type: "mcp/set-instructions",
        commandId: crypto.randomUUID(),
        serverId,
        instructions,
      });
    },
    /**
     * Connect, or reconnect, an OAuth MCP server.
     *
     * The redirect is minted by the host on this authenticated request and
     * returned to exactly one client, once: it is never read out of a
     * projection, and nothing stores it. `connectionId` reconnects an existing
     * Connection — which is what the connect card's *Reconnect* does — and its
     * absence creates one from the settings given.
     */
    async startMcpAuthorization(input: {
      connectionId?: string;
      label?: string;
      settings?: Record<string, unknown>;
    }): Promise<string | undefined> {
      if (!ctx.transport.hostedRequest) {
        throw new Error("MCP authorization is unavailable");
      }
      const nativeReturnNonce =
        "frockbotDesktop" in (globalThis.window ?? {})
          ? crypto.randomUUID()
          : undefined;
      const started = decodeStartConnectionResultV1(
        await ctx.transport.hostedRequest(
          MCP_CONNECTIONS_ROUTE,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            type: "connection/start",
            commandId: crypto.randomUUID(),
            connectionTypeId: MCP_OAUTH_CONNECTION_TYPE_ID,
            ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.settings ? { settings: input.settings } : {}),
            ...(nativeReturnNonce ? { nativeReturnNonce } : {}),
          }),
        ),
      );
      await web.value.loadUserSettings();
      await web.value.loadMcpServers();
      if (started.status === "ready") return undefined;
      authorizationOperations.set(started.redirectUrl, {
        ...(started.nativeReturnNonce
          ? { nativeReturnNonce: started.nativeReturnNonce }
          : {}),
      });
      return started.redirectUrl;
    },
    async restartMcpServer(serverId: string): Promise<void> {
      await executeMcpCommand({
        schemaVersion: 1,
        type: "mcp/restart",
        commandId: crypto.randomUUID(),
        serverId,
      });
    },
    /**
     * The remote Catalog index. Read through the gateway route, never from
     * object storage, and decoded at the seam like every other inbound value.
     */
    async loadPackageCatalog(): Promise<void> {
      if (!ctx.transport.hostedRequest) {
        updateSettingsLoadError(
          "package-catalog",
          "The Catalog is unavailable",
        );
        return;
      }
      const generation = ++packageCatalogGeneration;
      try {
        const index = decodeCatalogIndexV1(
          await ctx.transport.hostedRequest("/catalog/v1/index"),
        );
        if (generation !== packageCatalogGeneration) return;
        web.value.packageCatalog = index.entries;
        web.value.packageCatalogGeneration = index.generation;
        updateSettingsLoadError("package-catalog");
      } catch (error) {
        if (generation !== packageCatalogGeneration) return;
        updateSettingsLoadError(
          "package-catalog",
          error instanceof Error ? error.message : "Could not load the Catalog",
        );
      }
    },
    async loadCatalogEntry(
      catalogId: string,
    ): Promise<CatalogEntryV1 | undefined> {
      if (!ctx.transport.hostedRequest) {
        throw new Error("The Catalog is unavailable");
      }
      // Pinned to the generation the index came from, so an entry never
      // describes a different generation than the row that opened it.
      const pinned = web.value.packageCatalogGeneration;
      return decodeCatalogEntryV1(
        await ctx.transport.hostedRequest(
          `/catalog/v1/entry/${encodeURIComponent(catalogId)}${
            pinned ? `?generation=${encodeURIComponent(pinned)}` : ""
          }`,
        ),
      );
    },
    async installCatalogPackage(
      entry: CatalogIndexEntryV1,
      values?: Record<string, JsonValue>,
    ): Promise<void> {
      const settings = web.value.userSettings;
      const generation = web.value.packageCatalogGeneration;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Plugins are unavailable");
      }
      if (!generation) throw new Error("The Catalog generation is unknown");
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/install-package",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId: entry.packageId,
        version: entry.version,
        catalogId: entry.catalogId,
        catalogGeneration: generation,
        // GrokBot's `InstallPlugin{values}`: the entry's `setupFields`, filled
        // in by the User, recorded on the installation so the install is
        // reproducible from durable state rather than from a form that is gone.
        ...(values && Object.keys(values).length > 0 ? { values } : {}),
      });
      await web.value.loadPluginCatalog();
      if (receipt.status === "rejected") throw new Error(receipt.failure);
    },
    async uninstallPackage(packageId: string): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Plugins are unavailable");
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
      });
      await web.value.loadPluginCatalog();
      if (receipt.status === "rejected") throw new Error(receipt.failure);
    },
    async savePackageSettings(
      packageId: string,
      values: Record<string, string | number | boolean>,
    ): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Plugins are unavailable");
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/set-package-settings",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
        values,
      });
      // The values are projected onto the installation row, so the surface
      // re-reads the User settings it renders the form from.
      await web.value.loadUserSettings();
      if (receipt.status === "rejected") throw new Error(receipt.failure);
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
      let result: ClientStartConnectionResult;
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
    async createApiKeyConnection(input): Promise<void> {
      const result = await executeRetainedApiKeyCommand(
        ["create", input.packageId, input.connectionTypeId, input.label],
        (commandId) => ({
          schemaVersion: 1,
          type: "connection/create-api-key",
          commandId,
          ...input,
        }),
      );
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Connection validation failed");
      }
    },
    async createConnection(input): Promise<void> {
      const result = await executeRetainedApiKeyCommand(
        ["create", input.packageId, input.connectionTypeId, input.label],
        (commandId) => ({
          schemaVersion: 1,
          type: "connection/create",
          commandId,
          ...input,
        }),
      );
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Connection validation failed");
      }
    },
    async rotateApiKeyConnection(connectionId, apiKey): Promise<void> {
      const connection = web.value.userSettings?.connections.find(
        (candidate) => candidate.connectionId === connectionId,
      );
      if (!connection) {
        throw new Error("Connection is unavailable");
      }
      const result = await executeRetainedApiKeyCommand(
        ["rotate", connectionId],
        (commandId) => ({
          schemaVersion: 1,
          type: "connection/rotate-api-key",
          commandId,
          connectionId,
          apiKey,
        }),
        {
          packageId: connection.packageId,
          connectionId,
        },
      );
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Credential validation failed");
      }
    },
    async updateConnectionLabel(connectionId, label): Promise<void> {
      if (!ctx.transport.executeConnection) {
        throw new Error("Connections are unavailable");
      }
      const result = await ctx.transport.executeConnection({
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: crypto.randomUUID(),
        connectionId,
        label,
      });
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Connection label update failed");
      }
    },
    async refreshConnectionModels(connectionId): Promise<void> {
      if (!ctx.transport.executeConnection) {
        throw new Error("Connections are unavailable");
      }
      const result = await ctx.transport.executeConnection({
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: crypto.randomUUID(),
        connectionId,
      });
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Model catalog refresh failed");
      }
    },
    async setConnectionEnabled(connectionId, enabled): Promise<void> {
      if (!ctx.transport.executeConnection) {
        throw new Error("Connections are unavailable");
      }
      const result = await ctx.transport.executeConnection({
        schemaVersion: 1,
        type: "connection/set-enabled",
        commandId: crypto.randomUUID(),
        connectionId,
        enabled,
      });
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error("Connection state update failed");
      }
    },
    async disconnectConnection(
      connectionId,
      revokeUpstream = false,
    ): Promise<void> {
      if (!ctx.transport.executeConnection) {
        throw new Error("Connections are unavailable");
      }
      const result = await ctx.transport.executeConnection({
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: crypto.randomUUID(),
        connectionId,
        revokeUpstream,
      });
      await web.value.loadPluginCatalog();
      if (result.status !== "applied") {
        throw new Error(
          result.status === "reconciliation-required"
            ? "Connection revocation requires reconciliation"
            : "Connection revocation failed",
        );
      }
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
    async sendPrompt(
      text: string,
      skills?: readonly SkillRefV1[],
    ): Promise<SendPromptResult> {
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
          sends: [],
        },
        {
          id: crypto.randomUUID(),
          runId: pendingRunId,
          role: "assistant",
          text: "",
          status: "streaming",
          tools: [],
          sends: [],
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
          skills,
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
          sends: sendsFrom(result.events),
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
          sends: [],
        });
        if (aborted) {
          web.value.error = undefined;
        } else {
          web.value.error =
            error instanceof Error ? error.message : "Agent request failed";
        }
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
            sends: [],
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
