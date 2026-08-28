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
  status: "streaming" | "completed" | "aborted" | "error";
  tools: WebToolActivity[];
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
  messages: WebChatMessage[];
  activeRunId?: string;
  error?: string;
  botSettings?: BotSettingsViewV1;
  userSettings?: UserSettingsViewV1;
  pluginCatalog: PluginCatalogItem[];
  settingsError?: string;
  loadBotSettings(): Promise<void>;
  saveBotProfile(profile: BotProfile): Promise<void>;
  saveBotNotifications(notifications: BotNotificationPolicy): Promise<void>;
  loadUserSettings(): Promise<void>;
  saveUserProfile(profile: { name: string; email?: string }): Promise<void>;
  loadPluginCatalog(): Promise<void>;
  installPackage(packageId: string, version: string): Promise<void>;
  startConnection(packageId: string, connectionTypeId: string): Promise<string>;
  revokeConnection(packageId: string, connectionId: string): Promise<void>;
  sendPrompt(text: string): Promise<SendPromptResult>;
  abort(): Promise<void>;
  restart(): Promise<void>;
}

export const frockBotWebDataKey: InjectionKey<Ref<FrockBotWebData>> =
  Symbol("frockbot-web-data");
