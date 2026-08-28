import { randomUUID } from "node:crypto";
import type { Entry } from "@cordisjs/plugin-webui";
import {
  addFrockBotWebEntry,
  type FrockBotWebData,
  type SendPromptResult,
  type WebChatMessage,
  type WebToolActivity,
} from "@frockbot/plugin-shell";
import type { AgentEvent } from "@frockbot/protocol";
import type { Context, Plugin } from "cordis";
import { AgentProcess } from "./agent-process.js";

function assistantFor(
  messages: WebChatMessage[],
  runId: string,
): WebChatMessage | undefined {
  return messages.find(
    (message) => message.role === "assistant" && message.runId === runId,
  );
}

class WebChatController {
  private entry: Entry<FrockBotWebData>;
  private process: AgentProcess;
  private data: FrockBotWebData;

  constructor(ctx: Context) {
    this.process = new AgentProcess((event) => this.handleEvent(event));
    this.data = {
      connection: "starting",
      modelLabel: "Cordis · custom agent loop",
      settingsAvailable: false,
      connectionsAvailable: false,
      messages: [],
      pluginCatalog: [],
      loadBotSettings: () =>
        Promise.reject(new Error("Settings require the hosted backend")),
      saveBotProfile: () =>
        Promise.reject(new Error("Settings require the hosted backend")),
      saveBotNotifications: () =>
        Promise.reject(new Error("Settings require the hosted backend")),
      loadUserSettings: () =>
        Promise.reject(new Error("Settings require the hosted backend")),
      saveUserProfile: () =>
        Promise.reject(new Error("Settings require the hosted backend")),
      loadPluginCatalog: () =>
        Promise.reject(new Error("Plugins require the hosted backend")),
      installPackage: () =>
        Promise.reject(new Error("Plugins require the hosted backend")),
      startConnection: () =>
        Promise.reject(new Error("Connections require the hosted backend")),
      revokeConnection: () =>
        Promise.reject(new Error("Connections require the hosted backend")),
      sendPrompt: (text: string) => Promise.resolve(this.sendPrompt(text)),
      abort: () => Promise.resolve(this.abort()),
      restart: () => Promise.resolve(this.restart()),
    };
    this.entry = addFrockBotWebEntry(ctx, this.data);
  }

  start(): void {
    this.process.start();
  }

  dispose(): void {
    this.process.dispose();
    this.entry.dispose();
  }

  private sendPrompt(text: string): SendPromptResult {
    const normalized = text.trim();
    if (!normalized) return { accepted: false, error: "Prompt is empty" };
    if (this.data.connection !== "ready") {
      return { accepted: false, error: "The Cordis agent is unavailable" };
    }
    if (this.data.activeRunId) {
      return { accepted: false, error: "Another turn is already running" };
    }

    const runId = randomUUID();
    this.entry.mutate((data) => {
      data.error = undefined;
      data.activeRunId = runId;
      data.messages.push(
        {
          id: `${runId}:user`,
          runId,
          role: "user",
          text: normalized,
          status: "completed",
          tools: [],
        },
        {
          id: `${runId}:assistant`,
          runId,
          role: "assistant",
          text: "",
          status: "streaming",
          tools: [],
        },
      );
    });

    const response = this.process.prompt({ runId, text: normalized });
    if (!response.accepted) {
      this.entry.mutate((data) => {
        data.activeRunId = undefined;
        data.error = response.error ?? "The Cordis agent rejected the prompt";
        const assistant = assistantFor(data.messages, runId);
        if (assistant) {
          assistant.status = "error";
          assistant.text = data.error;
        }
      });
      return { ...response, runId };
    }
    return { accepted: true, runId };
  }

  private abort(): void {
    if (this.data.activeRunId) this.process.abort(this.data.activeRunId);
  }

  private restart(): void {
    this.entry.mutate((data) => {
      data.connection = "starting";
      data.activeRunId = undefined;
      data.error = undefined;
    });
    this.process.restart();
  }

  private handleEvent(event: AgentEvent): void {
    this.entry.mutate((data) => {
      if (event.type === "worker-ready") {
        data.connection = "ready";
        data.error = undefined;
        data.modelLabel = event.model
          ? `${event.model.provider} · ${event.model.id}`
          : "Cordis · custom agent loop";
        return;
      }
      if (event.type === "worker-exit") {
        data.connection = "disconnected";
        data.activeRunId = undefined;
        data.error = `Cordis agent exited${event.code === null ? "" : ` with code ${event.code}`}.`;
        return;
      }
      if (event.type === "error") {
        if (event.phase === "startup") data.connection = "error";
        if (!event.runId || data.activeRunId === event.runId)
          data.activeRunId = undefined;
        data.error = event.message;
        if (event.runId) {
          const assistant = assistantFor(data.messages, event.runId);
          if (assistant) {
            assistant.status = "error";
            assistant.text ||= `I hit a problem: ${event.message}`;
          }
        }
        return;
      }
      if (event.type === "text-delta") {
        const assistant = assistantFor(data.messages, event.runId);
        if (assistant) assistant.text += event.text;
        return;
      }
      if (event.type === "tool-start") {
        const assistant = assistantFor(data.messages, event.runId);
        assistant?.tools.push({
          id: event.toolCallId,
          name: event.name,
          status: "running",
        });
        return;
      }
      if (event.type === "tool-end") {
        const tool = assistantFor(data.messages, event.runId)?.tools.find(
          (candidate: WebToolActivity) => candidate.id === event.toolCallId,
        );
        if (tool) {
          tool.status = event.isError ? "failed" : "completed";
          tool.text = event.text;
        }
        return;
      }
      if (event.type === "settled") {
        if (data.activeRunId === event.runId) data.activeRunId = undefined;
        const assistant = assistantFor(data.messages, event.runId);
        if (assistant) {
          assistant.status =
            event.reason === "aborted" ? "aborted" : "completed";
          assistant.text ||= event.reason === "aborted" ? "Stopped." : "Done.";
        }
      }
    });
  }
}

export const webChatPlugin: Plugin.Function = (ctx) => {
  const controller = new WebChatController(ctx);
  controller.start();
  return () => controller.dispose();
};
webChatPlugin.inject = ["webui"];
