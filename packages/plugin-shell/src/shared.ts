export { decodeExternalAuthorizationUrl } from "@frockbot/protocol";

import type {
  BotNotificationPolicy,
  BotProfile,
  BotSettingsViewV1,
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
  role: "user" | "assistant";
  text: string;
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
  connectionTypes: Array<{
    id: string;
    displayName: string;
    allowMultiple: boolean;
    authorizationKind: "oauth2" | "api-key" | "custom";
    capabilities: string[];
  }>;
}

export interface FrockBotWebData {
  connection: WebConnection;
  modelLabel: string;
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
  saveBotNotifications(notifications: BotNotificationPolicy): Promise<void>;
  loadUserSettings(): Promise<void>;
  saveUserProfile(profile: { name: string; email?: string }): Promise<void>;
  loadPluginCatalog(): Promise<void>;
  installPackage(packageId: string, version: string): Promise<void>;
  startConnection(
    packageId: string,
    connectionTypeId: string,
  ): Promise<string | undefined>;
  openConnectionAuthorization(url: string): Promise<void>;
  revokeConnection(packageId: string, connectionId: string): Promise<void>;
  sendPrompt(text: string): Promise<SendPromptResult>;
  resumeRun(runId: string): Promise<void>;
  abort(): Promise<void>;
}

export const frockBotWebDataKey: InjectionKey<Ref<FrockBotWebData>> =
  Symbol("frockbot-web-data");
