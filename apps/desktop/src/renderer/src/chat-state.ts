import type { AgentEvent, AgentModelSummary } from "@frockbot/protocol";

export interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  text?: string;
}

export interface ChatMessage {
  id: string;
  runId: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "completed" | "aborted" | "error";
  tools: ToolActivity[];
}

export interface ChatState {
  connection: "starting" | "ready" | "disconnected" | "error";
  model?: AgentModelSummary;
  messages: ChatMessage[];
  activeRunId?: string;
  error?: string;
}

export type ChatAction =
  | { type: "submit"; runId: string; text: string }
  | { type: "request-rejected"; runId: string; message: string }
  | { type: "restart" }
  | { type: "agent-event"; event: AgentEvent };

export const initialChatState: ChatState = {
  connection: "starting",
  messages: [],
};

function updateAssistant(
  messages: ChatMessage[],
  runId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message) =>
    message.role === "assistant" && message.runId === runId
      ? update(message)
      : message,
  );
}

function finishTool(
  tool: ToolActivity,
  event: Extract<AgentEvent, { type: "tool-end" }>,
): ToolActivity {
  if (tool.id !== event.toolCallId) return tool;
  return {
    ...tool,
    status: event.isError ? "failed" : "completed",
    text: event.text,
  };
}

function settledMessage(
  message: ChatMessage,
  reason: Extract<AgentEvent, { type: "settled" }>["reason"],
): ChatMessage {
  const status = reason === "aborted" ? "aborted" : "completed";
  const fallbackText = reason === "aborted" ? "Stopped." : "Done.";
  return { ...message, status, text: message.text || fallbackText };
}

function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "worker-ready":
      return {
        ...state,
        connection: "ready",
        model: event.model,
        error: undefined,
      };
    case "worker-exit":
      return {
        ...state,
        connection: "disconnected",
        activeRunId: undefined,
        error: `Pi worker exited${event.code === null ? "" : ` with code ${event.code}`}.`,
      };
    case "run-started":
      return { ...state, activeRunId: event.runId };
    case "text-delta":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.runId, (message) => ({
          ...message,
          text: message.text + event.text,
        })),
      };
    case "tool-start":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.runId, (message) => ({
          ...message,
          tools: [
            ...message.tools,
            { id: event.toolCallId, name: event.name, status: "running" },
          ],
        })),
      };
    case "tool-end":
      return {
        ...state,
        messages: updateAssistant(state.messages, event.runId, (message) => ({
          ...message,
          tools: message.tools.map((tool) => finishTool(tool, event)),
        })),
      };
    case "settled":
      return {
        ...state,
        activeRunId:
          state.activeRunId === event.runId ? undefined : state.activeRunId,
        messages: updateAssistant(state.messages, event.runId, (message) =>
          settledMessage(message, event.reason),
        ),
      };
    case "error":
      if (!event.runId) {
        return {
          ...state,
          connection: "error",
          activeRunId: undefined,
          error: event.message,
        };
      }
      return {
        ...state,
        activeRunId:
          state.activeRunId === event.runId ? undefined : state.activeRunId,
        error: event.message,
        messages: updateAssistant(state.messages, event.runId, (message) => ({
          ...message,
          status: "error",
          text: message.text || `I hit a problem: ${event.message}`,
        })),
      };
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "submit") {
    return {
      ...state,
      error: undefined,
      activeRunId: action.runId,
      messages: [
        ...state.messages,
        {
          id: `${action.runId}:user`,
          runId: action.runId,
          role: "user",
          text: action.text,
          status: "completed",
          tools: [],
        },
        {
          id: `${action.runId}:assistant`,
          runId: action.runId,
          role: "assistant",
          text: "",
          status: "streaming",
          tools: [],
        },
      ],
    };
  }
  if (action.type === "request-rejected") {
    return {
      ...state,
      activeRunId:
        state.activeRunId === action.runId ? undefined : state.activeRunId,
      error: action.message,
      messages: updateAssistant(state.messages, action.runId, (message) => ({
        ...message,
        status: "error",
        text: action.message,
      })),
    };
  }
  if (action.type === "restart") {
    return {
      ...state,
      connection: "starting",
      activeRunId: undefined,
      error: undefined,
    };
  }
  return applyAgentEvent(state, action.event);
}
