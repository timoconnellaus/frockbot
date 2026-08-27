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

export interface FrockBotWebData {
  connection: WebConnection;
  modelLabel: string;
  messages: WebChatMessage[];
  activeRunId?: string;
  error?: string;
  sendPrompt(text: string): Promise<SendPromptResult>;
  abort(): Promise<void>;
  restart(): Promise<void>;
}

export const frockBotWebDataKey: InjectionKey<Ref<FrockBotWebData>> =
  Symbol("frockbot-web-data");
