export { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

import type {
  BotAvatarContentTypeV1,
  JsonValue,
  BotNameProvenanceV1,
  BotNotificationPolicy,
  BotProfile,
  BotProfilePatchV1,
  BotSettingsViewV1,
  CapabilityAssignmentView,
  ModelAssignment,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type {
  CatalogEntryV1,
  CatalogIndexEntryV1,
} from "@frockbot/catalog-core";
import type {
  SendToUserPayloadV1,
  SkillRefV1,
} from "@frockbot/kernel-contracts";
import type { McpServerStatusViewV1 } from "@frockbot/plugin-mcp/records";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import type { ClientSkillCatalogEntryV1 } from "./skill-protocol.js";
import type { ApprovalCardViewV1 } from "./approvals.js";
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
  tools: WebToolActivity[];
  /** The typed payloads this Turn sent to the user, oldest first. */
  sends: WebSendPayload[];
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
  capabilities: Array<{
    id: string;
    kind:
      | "model"
      | "tool"
      | "memory"
      | "notification"
      | "computer"
      // Manifest v5. A Channel Capability is listed like any other; the
      // Plugins surface renders its id and kind and nothing more.
      | "channel";
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
  activeRunId?: string;
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
   * The User's MCP servers: state, tool count, last handshake, instructions,
   * failure, and the durable refusal ledger. Absent until it is loaded, and
   * absent for a deployment with no MCP route — the Plugins surface then
   * shows the servers as Connections and nothing more.
   */
  mcpServers?: McpServerStatusViewV1;
  settingsError?: string;
  selectBot(botId: string): Promise<void>;
  loadBotSettings(): Promise<void>;
  saveBotProfile(profile: BotProfile): Promise<void>;
  /** Partial profile update: only the fields it carries change. */
  setBotProfile(
    profile: BotProfilePatchV1,
    namedBy?: BotNameProvenanceV1,
  ): Promise<void>;
  /** Uploads avatar bytes and records the reference on the Bot's profile. */
  uploadBotAvatar(input: {
    contentType: BotAvatarContentTypeV1;
    bytes: string;
  }): Promise<void>;
  /** Restores the generated sheep avatar. */
  clearBotAvatar(): Promise<void>;
  saveBotNotifications(notifications: BotNotificationPolicy): Promise<void>;
  assignCapability(
    assignment: Omit<CapabilityAssignmentView, "state">,
  ): Promise<void>;
  replaceCapability(
    assignment: Omit<CapabilityAssignmentView, "state">,
  ): Promise<void>;
  unassignCapability(assignmentId: string): Promise<void>;
  saveBotModel(model: ModelAssignment): Promise<void>;
  clearBotModel(): Promise<void>;
  loadUserSettings(): Promise<void>;
  saveUserProfile(profile: { name: string; email?: string }): Promise<void>;
  /** The model every Bot uses unless it overrides it. */
  saveDefaultModel(model: ModelAssignment | undefined): Promise<void>;
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
