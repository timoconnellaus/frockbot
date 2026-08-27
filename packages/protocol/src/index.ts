export const IPC_CHANNELS = {
  prompt: "agent:prompt",
  abort: "agent:abort",
  restart: "agent:restart",
  event: "agent:event",
} as const;

export interface PromptRequest {
  runId: string;
  text: string;
}

export type AgentCommand =
  | { type: "prompt"; runId: string; text: string }
  | { type: "abort"; runId: string }
  | { type: "shutdown" };

export interface AgentModelSummary {
  provider: string;
  id: string;
}

export type AgentEvent =
  | { type: "worker-ready"; model?: AgentModelSummary }
  | { type: "run-started"; runId: string }
  | { type: "text-delta"; runId: string; text: string }
  | {
      type: "tool-start";
      runId: string;
      toolCallId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-end";
      runId: string;
      toolCallId: string;
      name: string;
      text: string;
      isError: boolean;
    }
  | { type: "settled"; runId: string; reason: "completed" | "aborted" }
  | { type: "error"; runId?: string; phase: "startup" | "run"; message: string }
  | { type: "worker-exit"; code: number | null };

export interface PromptResponse {
  accepted: boolean;
  error?: string;
}

export interface FrockBotDesktopAPI {
  sendPrompt(request: PromptRequest): Promise<PromptResponse>;
  abort(runId: string): Promise<void>;
  restart(): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): void;
  clearAgentEventListeners(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPromptRequest(value: unknown): value is PromptRequest {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "shutdown") return true;
  if (value.type === "abort")
    return typeof value.runId === "string" && value.runId.length > 0;
  return (
    value.type === "prompt" &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "worker-ready":
      return value.model === undefined || isRecord(value.model);
    case "worker-exit":
      return value.code === null || typeof value.code === "number";
    case "error":
      return (
        typeof value.message === "string" &&
        (value.phase === "startup" || value.phase === "run")
      );
    case "run-started":
      return typeof value.runId === "string";
    case "text-delta":
      return typeof value.runId === "string" && typeof value.text === "string";
    case "tool-start":
      return (
        typeof value.runId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string"
      );
    case "tool-end":
      return (
        typeof value.runId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string" &&
        typeof value.text === "string" &&
        typeof value.isError === "boolean"
      );
    case "settled":
      return (
        typeof value.runId === "string" &&
        (value.reason === "completed" || value.reason === "aborted")
      );
    default:
      return false;
  }
}
