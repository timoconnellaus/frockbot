import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AgentEvent,
  type FrockBotDesktopAPI,
  type PromptRequest,
  type PromptResponse,
} from "@frockbot/protocol";

const api: FrockBotDesktopAPI = {
  sendPrompt(request: PromptRequest): Promise<PromptResponse> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.prompt,
      request,
    ) as Promise<PromptResponse>;
  },
  abort(runId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.abort, runId) as Promise<void>;
  },
  restart(): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.restart) as Promise<void>;
  },
  onAgentEvent(listener: (event: AgentEvent) => void): void {
    ipcRenderer.on(IPC_CHANNELS.event, (_event, value: AgentEvent) =>
      listener(value),
    );
  },
  clearAgentEventListeners(): void {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.event);
  },
};

contextBridge.exposeInMainWorld("frockbot", api);
