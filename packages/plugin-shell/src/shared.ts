export { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

import type {
  JsonValue,
  BotNameProvenanceV1,
  BotNotificationPolicy,
  BotProfile,
  BotProfilePatchV1,
  BotSettingsViewV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type {
  CatalogEntryV1,
  CatalogIndexEntryV1,
} from "@frockbot/catalog-core";
import type {
  AppletBuildViewV1,
  AppletSourceViewV1,
  AppletSummaryV1,
  PackageIframeCatalogV1,
  PackageIframeContributionViewV1,
  SendToUserPayloadV1,
  SkillRefV1,
} from "@frockbot/kernel-contracts";
import type { McpServerStatusViewV1 } from "@frockbot/plugin-mcp/records";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import type { ClientSkillCatalogEntryV1 } from "./skill-protocol.js";
import type { ApprovalCardViewV1 } from "./approvals.js";
import type { TaskViewV1 } from "@frockbot/plugin-subagents/shared";
import type { InjectionKey, Ref } from "vue";

export type { CatalogEntryV1, CatalogIndexEntryV1 };

export type WebConnection = "starting" | "ready" | "disconnected" | "error";

/** One binary a tool filed, as the thread draws it: a reference, not bytes. */
export interface WebToolAttachment {
  kind: "image";
  mediaType: string;
  contentHash: string;
  /** The encoded `WorkspacePathV1` the Workspace read route takes. */
  path: string;
}

export interface WebToolActivity {
  id: string;
  name: string;
  input?: unknown;
  status: "running" | "completed" | "failed";
  text?: string;
  attachments?: WebToolAttachment[];
}

/**
 * One user-facing send, as the thread draws it. An `unsupported` entry is a
 * payload this client cannot draw — a newer payload shape, or a malformed one.
 * The thread says so rather than throwing, because a Turn's history has to
 * render on a client older than the Bot that produced it.
 */
export type WebSendPayload =
  { kind: "payload"; payload: SendToUserPayloadV1 } | { kind: "unsupported" };

/**
 * One dispatched subagent, as the thread draws it.
 *
 * The chip carries what the durable dispatch said; its live status and summary
 * are read from {@link FrockBotWebData.tasks}, because a background task
 * settles long after the Turn that dispatched it and the run's own events
 * never change again.
 */
export interface WebTaskChip {
  taskId: string;
  taskType: string;
  description: string;
  model: string;
  background: boolean;
}

export interface WebChatMessage {
  id: string;
  runId: string;
  /**
   * `system` is the Session speaking rather than either party: a rename
   * announcement, for instance. It carries no avatar and no tools.
   */
  role: "user" | "assistant" | "system";
  text: string;
  /** When the line happened, so system lines sort into the conversation. */
  at?: string;
  status:
    | "streaming"
    | "completed"
    | "aborted"
    | "error"
    | "interrupted"
    | "reconciliation-required";
  /**
   * True while this line's Turn is admitted but has not started, because the
   * User sent it while the Bot was still on the previous one. The thread
   * greys it and nothing else: it is an ordinary message the Bot has not
   * reached, not a state the User has to understand.
   */
  pending?: boolean;
  tools: WebToolActivity[];
  /** The typed payloads this Turn sent to the user, oldest first. */
  sends: WebSendPayload[];
  /**
   * The subagents this Turn dispatched, oldest first. Optional so every
   * existing message literal — and every stored projection — still reads.
   */
  tasks?: WebTaskChip[];
}

export interface WebActiveRun {
  runId: string;
  status: "running" | "interrupted" | "reconciliation-required";
  message: string;
  canResume: boolean;
}

export interface SendPromptResult {
  accepted: boolean;
  runId?: string;
  error?: string;
}

export interface PluginCatalogItem {
  packageId: string;
  displayName: string;
  version: string;
  /** Backend-derived manifest fact; platform infrastructure has no User toggle. */
  platformOwned?: boolean;
  capabilities: Array<{
    id: string;
    kind: "model" | "tool" | "memory" | "notification" | "computer";
    connectionTypes: string[];
  }>;
  connectionTypes: Array<{
    id: string;
    displayName: string;
    allowMultiple: boolean;
    authorizationKind: "none" | "api-key" | "ambient-native" | "grant";
    capabilities: string[];
  }>;
  /**
   * The Package-level settings this Package declares at User scope — the form
   * the Plugins surface generates for it. Connection-scoped settings are not
   * here: they belong to one Connection and are edited with it.
   *
   * Optional, and read as `[]` when absent: the decoder always fills it, so
   * absence means a catalog payload projected before this field existed, and a
   * Package with no declared settings is the same thing as one whose settings
   * a client cannot see — no form.
   */
  settings?: PackageSettingDefinition[];
}

/** What an external authorization redirect told the app on the way back. */
export interface ConnectionReturnV1 {
  /** The Package that owns the Connection, e.g. `composio`. */
  packageId: string;
  status: "ready" | "pending" | "failed";
  /** A provider- or callback-supplied explanation, when there is one. */
  reason?: string;
}

const CONNECTION_RETURN_PARAM = "connection";
const CONNECTION_RETURN_REASON_PARAM = "connection_reason";
const MAX_CONNECTION_RETURN_REASON = 300;

/**
 * Read an authorization return out of a URL query string.
 *
 * The callback redirects to `/?connection=<packageId>-<status>`. Left unread it
 * is a stale query string and nothing else: the User is returned to the app
 * with no confirmation, and a `failed` grant vanishes entirely.
 */
export function decodeConnectionReturnV1(
  search: string,
): ConnectionReturnV1 | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const raw = params.get(CONNECTION_RETURN_PARAM);
  if (!raw) return undefined;
  const separator = raw.lastIndexOf("-");
  if (separator <= 0) return undefined;
  const packageId = raw.slice(0, separator);
  const status = raw.slice(separator + 1);
  if (status !== "ready" && status !== "pending" && status !== "failed") {
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(packageId)) return undefined;
  const reason = params
    .get(CONNECTION_RETURN_REASON_PARAM)
    ?.slice(0, MAX_CONNECTION_RETURN_REASON);
  return { packageId, status, ...(reason ? { reason } : {}) };
}

/** The same query string with the return parameters removed. */
export function withoutConnectionReturnV1(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CONNECTION_RETURN_PARAM);
  params.delete(CONNECTION_RETURN_REASON_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export interface FrockBotWebData {
  connection: WebConnection;
  modelLabel: string;
  modelReady: boolean;
  /**
   * Where the effective model comes from: the Bot's own override, the User's
   * default, or nothing at all.
   */
  modelSource: "bot" | "default" | "none";
  settingsAvailable: boolean;
  connectionsAvailable: boolean;
  activeBotId?: string;
  composerContext?: unknown;
  messages: WebChatMessage[];
  /**
   * The newest Turn that has not settled — running, or admitted and waiting.
   * A message sent now supersedes this one.
   */
  activeRunId?: string;
  /**
   * The Turn actually executing, which is what Stop targets. It differs from
   * `activeRunId` only while a message the User sent mid-Turn is waiting: Stop
   * cancels what the Bot is doing and never discards what they just sent.
   */
  runningRunId?: string;
  activeRun?: WebActiveRun;
  error?: string;
  botSettings?: BotSettingsViewV1;
  userSettings?: UserSettingsViewV1;
  pluginCatalog: PluginCatalogItem[];
  /**
   * The remote Catalog index, read through `/catalog/v1/index`. Separate from
   * `pluginCatalog`, which projects the compiled-in application manifest: the
   * two answer different questions — what this deployment can execute, and what
   * the Catalog offers to install.
   */
  packageCatalog: CatalogIndexEntryV1[];
  /** The generation `packageCatalog` was read from; every install names it. */
  packageCatalogGeneration?: string;
  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover. Refs,
   * names and descriptions — never a body.
   */
  skillCatalog: ClientSkillCatalogEntryV1[];
  /**
   * The Bot's approval cards, newest first — pending and already decided
   * alike, so the card in the transcript can say what was decided rather than
   * going quiet the moment somebody answers it. Loaded for the selected Bot.
   */
  approvals: ApprovalCardViewV1[];
  /**
   * The Bot's subagent tasks, newest first. The chip in the transcript is the
   * durable dispatch; this is what it currently *is* — status, summary, and
   * failure — so a chip drawn before the child settled says so afterwards
   * without the run's own events being rewritten.
   */
  tasks: TaskViewV1[];
  /** Sandboxed pages in the selected Bot's active fail-closed Composition. */
  packageUi?: PackageIframeCatalogV1;
  /**
   * The Applets this User owns. Account-wide, like every other Package-shaped
   * capability: an Applet belongs to the User, and every Bot they own sees it.
   */
  applets: AppletSummaryV1[];
  /**
   * The Session's focused Applet id, as the Bot Durable Object recorded it.
   * `null` is a value — the Session deliberately has no Applet in the canvas —
   * and `undefined` means it has not been read yet.
   */
  focusedAppletId?: string | null;
  /** The focused Applet joined with the list. Derived; never written to. */
  readonly focusedApplet?: AppletSummaryV1;
  /** Where the focused Applet's live UI is, and the credential to open it. */
  appletViewer?: {
    appletId: string;
    token: string;
    expiresAt: string;
    socketUrl: string;
    uiUrl: string;
    generationId: string;
  };
  /** The focused Applet's source, for the canvas's building state. */
  appletSource?: AppletSourceViewV1;
  /** The outcome the Bot last recorded for `applet check` or `applet build`. */
  appletBuild?: AppletBuildViewV1;
  /**
   * How the canvas's own read went. `loading` is the first read of a focused
   * Applet, `failed` is a read the User can retry, and `ready` says the canvas
   * has everything it needs to draw either of its states.
   */
  appletCanvas: "idle" | "loading" | "ready" | "failed";
  appletCanvasError?: string;
  /**
   * The User's MCP servers: state, tool count, last handshake, instructions,
   * failure, and the durable refusal ledger. Absent until it is loaded, and
   * absent for a deployment with no MCP route — the Plugins surface then
   * shows the servers as Connections and nothing more.
   */
  mcpServers?: McpServerStatusViewV1;
  settingsError?: string;
  /**
   * What the browser came back from an external authorization with. Read once
   * from the return URL at boot and cleared when the User has seen it, so a
   * cancelled or failed grant is reported rather than silently discarded.
   */
  connectionReturn?: ConnectionReturnV1;
  selectBot(botId: string): Promise<void>;
  loadBotSettings(): Promise<void>;
  saveBotProfile(profile: BotProfile): Promise<void>;
  /** Partial profile update: only the fields it carries change. */
  setBotProfile(
    profile: BotProfilePatchV1,
    namedBy?: BotNameProvenanceV1,
  ): Promise<void>;
  saveBotNotifications(notifications: BotNotificationPolicy): Promise<void>;
  loadUserSettings(): Promise<void>;
  saveUserProfile(profile: { name: string; email?: string }): Promise<void>;
  loadPluginCatalog(): Promise<void>;
  /** Refreshes {@link FrockBotWebData.mcpServers}. */
  loadMcpServers(): Promise<void>;
  /**
   * The instructions attached to one MCP server, which become the description
   * its tools carry in the next Turn's model request. An empty string clears
   * them.
   */
  setMcpInstructions(serverId: string, instructions: string): Promise<void>;
  /**
   * Restarts one MCP server: its epoch is bumped, so the next admitted Turn
   * re-handshakes and re-lists its tools.
   */
  restartMcpServer(serverId: string): Promise<void>;
  /**
   * Connect or reconnect an OAuth MCP server, returning the host-authored
   * redirect the User is about to follow. `connectionId` reconnects an
   * existing Connection — the connect card's *Reconnect* — and its absence
   * creates one from `settings`.
   */
  startMcpAuthorization(input: {
    connectionId?: string;
    label?: string;
    settings?: Record<string, unknown>;
  }): Promise<string | undefined>;
  loadPackageCatalog(): Promise<void>;
  /** One entry detail, for the panel a User opens before installing. */
  loadCatalogEntry(catalogId: string): Promise<CatalogEntryV1 | undefined>;
  /** Refreshes {@link FrockBotWebData.skillCatalog} for the active Bot. */
  loadSkillCatalog(): Promise<void>;
  /** Refreshes {@link FrockBotWebData.approvals} for the active Bot. */
  loadApprovals(): Promise<void>;
  /** Refreshes {@link FrockBotWebData.tasks} for the active Bot. */
  loadTasks(): Promise<void>;
  loadPackageUi(): Promise<void>;
  /** Refreshes {@link FrockBotWebData.applets} for the signed-in User. */
  loadApplets(): Promise<void>;
  /** Refreshes the Session's focused Applet for the active Bot. */
  loadFocusedApplet(): Promise<void>;
  /**
   * Focuses one Applet for this Session, or clears the focus. The backend is
   * the authority: what the canvas then shows is the focus that was recorded,
   * never the one the click asked for.
   */
  setFocusedApplet(appletId: string | null): Promise<void>;
  /**
   * Re-reads what the canvas draws for the focused Applet: its source, the
   * last recorded check or build outcome, and a viewer credential once a
   * generation is active.
   */
  refreshAppletCanvas(): Promise<void>;
  callPackageUiTool(
    contribution: PackageIframeContributionViewV1,
    name: string,
    input: unknown,
  ): Promise<unknown>;
  /**
   * Cancels one subagent, explicitly and with the User's authentication. The
   * backend is the authority: the task this replaces in the list is the record
   * it answered with, never what the click assumed.
   */
  stopTask(taskId: string): Promise<void>;
  /**
   * Records one decision on one approval card. The backend is the authority:
   * this submits the command and re-reads what was recorded, so a card already
   * answered elsewhere shows that answer rather than this client's guess.
   */
  decideApproval(
    approvalId: string,
    decision: "approved" | "denied",
  ): Promise<void>;
  installPackage(packageId: string, version: string): Promise<void>;
  /**
   * Enables or disables one installed Package for this User. Enablement is the
   * whole of what the Plugins surface does: a disabled Package keeps its
   * installation, its settings, and its Connections, and stops being available
   * to any Bot until it is enabled again.
   */
  setPackageEnabled(packageId: string, enabled: boolean): Promise<void>;
  /**
   * A partial update of one installed Package's setting values. Only the ids
   * it carries change; the rest keep the values they had.
   */
  savePackageSettings(
    packageId: string,
    values: Record<string, string | number | boolean>,
  ): Promise<void>;
  installCatalogPackage(
    entry: CatalogIndexEntryV1,
    /** The entry's `setupFields`, as the User filled them in. */
    values?: Record<string, JsonValue>,
  ): Promise<void>;
  uninstallPackage(packageId: string): Promise<void>;
  /**
   * Puts this conversation down and starts the next one. Memory is kept; only
   * the history the next Turn carries is new (ADR 0027).
   */
  startConversation(): Promise<void>;
  startConnection(
    packageId: string,
    connectionTypeId: string,
  ): Promise<string | undefined>;
  openConnectionAuthorization(url: string): Promise<void>;
  revokeConnection(packageId: string, connectionId: string): Promise<void>;
  createApiKeyConnection(input: {
    packageId: string;
    connectionTypeId: string;
    label: string;
    apiKey: string;
    /** Connection-scoped settings the Connection Type's manifest declares. */
    settings?: Record<string, string | number | boolean | null>;
  }): Promise<void>;
  /**
   * A Connection of a Connection Type whose authorization kind is `none`: it
   * has no credential, so its settings are the whole of its configuration.
   */
  createConnection(input: {
    packageId: string;
    connectionTypeId: string;
    label: string;
    settings?: Record<string, string | number | boolean | null>;
  }): Promise<void>;
  rotateApiKeyConnection(connectionId: string, apiKey: string): Promise<void>;
  updateConnectionLabel(connectionId: string, label: string): Promise<void>;
  refreshConnectionModels(connectionId: string): Promise<void>;
  setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void>;
  disconnectConnection(
    connectionId: string,
    revokeUpstream?: boolean,
  ): Promise<void>;
  /** `skills` are the refs the composer attached; absent means none. */
  sendPrompt(
    text: string,
    skills?: readonly SkillRefV1[],
  ): Promise<SendPromptResult>;
  resumeRun(runId: string): Promise<void>;
  /** Sends the durable Stop command for the observed active run. */
  stopRun(): Promise<void>;
  /** Detaches the local observer only; admitted work stays durable. */
  abort(): Promise<void>;
}

export const frockBotWebDataKey: InjectionKey<Ref<FrockBotWebData>> =
  Symbol("frockbot-web-data");
