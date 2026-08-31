export { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

import type {
  BotAvatarContentTypeV1,
  BotNameProvenanceV1,
  BotNotificationPolicy,
  BotProfile,
  BotProfilePatchV1,
  BotSettingsViewV1,
  CapabilityAssignmentView,
  ModelAssignment,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { InjectionKey, Ref } from "vue";

export type WebConnection = "starting" | "ready" | "disconnected" | "error";

export interface WebToolActivity {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  text?: string;
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
  tools: WebToolActivity[];
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
  installPackage(packageId: string, version: string): Promise<void>;
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
  }): Promise<void>;
  rotateApiKeyConnection(connectionId: string, apiKey: string): Promise<void>;
  updateConnectionLabel(connectionId: string, label: string): Promise<void>;
  refreshConnectionModels(connectionId: string): Promise<void>;
  setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void>;
  disconnectConnection(
    connectionId: string,
    revokeUpstream?: boolean,
  ): Promise<void>;
  sendPrompt(text: string): Promise<SendPromptResult>;
  resumeRun(runId: string): Promise<void>;
  /** Sends the durable Stop command for the observed active run. */
  stopRun(): Promise<void>;
  /** Detaches the local observer only; admitted work stays durable. */
  abort(): Promise<void>;
}

export const frockBotWebDataKey: InjectionKey<Ref<FrockBotWebData>> =
  Symbol("frockbot-web-data");
