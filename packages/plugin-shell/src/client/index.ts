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
import {
  decodePackageIframeCatalogV1,
  packageIframeToolAllowedV1,
  decodeSendToUserPayloadV1,
  type PackageIframeContributionViewV1,
} from "@frockbot/kernel-contracts";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import type {
  BotNameProvenanceV1,
  BotNotificationPolicy,
  BotProfile,
  BotProfilePatchV1,
  BotSettingsViewV1,
  JsonValue,
  PackageSettingValueV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { resolveEffectiveBotModelV1 } from "@frockbot/configuration-core";
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
  ClientTurnRefusedErrorV1,
  type ClientTurnRefusalReasonV1,
  decodeClientTurnV1,
} from "../run-protocol.js";
import {
  decodeApprovalDecisionReceiptV1,
  decodeApprovalListViewV1,
} from "../approvals.js";
import {
  isCertainSendRefusalV1,
  momentAfterV1,
  uncertainAdmissionDelayMsV1,
  UNREACHABLE_BOT_MESSAGE_V1,
} from "./uncertain-admission.js";
import {
  decodeTaskListViewV1,
  decodeTaskViewV1,
} from "@frockbot/plugin-subagents/shared";
import { defineComponent, h, ref, toRaw, watch, type Ref } from "vue";
import {
  frockBotWebDataKey,
  type FrockBotWebData,
  decodeConnectionReturnV1,
  withoutConnectionReturnV1,
  type PluginCatalogItem,
  type SendPromptResult,
  type WebActiveRun,
  type WebChatMessage,
  type WebSendPayload,
  type WebTaskChip,
  type WebToolActivity,
} from "../shared.js";
import FrockBotApp from "./FrockBotApp.vue";
import PackageEntryTrigger from "./PackageEntryTrigger.vue";
import PackageIframeSettings from "./PackageIframeSettings.vue";
import PackageSurfacePage from "./PackageSurfacePage.vue";
import {
  packageIframeEntriesV1,
  type PackageIframeEntryV1,
} from "./package-iframe-entries.js";
import { appletsAvailableV1 } from "./applets-state.js";
import {
  readAppletBuild,
  readAppletList,
  readAppletSource,
  readAppletUi,
  readAppletViewerToken,
  readFocusedAppletId,
  writeFocusedAppletId,
} from "./applets-client.js";
import { modelRuntimeLabel } from "./model-presentation.js";
import { showClientNotificationV1 } from "./notify.js";
import "@frockbot/client-core/fonts.css";
import "./styles.css";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

function presentedToolCall(call: NonNullable<ClientTurnEvent["call"]>): {
  name: string;
  input?: unknown;
} {
  if (
    call.name === "call_dynamic_tool" &&
    typeof call.input === "object" &&
    call.input !== null &&
    !Array.isArray(call.input)
  ) {
    const input = call.input as Record<string, unknown>;
    if (
      typeof input.namespace === "string" &&
      typeof input.toolName === "string"
    ) {
      let innerArguments: unknown = {};
      if (typeof input.argumentsJson === "string") {
        try {
          innerArguments = JSON.parse(input.argumentsJson) as unknown;
        } catch {
          innerArguments = {};
        }
      }
      return {
        name: `${input.namespace}/${input.toolName}`,
        input: innerArguments,
      };
    }
  }
  return {
    name: call.name,
    ...(call.input === undefined ? {} : { input: call.input }),
  };
}

function toolsFrom(events: ClientTurnEvent[]): WebToolActivity[] {
  const tools = new Map<string, WebToolActivity>();
  for (const event of events) {
    if (event.type === "tool/call" && event.call) {
      const presented = presentedToolCall(event.call);
      tools.set(event.call.id, {
        id: event.call.id,
        ...presented,
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

/**
 * The subagents this Turn dispatched, as chips. An event missing a field is
 * skipped rather than drawn half-formed: a run has to render on a client older
 * than the Bot that produced it.
 */
function tasksFrom(events: ClientTurnEvent[]): WebTaskChip[] {
  const tasks: WebTaskChip[] = [];
  for (const event of events) {
    if (event.type !== "task/dispatched") continue;
    if (
      event.taskId === undefined ||
      event.taskType === undefined ||
      event.description === undefined ||
      event.model === undefined
    ) {
      continue;
    }
    tasks.push({
      taskId: event.taskId,
      taskType: event.taskType,
      description: event.description,
      model: event.model,
      background: event.background !== false,
    });
  }
  return tasks;
}

type DurableRunProjectionState = Pick<
  FrockBotWebData,
  "messages" | "activeRunId" | "runningRunId" | "activeRun" | "error"
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
      message: "Stop requested; finishing up.",
      canResume: false,
    };
  }
  if (run.status === "reconciliation-required") {
    return {
      runId: run.runId,
      status: run.status,
      message: run.stopRequestedAt
        ? "Stopping…"
        : "Something went wrong mid-reply. Try again to pick it up.",
      // Offered whenever the run is parked, Stop included. Hiding it there
      // hid it in exactly the case Stop creates: a Turn that was stopped
      // while the model was mid-answer parks, and the person was left with a
      // banner and no way to act on it.
      canResume: run.recovery?.action === "resume",
    };
  }
  return undefined;
}

/**
 * What a refused send tells the person. The refusal's own `error` names the
 * durable invariant that declined it, which the debug surface needs and the
 * composer does not, so the typed reason picks the sentence instead.
 */
function turnRefusalCopyV1(reason: ClientTurnRefusalReasonV1): string {
  if (reason === "busy")
    return "This Bot is still working on your last message.";
  if (reason === "reconciliation-required")
    return "This Bot's last reply stopped partway. Try again to continue it.";
  if (reason === "duplicate") return "That message was already sent.";
  return "That message didn't go through. Try sending it again.";
}

/**
 * The Bot's voice is its sends. When a Turn delivered anything to the User the
 * model's own assistant text is scratch space and the thread does not draw it
 * (issue 153): drawing both is how a one-word reply arrived twice, once as the
 * model's text and once as the bubble that was actually delivered.
 */
function visibleAssistantText(run: ClientRun, fallback = ""): string {
  if (sendsFrom(run.events).length > 0) return "";
  return run.responseText ?? fallback;
}

function isTerminalRun(run: ClientRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    run.status === "superseded"
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
      text: visibleAssistantText(run),
      status: "streaming",
      // A Turn that has not started shows nothing of its own: the greyed user
      // message is the whole of what the thread says about it.
      ...(run.queued ? { pending: true } : {}),
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
      tasks: tasksFrom(run.events),
    };
  }
  if (run.status === "superseded") {
    // The same quiet treatment a stopped Turn gets. It keeps everything it
    // already sent; the line only says why it ends where it does.
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: visibleAssistantText(run),
      notice: "Interrupted by your next message.",
      status: "aborted",
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
      tasks: tasksFrom(run.events),
    };
  }
  if (run.status === "reconciliation-required") {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: "This reply stopped partway. Try again to continue it.",
      status: "reconciliation-required",
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
      tasks: tasksFrom(run.events),
    };
  }
  if (run.status === "cancelled") {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: visibleAssistantText(run),
      notice: "You stopped this.",
      status: "aborted",
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
      tasks: tasksFrom(run.events),
    };
  }
  // A Turn that broke after it had started talking keeps what it said, with
  // the reason underneath it — the treatment a stopped Turn already gets, for
  // the same reason: the words arrived and the person read them (ADR 0028).
  // A Turn that broke before saying anything is still just the reason.
  if (run.status === "failed" && run.responseText) {
    return {
      id: `${run.runId}:assistant`,
      runId: run.runId,
      role: "assistant",
      text: run.responseText,
      notice: run.failure ?? "Agent request failed.",
      status: "error",
      tools: toolsFrom(run.events),
      sends: sendsFrom(run.events),
      tasks: tasksFrom(run.events),
    };
  }
  return {
    id: `${run.runId}:assistant`,
    runId: run.runId,
    role: "assistant",
    text:
      run.status === "failed"
        ? "This Bot couldn't finish its reply. Try again."
        : visibleAssistantText(run, notification?.body ?? ""),
    status: run.status === "failed" ? "error" : "completed",
    tools: toolsFrom(run.events),
    sends: sendsFrom(run.events),
    tasks: tasksFrom(run.events),
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
  // The Turn Stop targets: the one that is executing, never the one waiting
  // behind it.
  let runningRunId: string | undefined;
  for (const run of runs) {
    const notification = notifications.find(
      (candidate) => candidate.runId === run.runId,
    );
    const userIndex = state.messages.findIndex(
      (message) => message.runId === run.runId && message.role === "user",
    );
    const existingUser = userIndex >= 0 ? state.messages[userIndex] : undefined;
    const user: WebChatMessage = {
      id: `${run.runId}:user`,
      runId: run.runId,
      role: "user",
      text: run.input,
      ...(run.admittedAt
        ? { at: run.admittedAt }
        : existingUser?.at
          ? { at: existingUser.at }
          : {}),
      status: "completed",
      // Greyed while its Turn waits, ordinary the moment it is running. The
      // flag comes from durable run state, so a reload draws the same thing.
      ...(run.queued ? { pending: true } : {}),
      tools: [],
      sends: [],
    };
    if (userIndex >= 0) state.messages[userIndex] = user;
    else state.messages.push(user);

    const assistantIndex = state.messages.findIndex(
      (message) => message.runId === run.runId && message.role === "assistant",
    );
    const assistant = assistantMessage(run, notification);
    const assistantAt =
      run.admittedAt ??
      (assistantIndex >= 0 ? state.messages[assistantIndex]?.at : undefined);
    if (assistantAt) assistant.at = assistantAt;
    if (assistantIndex >= 0) state.messages[assistantIndex] = assistant;
    else state.messages.push(assistant);

    activeRun = activeRunView(run) ?? activeRun;
    if (run.status === "running" || run.status === "reconciliation-required") {
      busyRunId = run.runId;
    }
    // Stop belongs to a Turn that is executing. A Turn parked on a
    // reconciliation is busy but not running: there is nothing to stop, and
    // offering it left a Stop button standing for good — across reloads,
    // because the state it was keyed off never became terminal.
    if (run.status === "running" && !run.queued) runningRunId = run.runId;
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
  if (runningRunId) state.runningRunId = runningRunId;
  else if (
    state.runningRunId &&
    runs.some((run) => run.runId === state.runningRunId)
  ) {
    // The channel is carrying this run and it is not executing, whatever it
    // settled as. A run the list does not carry yet is the one this tab just
    // submitted, which keeps its Stop.
    state.runningRunId = undefined;
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
    throw new Error("FrockBot couldn't load this deployment. Reload the page.");
  }
  return value.packages.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      // A Package that declares no configuration is serialised without the
      // key (JSON drops an undefined field), so the key is owned but optional.
      !hasExactFields(candidate, [
        "id",
        "displayName",
        "version",
        "contributions",
        ...(Object.hasOwn(candidate, "configuration") ? ["configuration"] : []),
        ...(Object.hasOwn(candidate, "platformOwned") ? ["platformOwned"] : []),
      ]) ||
      typeof candidate.id !== "string" ||
      typeof candidate.displayName !== "string" ||
      typeof candidate.version !== "string" ||
      (candidate.platformOwned !== undefined &&
        typeof candidate.platformOwned !== "boolean") ||
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
      throw new Error(
        "FrockBot couldn't load this deployment. Reload the page.",
      );
    }
    const decoded = decodeFrockBotManifest({
      // v4, so a Capability carrying an admission ceiling decodes here too.
      // Admission is durable manifest state the Plugins surface does not
      // render; refusing the manifest over it would hide the whole Package.
      schemaVersion: 4,
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
    // User- and Bot-scoped declarations are needed for generic effective
    // model resolution. Connection-scoped settings stay with their Connection
    // and never enter Package-level settings forms.
    const settings = (decoded.configuration?.settings ?? []).filter((setting) =>
      setting.scopes.some((scope) => scope === "user" || scope === "bot"),
    );
    // A settings-only Package still contributes enablement: disabling it is
    // what makes its retained controls inert. A Capability that takes no
    // Connection likewise counts because enabling its Package grants it to
    // all of the User's Bots.
    if (
      connectionTypes.length === 0 &&
      decodedCapabilities.length === 0 &&
      settings.length === 0
    ) {
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
        ...(candidate.platformOwned === true ? { platformOwned: true } : {}),
        capabilities: decodedCapabilities,
        connectionTypes: decodedConnections,
        settings,
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
  /*
   * Which conversation the transcript is showing.
   *
   * A read that was already in flight when the User starts a new conversation
   * answers with the conversation that just ended, and projecting it puts the
   * old Turns back on a transcript the User has just been told is empty. The
   * epoch is bumped at the boundary so those answers are dropped.
   */
  let conversationGeneration = 0;
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
  ): Promise<"admitted" | "not-admitted" | "detached" | "unreachable"> {
    web.value.activeRun = {
      runId,
      status: "running",
      message: "Checking whether your message went through…",
      canResume: false,
    };
    if (!ctx.transport.lookupRun || !ctx.transport.fenceRunAdmission) {
      return "detached";
    }
    let reconciliationError: string | undefined;
    const clearReconciliationError = () => {
      if (web.value.settingsError === reconciliationError) {
        web.value.settingsError = undefined;
      }
      reconciliationError = undefined;
    };
    for (let attempt = 1; !signal.aborted; attempt += 1) {
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
            : "Couldn't check on your message."
        } Retrying…`;
        web.value.settingsError = reconciliationError;
      }
      const delayMs = uncertainAdmissionDelayMsV1(attempt);
      // The bound is spent. Asking again would only keep a placeholder
      // spinning over a backend this tab cannot reach, so the caller settles
      // the Turn and says so in the thread.
      if (delayMs === undefined) {
        clearReconciliationError();
        web.value.activeRun = undefined;
        return "unreachable";
      }
      await waitForRunLookup(delayMs, signal);
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
    const conversation = conversationGeneration;
    while (!signal.aborted) {
      try {
        const run = await observeWhileAttached(
          ctx.transport.lookupRun(botId, runId),
          signal,
        );
        if (
          signal.aborted ||
          generation !== selectionGeneration ||
          // The Turn belongs to the conversation it was sent in, so a new one
          // ends the observation rather than drawing it on an empty thread.
          conversation !== conversationGeneration ||
          web.value.activeBotId !== botId
        ) {
          return;
        }
        if (!run) throw new Error("Couldn't load that reply.");
        if (web.value.settingsError === observationError) {
          web.value.settingsError = undefined;
        }
        observationError = undefined;
        projectDurableRuns(web.value, [], [run]);
        if (isTerminalRun(run)) return;
      } catch (error) {
        if (signal.aborted) return;
        observationError = `${
          error instanceof Error ? error.message : "Couldn't load that reply."
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
    const conversation = conversationGeneration;
    const current = () =>
      generation === selectionGeneration &&
      conversation === conversationGeneration &&
      web.value.activeBotId === botId;
    const runs = await (ctx.transport.listRuns?.(botId) ?? Promise.resolve([]));
    if (!current()) return;
    projectDurableRuns(web.value, [], runs);
    try {
      const announcements = await (ctx.transport.listAnnouncements?.(botId) ??
        Promise.resolve([]));
      if (current()) projectAnnouncements(web.value.messages, announcements);
    } catch {
      // Announcements are conversational history, never admission: a Session
      // that cannot read them still shows every Turn.
    }
    let notifications: ClientNotificationIntent[];
    try {
      notifications = await (ctx.transport.listNotifications?.(botId) ??
        Promise.resolve([]));
      if (!current()) return;
    } catch (error) {
      if (!current()) return;
      web.value.settingsError =
        error instanceof Error ? error.message : "Could not load notifications";
      return;
    }
    if (!current()) return;
    const projected = projectDurableRuns(web.value, notifications, runs);
    // A decision may have been recorded on another device since the last poll,
    // and an expiry is recorded by an alarm nobody clicked.
    await web.value.loadApprovals();
    // A background subagent settles after its Turn is over, so the chips in
    // the transcript learn what became of it here and not from the run.
    await web.value.loadTasks();
    if (!current()) return;
    if (!ctx.transport.acknowledgeNotification) return;
    for (const notification of notifications) {
      if (!current()) return;
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

  function updateSettingsLoadError(
    source: "bot" | "user" | "catalog" | "package-catalog",
    message?: string,
  ): void {
    settingsLoadErrors.delete(source);
    if (message) settingsLoadErrors.set(source, message);
    web.value.settingsError = [...settingsLoadErrors.values()].at(-1);
  }

  /** Readiness and the composer label follow the generic effective model. */
  function updateModelLabel(): void {
    const bot = web.value.botSettings;
    const user = web.value.userSettings;
    if (!user) {
      web.value.modelSource = "none";
      web.value.modelReady = false;
      web.value.modelLabel = modelRuntimeLabel({ source: "none" });
      return;
    }
    const effective = resolveEffectiveBotModelV1({
      // Before the first Bot exists — and in the window before a selected
      // Bot's settings arrive — the account's own effective model is still
      // the truth. An empty Bot scope simply declines to override it, so the
      // shell reports the account model instead of claiming it is unavailable.
      bot: bot ? toRaw(bot) : { packageValues: {} },
      user: toRaw(user),
      packages: toRaw(web.value.pluginCatalog).map((pkg) => ({
        packageId: pkg.packageId,
        version: pkg.version,
        settings: pkg.settings ?? [],
        capabilities: pkg.capabilities,
        connectionTypes: pkg.connectionTypes,
      })),
    });
    // `FrockBotWebData`'s source vocabulary is owned outside this lane. Until
    // it adopts the core's four sources, both inherited choices are its
    // existing `default` projection; the label still preserves the exact core
    // source below.
    web.value.modelSource =
      effective.source === "bot"
        ? "bot"
        : effective.source === "none"
          ? "none"
          : "default";
    web.value.modelReady = Boolean(
      effective.binding && effective.binding.state !== "unavailable",
    );
    const connection = effective.binding?.connection;
    const catalogPackage = web.value.pluginCatalog.find(
      (pkg) => pkg.packageId === effective.binding?.packageId,
    );
    const catalogModel = connection?.modelCatalog?.models.find(
      (candidate) =>
        candidate.providerModelId === effective.model?.providerModelId,
    );
    web.value.modelLabel = modelRuntimeLabel({
      source: effective.source,
      modelDisplayName: catalogModel?.displayName,
      providerModelId: effective.model?.providerModelId,
      packageDisplayName: catalogPackage?.displayName,
      connectionDisplayName: connection?.displayName,
      failure: effective.binding?.failure,
      fallback: Boolean(effective.fallback),
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

  type ShellWebData = FrockBotWebData & {
    saveBotPackageSettings(
      packageId: string,
      values: Record<string, PackageSettingValueV1>,
    ): Promise<void>;
  };

  // Read once, from the URL the authorization redirect landed on, and then
  // stripped so a reload does not report the same return again.
  const connectionReturn =
    typeof window === "undefined"
      ? undefined
      : decodeConnectionReturnV1(window.location.search);
  if (connectionReturn && typeof window !== "undefined") {
    const rest = withoutConnectionReturnV1(window.location.search);
    window.history?.replaceState?.(
      window.history.state,
      "",
      `${window.location.pathname}${rest}${window.location.hash}`,
    );
  }

  const web: Ref<ShellWebData> = ref({
    connection: "ready",
    ...(connectionReturn ? { connectionReturn } : {}),
    modelLabel: "No model available — set one up in Models",
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
    tasks: [],
    packageUi: undefined,
    applets: [],
    focusedAppletId: undefined,
    appletViewer: undefined,
    appletSource: undefined,
    appletBuild: undefined,
    appletCanvas: "idle",
    /*
     * The focused Applet, joined with the list the User owns. A getter rather
     * than a stored field so the two can never disagree: the id is what the
     * Bot Durable Object recorded, and this is what that id currently names.
     */
    get focusedApplet() {
      const appletId = web.value.focusedAppletId;
      if (!appletId) return undefined;
      return web.value.applets.find((applet) => applet.appletId === appletId);
    },
    async selectBot(botId: string): Promise<void> {
      // Re-selecting the open Bot is not a switch: aborting the live Turn and
      // clearing the transcript would discard state the User is watching.
      if (web.value.activeBotId === botId) return;
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
      web.value.runningRunId = undefined;
      web.value.skillCatalog = [];
      web.value.approvals = [];
      web.value.tasks = [];
      web.value.packageUi = undefined;
      // The focus is per Session, so switching Bots drops what the previous
      // Bot's canvas was showing rather than carrying it across.
      web.value.focusedAppletId = undefined;
      web.value.appletViewer = undefined;
      web.value.appletSource = undefined;
      web.value.appletBuild = undefined;
      web.value.appletCanvas = "idle";
      web.value.appletCanvasError = undefined;
      const url = URL.parse(window.location.href);
      if (url) {
        url.searchParams.set("bot", botId);
        window.history.replaceState(null, "", url);
      }
      await web.value.loadBotSettings();
    },
    /**
     * Puts this conversation down and starts the next one.
     *
     * What the Bot knows about you is Memory and stays; what it carries into
     * the next model request is the new conversation and nothing else. The
     * transcript clears because it is showing the conversation, and the one
     * just ended is still durable behind it.
     */
    async startConversation(): Promise<void> {
      const start = ctx.transport.startConversation;
      const botId = web.value.activeBotId;
      if (!start || !botId) return;
      const generation = selectionGeneration;
      try {
        await start(botId);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not start a new conversation";
        return;
      }
      if (generation !== selectionGeneration || web.value.activeBotId !== botId)
        return;
      // Reads already in flight answer with the conversation that just ended;
      // the epoch drops them instead of letting them redraw it.
      conversationGeneration += 1;
      runObserver?.abort();
      runObserver = undefined;
      web.value.messages = [];
      web.value.activeRun = undefined;
      web.value.activeRunId = undefined;
      web.value.runningRunId = undefined;
      web.value.settingsError = undefined;
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
    async loadTasks(): Promise<void> {
      // A deployment with no tasks route, or one that cannot be read, is an
      // empty list rather than a banner: the chips in the transcript then say
      // what the dispatch said and nothing more.
      const read = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!read || !botId) return;
      const generation = selectionGeneration;
      try {
        const view = decodeTaskListViewV1(
          await read(`/api/bots/${encodeURIComponent(botId)}/tasks`),
        );
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.tasks = view.tasks;
      } catch {
        if (
          generation === selectionGeneration &&
          web.value.activeBotId === botId
        )
          web.value.tasks = [];
      }
    },
    async loadPackageUi(): Promise<void> {
      const read = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!read || !botId) return;
      const generation = selectionGeneration;
      try {
        const catalog = decodePackageIframeCatalogV1(
          await read(`/api/bots/${encodeURIComponent(botId)}/package-ui`),
        );
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.packageUi = catalog;
      } catch {
        if (
          generation === selectionGeneration &&
          web.value.activeBotId === botId
        ) {
          web.value.packageUi = undefined;
        }
      }
    },
    /*
     * The Applets the User owns.
     *
     * Account-shaped, so this is read once per selection rather than per Bot,
     * and a deployment with no Applet routes reads as an empty list instead of
     * an error over the conversation.
     */
    async loadApplets(): Promise<void> {
      const read = ctx.transport.hostedRequest;
      if (!read || !appletsAvailableV1(web.value.packageUi)) return;
      const generation = selectionGeneration;
      try {
        const applets = await readAppletList(read);
        if (generation !== selectionGeneration) return;
        web.value.applets = applets;
      } catch {
        if (generation === selectionGeneration) web.value.applets = [];
      }
    },
    async loadFocusedApplet(): Promise<void> {
      const read = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!read || !botId || !appletsAvailableV1(web.value.packageUi)) return;
      const generation = selectionGeneration;
      try {
        const appletId = await readFocusedAppletId(read, botId);
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.focusedAppletId = appletId;
      } catch {
        if (
          generation === selectionGeneration &&
          web.value.activeBotId === botId
        )
          web.value.focusedAppletId = null;
      }
      await web.value.refreshAppletCanvas();
    },
    async setFocusedApplet(appletId: string | null): Promise<void> {
      const post = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!post || !botId || !appletsAvailableV1(web.value.packageUi)) return;
      const generation = selectionGeneration;
      try {
        const recorded = await writeFocusedAppletId(post, botId, appletId);
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        // What the canvas shows is the focus the backend recorded, never the
        // one the click asked for.
        web.value.focusedAppletId = recorded;
        web.value.appletViewer = undefined;
        web.value.appletSource = undefined;
        web.value.appletBuild = undefined;
        web.value.appletCanvasError = undefined;
        // Focusing is also when the list is re-read: a publish that landed
        // between selections is why the canvas has an Applet to show at all,
        // and a stale list would leave it in the building state forever.
        await web.value.loadApplets();
      } catch (error) {
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        web.value.appletCanvas = "failed";
        web.value.appletCanvasError =
          error instanceof Error
            ? error.message
            : "Could not focus that Applet";
        return;
      }
      await web.value.refreshAppletCanvas();
    },
    /*
     * What the canvas draws for the focused Applet.
     *
     * The source read is the building state and never waits on the Computer:
     * the Workspace store is read, so a hibernated Computer costs nothing. The
     * viewer credential is only fetched once a generation is active, because
     * there is nothing to view before one is.
     */
    async refreshAppletCanvas(): Promise<void> {
      const read = ctx.transport.hostedRequest;
      const appletId = web.value.focusedAppletId;
      const botId = web.value.activeBotId;
      if (!read || !appletId || !botId) {
        web.value.appletCanvas = "idle";
        return;
      }
      const generation = selectionGeneration;
      const stale = () =>
        generation !== selectionGeneration ||
        web.value.focusedAppletId !== appletId;
      if (web.value.appletViewer?.appletId !== appletId) {
        web.value.appletCanvas = "loading";
      }
      web.value.appletCanvasError = undefined;
      try {
        const [source, build] = await Promise.all([
          readAppletSource(read, botId, appletId),
          readAppletBuild(read, botId, appletId).catch(() => ({
            status: "unknown" as const,
          })),
        ]);
        if (stale()) return;
        web.value.appletSource = source;
        web.value.appletBuild = build;
      } catch (error) {
        if (stale()) return;
        web.value.appletCanvas = "failed";
        web.value.appletCanvasError =
          error instanceof Error ? error.message : "Could not read this Applet";
        return;
      }
      const applet = web.value.applets.find(
        (candidate) => candidate.appletId === appletId,
      );
      if (!applet?.currentGenerationId) {
        // No active generation is the building state, not a failure.
        if (!stale()) {
          web.value.appletViewer = undefined;
          web.value.appletCanvas = "ready";
        }
        return;
      }
      try {
        const [ui, token] = await Promise.all([
          readAppletUi(read, appletId),
          readAppletViewerToken(read, appletId),
        ]);
        if (stale()) return;
        web.value.appletViewer = {
          appletId,
          token: token.token,
          expiresAt: token.expiresAt,
          socketUrl: token.socketUrl,
          uiUrl: ui.uiUrl,
          generationId: ui.generationId ?? applet.currentGenerationId,
        };
        web.value.appletCanvas = "ready";
      } catch (error) {
        if (stale()) return;
        // A published Applet whose viewer cannot be opened keeps the code view
        // up and says so; it never shows an empty frame pretending to work.
        web.value.appletViewer = undefined;
        web.value.appletCanvas = "failed";
        web.value.appletCanvasError =
          error instanceof Error ? error.message : "Could not open this Applet";
      }
    },
    async callPackageUiTool(
      contribution: PackageIframeContributionViewV1,
      name: string,
      input: unknown,
    ): Promise<unknown> {
      const post = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      const catalog = web.value.packageUi;
      if (!post || !botId || !catalog || catalog.botId !== botId) {
        throw new Error("That plugin's page isn't available.");
      }
      if (!packageIframeToolAllowedV1(contribution, name)) {
        throw new Error(`That plugin isn't allowed to use ${name}.`);
      }
      const turn = decodeClientTurnV1(
        await post(
          `/api/bots/${encodeURIComponent(botId)}/package-ui/tools`,
          "POST",
          JSON.stringify({
            schemaVersion: 1,
            commandId: crypto.randomUUID(),
            generationId: catalog.generationId,
            packageId: contribution.packageId,
            name,
            input,
          }),
        ),
      );
      await deliverNotifications(botId);
      const result = turn.events.findLast(
        (event) => event.type === "tool/result",
      );
      return result?.type === "tool/result"
        ? { content: result.content, isError: result.isError === true }
        : { content: turn.text, isError: false };
    },
    /**
     * Explicit, authenticated cancellation of one subagent from the client.
     *
     * The receipt is the task as the Bot Durable Object recorded it, not what
     * the click asked for: a task that had already settled comes back settled,
     * and the list shows that rather than a cancellation that did not happen.
     */
    async stopTask(taskId: string): Promise<void> {
      const post = ctx.transport.hostedRequest;
      const botId = web.value.activeBotId;
      if (!post || !botId) return;
      try {
        const view = decodeTaskViewV1(
          await post(
            `/api/bots/${encodeURIComponent(botId)}/tasks/${encodeURIComponent(taskId)}/stop`,
            "POST",
            JSON.stringify({ schemaVersion: 1 }),
          ),
        );
        if (web.value.activeBotId !== botId) return;
        web.value.tasks = web.value.tasks.map((task) =>
          task.taskId === view.taskId ? view : task,
        );
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Could not stop the subagent";
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
        // The effective model may come from account or platform state, so Bot
        // readiness needs the User settings too. Loading them never fails this read:
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
        await web.value.loadPackageUi();
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        await web.value.loadApplets();
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return;
        await web.value.loadFocusedApplet();
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
    async saveBotPackageSettings(
      packageId: string,
      values: Record<string, PackageSettingValueV1>,
    ): Promise<void> {
      const current = web.value.botSettings;
      const botId = web.value.activeBotId;
      if (!current || !botId || !ctx.transport.executeConfiguration) {
        throw new Error("Settings are unavailable");
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "bot/set-package-settings",
        commandId: crypto.randomUUID(),
        botId,
        expectedRevision: current.revision,
        packageId,
        values,
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
        // The gateway answers 404 `catalog generation was not found` when the
        // deployment has published no Catalog at all. That is a state, not a
        // fault, and the raw server sentence means nothing to a person — so it
        // is translated here and the surface renders it instead of the
        // "nothing matched your search" empty state.
        const raw =
          error instanceof Error ? error.message : "Could not load the Catalog";
        web.value.packageCatalog = [];
        web.value.packageCatalogGeneration = undefined;
        updateSettingsLoadError(
          "package-catalog",
          /catalog generation was not found|Package Catalog is not configured/.test(
            raw,
          )
            ? "No plugins are published for this deployment yet."
            : `Plugins could not be loaded: ${raw}`,
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
      if (!generation)
        throw new Error("The catalog isn't loaded yet. Try again in a moment.");
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
    async setPackageEnabled(
      packageId: string,
      enabled: boolean,
    ): Promise<void> {
      const settings = web.value.userSettings;
      if (!settings || !ctx.transport.executeConfiguration) {
        throw new Error("Plugins are unavailable");
      }
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
        enabled,
      });
      // Enablement is projected onto the installation row the Plugins surface
      // renders, so the toggle reads back what the User authority recorded.
      await web.value.loadPluginCatalog();
      if (receipt.status === "rejected") {
        web.value.settingsError = receipt.failure;
        throw new Error(receipt.failure);
      }
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
      const receipt = await ctx.transport.executeConfiguration({
        schemaVersion: 1,
        type: "user/install-package",
        commandId: crypto.randomUUID(),
        expectedRevision: settings.revision,
        packageId,
        version,
      });
      await web.value.loadPluginCatalog();
      if (receipt.status === "rejected") {
        web.value.settingsError = receipt.failure;
        throw new Error(receipt.failure);
      }
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
            ? "Disconnecting didn't finish. Try again."
            : "Couldn't disconnect that account.",
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
      const botId = web.value.activeBotId;
      if (!botId) return { accepted: false, error: "no-bot" };
      const generation = selectionGeneration;
      const pendingRunId = crypto.randomUUID();
      const optimisticAt = new Date().toISOString();
      // Every send carries the intent, because "do this instead" is what a
      // person means by pressing send and it does not depend on what this
      // client had managed to observe first. Whether a run was showing as
      // active is a race — the composer unlocks the instant a Turn settles,
      // and a fast typist beats the next poll — so gating the intent on
      // `activeRunId` made the Bot refuse a message the User had every right
      // to send. The observed run rides along as provenance when there is one.
      const observed = web.value.activeRunId;
      const supersedes = observed ? { runId: observed } : {};
      web.value.activeRunId = pendingRunId;
      // Stop is offered for the whole of the Turn the User just started, not
      // only from the moment a projection happens to arrive. A send that
      // supersedes a running Turn is the exception: the Turn Stop targets is
      // still the one executing, and this one is queued behind it. The durable
      // projection corrects both the instant it arrives.
      if (!observed) web.value.runningRunId = pendingRunId;
      web.value.error = undefined;
      web.value.messages.push(
        {
          id: `${pendingRunId}:user`,
          runId: pendingRunId,
          role: "user",
          text,
          at: optimisticAt,
          status: "completed",
          // Greyed until its own Turn is admitted and running. Optimistic
          // only: the durable projection replaces it by run id.
          ...(observed ? { pending: true } : {}),
          tools: [],
          sends: [],
        },
        {
          id: `${pendingRunId}:assistant`,
          runId: pendingRunId,
          role: "assistant",
          text: "",
          at: optimisticAt,
          status: "streaming",
          ...(observed ? { pending: true } : {}),
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
          supersedes,
        );
        if (
          generation !== selectionGeneration ||
          web.value.activeBotId !== botId
        )
          return { accepted: true, runId: result.runId };
        for (const message of web.value.messages) {
          if (message.runId !== pendingRunId) continue;
          message.runId = result.runId;
          message.id = `${result.runId}:${message.role}`;
        }
        replaceMessage(web.value.messages, result.runId, {
          id: `${result.runId}:assistant`,
          runId: result.runId,
          role: "assistant",
          // The same rule the durable projection follows: a Turn that
          // delivered something speaks through its sends, not through the
          // model's own text (issue 153).
          text: sendsFrom(result.events).length > 0 ? "" : result.text,
          at: optimisticAt,
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
        // A refusal is a normal answer, not an uncertain send: the Bot
        // declined and said why. Show that, drop the optimistic bubbles, and
        // let the composer give the person their text back — fencing a run
        // that was never admitted only threw the reason away.
        if (error instanceof ClientTurnRefusedErrorV1) {
          removeMessages(web.value.messages, pendingRunId);
          const refusal = turnRefusalCopyV1(error.refusal.reason);
          web.value.error = refusal;
          return { accepted: false, error: refusal };
        }
        // Every other 4xx is a refusal too, and the answer already says why —
        // a message over the size limit is answered 413 with the sentence the
        // person needs. Only 5xx and a lost connection leave admission in
        // doubt, so anything else here is settled: no optimistic bubbles, no
        // "checking" placeholder, no reconciliation, and the composer gets the
        // draft back rather than the thread pretending it was sent.
        if (isCertainSendRefusalV1(error)) {
          removeMessages(web.value.messages, pendingRunId);
          const refusal =
            error instanceof Error && error.message
              ? error.message
              : "That message didn't go through. Try sending it again.";
          web.value.error = refusal;
          return { accepted: false, error: refusal };
        }
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        // Strictly after the message it reports on. The thread orders by time,
        // and the durable projection gives the user's line the run's later
        // `admittedAt`, so a placeholder carrying the moment the send began
        // sorted above the message it belongs to.
        const placeholderAt = momentAfterV1(
          web.value.messages.find(
            (message) =>
              message.runId === pendingRunId && message.role === "user",
          )?.at ?? optimisticAt,
        );
        replaceMessage(web.value.messages, pendingRunId, {
          id: `${pendingRunId}:assistant`,
          runId: pendingRunId,
          role: "assistant",
          text: "Checking whether your message went through…",
          at: placeholderAt,
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
        let disposition:
          "admitted" | "not-admitted" | "detached" | "unreachable";
        try {
          disposition = await reconcileUncertainAdmission(
            botId,
            pendingRunId,
            observer.signal,
          );
        } finally {
          if (admissionObserver === observer) admissionObserver = undefined;
        }
        // The reconciliation ran out of attempts: this tab cannot reach the
        // backend at all. That is the app's own failure and it says so, in
        // place of the placeholder, with the Retry the person would otherwise
        // have to improvise — and with the Turn no longer running, so Stop
        // stops standing for a Turn nobody is executing.
        if (disposition === "unreachable") {
          replaceMessage(web.value.messages, pendingRunId, {
            id: `${pendingRunId}:assistant`,
            runId: pendingRunId,
            role: "assistant",
            text: UNREACHABLE_BOT_MESSAGE_V1,
            at: placeholderAt,
            status: "error",
            retry: "resend",
            tools: [],
            sends: [],
          });
          // The bubble is the report, and it is the one carrying the Retry.
          // Saying the same sentence again in the banner above it is what the
          // thread already looked like when it was broken — the same string
          // three times over — so the banner is cleared rather than set.
          web.value.error = undefined;
          web.value.activeRun = undefined;
          web.value.activeRunId = undefined;
          web.value.runningRunId = undefined;
          return { accepted: false, error: UNREACHABLE_BOT_MESSAGE_V1 };
        }
        if (disposition === "not-admitted") {
          replaceMessage(web.value.messages, pendingRunId, {
            id: `${pendingRunId}:assistant`,
            runId: pendingRunId,
            role: "assistant",
            text: "Your message didn't go through. Try sending it again.",
            at: placeholderAt,
            status: "error",
            tools: [],
            sends: [],
          });
          web.value.error =
            "Your message didn't go through. Try sending it again.";
          return {
            accepted: false,
            error: "Your message didn't go through. Try sending it again.",
          };
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
        // The optimistic Stop target goes with it: a Turn nobody is running is
        // not a Turn anybody can stop.
        if (
          web.value.runningRunId === pendingRunId &&
          web.value.activeRunId !== pendingRunId
        ) {
          web.value.runningRunId = undefined;
        }
      }
    },
    async resumeRun(runId: string): Promise<void> {
      if (!ctx.transport.reconcileRun) {
        web.value.settingsError = "Can't retry this right now.";
        return;
      }
      if (web.value.activeRun?.runId !== runId) return;
      web.value.activeRun = {
        runId,
        status: "running",
        message: "Retrying…",
        canResume: false,
      };
      const botId = web.value.activeBotId;
      if (!botId) return;
      try {
        await ctx.transport.reconcileRun(botId, runId);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error ? error.message : "Couldn't retry that.";
      }
      try {
        await deliverNotifications(botId);
      } catch (error) {
        web.value.settingsError =
          error instanceof Error
            ? error.message
            : "Couldn't refresh this reply.";
      }
    },
    async stopRun(): Promise<void> {
      const botId = web.value.activeBotId;
      // The Turn that is executing, never the message waiting behind it: Stop
      // cancels what the Bot is doing and does not discard what the User just
      // sent.
      const runId =
        web.value.activeRun?.runId ??
        web.value.runningRunId ??
        web.value.activeRunId;
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
  } satisfies Partial<ShellWebData>) as unknown as Ref<ShellWebData>;

  /*
   * Declarative Package entries.
   *
   * An entry is manifest data, so the sidebar control and the surface it opens
   * are registered from the Bot's Composition rather than by Package code:
   * nothing a Package ships executes in the app origin. The registrations are
   * disposed and rebuilt whenever the catalog changes, so switching Bots never
   * leaves the previous Bot's entries in the sidebar.
   */
  let entryDisposers: Array<() => void> = [];

  function syncPackageEntries(entries: PackageIframeEntryV1[]): void {
    for (const dispose of entryDisposers.splice(0).toReversed()) dispose();
    entryDisposers = entries.flatMap((entry) => {
      const trigger = defineComponent({
        name: `PackageEntry_${entry.contribution.packageId}_${entry.entry.id}`,
        setup: () => () => h(PackageEntryTrigger, { entry }),
      });
      const page = defineComponent({
        name: `PackageSurface_${entry.contribution.packageId}_${entry.page.id}`,
        setup: () => () => h(PackageSurfacePage, { entry }),
      });
      return [
        surfaces.register({
          id: entry.surfaceId,
          title: entry.entry.label,
          component: page,
        }),
        ctx.slot({
          slot: entry.entry.slot,
          order: entry.order,
          key: entry.surfaceId,
          component: trigger,
        }),
      ];
    });
  }

  const stopEntrySync = watch(
    () => packageIframeEntriesV1(web.value.packageUi),
    (entries) => syncPackageEntries(entries),
    { deep: true },
  );

  /*
   * The canvas follows the Turn.
   *
   * A Turn that creates, publishes, reverts, or deletes an Applet changes what
   * the canvas should show, and the durable answer is only readable once the
   * Turn has settled — so the moment `activeRunId` clears, the list and the
   * focus are read back. While a Turn is running with an Applet focused, the
   * source is re-read on a cadence so the code view shows files as the Bot
   * writes them; the read is the Workspace store and wakes nothing.
   */
  const APPLET_SOURCE_FOLLOW_MS = 2_000;
  let sourceFollow: ReturnType<typeof setInterval> | undefined;
  const stopSourceFollow = (): void => {
    if (sourceFollow !== undefined) clearInterval(sourceFollow);
    sourceFollow = undefined;
  };
  const stopRunFollow = watch(
    () => web.value.activeRunId,
    (runId, previous) => {
      stopSourceFollow();
      if (!appletsAvailableV1(web.value.packageUi)) return;
      if (runId) {
        if (!web.value.focusedAppletId) return;
        sourceFollow = setInterval(() => {
          if (!web.value.focusedAppletId || !web.value.activeRunId) {
            stopSourceFollow();
            return;
          }
          void web.value.refreshAppletCanvas();
        }, APPLET_SOURCE_FOLLOW_MS);
        return;
      }
      if (!previous) return;
      void (async () => {
        await web.value.loadApplets();
        await web.value.loadFocusedApplet();
      })();
    },
  );

  /*
   * A running Turn reaches every browser that is looking, not only the one
   * holding its POST.
   *
   * The reply to `POST /api/bots/:bot/turns` is one client's copy of a Turn.
   * A reload, a second tab, or a dropped request has no such copy, so the
   * transcript would sit on a spinner until somebody reloaded again. Two
   * seams close that: the Bot's state channel pushes a `runs` invalidation
   * whenever the durable run records move, and — for any client that has no
   * socket — the run is polled to its terminal state. Both end in the same
   * `GET /api/bots/:bot/turns` projection, so neither invents client state
   * and the one-bubble-per-send contract is untouched.
   */
  let stopRunChannel: (() => void) | undefined;
  const stopRunChannelWatch = watch(
    () => web.value.activeBotId,
    (botId) => {
      stopRunChannel?.();
      stopRunChannel = undefined;
      if (!botId || !ctx.transport.watchBotState) return;
      const generation = selectionGeneration;
      stopRunChannel = ctx.transport.watchBotState(botId, {
        async invalidate(topic) {
          // A reset carries no topic and means "read everything again".
          if (topic !== undefined && topic !== "runs") return;
          if (
            generation !== selectionGeneration ||
            web.value.activeBotId !== botId
          )
            return;
          await deliverNotifications(botId, generation);
        },
        status() {
          // The channel's health is not the transcript's: an unavailable
          // socket falls back to the observation below, which is what a
          // client without one uses anyway.
        },
      });
    },
    { immediate: true },
  );

  const stopRunObservation = watch(
    () => [web.value.activeBotId, web.value.activeRunId] as const,
    ([botId, runId]) => {
      // The send path owns the run it started: its POST is the observation,
      // and `stopRun` starts its own. This is for every other way a client
      // finds itself watching a Turn it is not holding open.
      if (!botId || !runId || activeRequest || runObserver) return;
      const generation = selectionGeneration;
      const observer = new AbortController();
      runObserver = observer;
      void observeRunUntilTerminal(botId, runId, generation, observer.signal)
        .catch(() => {
          // `observeRunUntilTerminal` reports its own failures; a rejection
          // here would be an unhandled one.
        })
        .finally(() => {
          if (runObserver === observer) runObserver = undefined;
        });
    },
    { immediate: true },
  );

  return [
    ctx.provide(clientSurfaceRegistryKey, surfaces),
    // The shared client projection is updated by the contracts lane. This cast
    // is the seam between its retired methods and this lane's replacement.
    ctx.provide(frockBotWebDataKey, web as unknown as Ref<FrockBotWebData>),
    ctx.slot({
      slot: "authenticated-root",
      order: 10_000,
      component: FrockBotApp,
    }),
    ctx.slot({
      slot: "frockbot.bot-settings-sections",
      order: 10_000,
      component: PackageIframeSettings,
    }),
    () => {
      stopEntrySync();
      stopRunFollow();
      stopRunChannelWatch();
      stopRunChannel?.();
      stopRunObservation();
      stopSourceFollow();
      for (const dispose of entryDisposers.splice(0).toReversed()) dispose();
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

/** Takes back both optimistic lines of a send the Bot never admitted. */
function removeMessages(messages: WebChatMessage[], runId: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.runId === runId) messages.splice(index, 1);
  }
}

export default shellClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-shell/client",
  plugin: shellClientPlugin,
});
