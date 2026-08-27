import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  isAgentCommand,
  type AgentCommand,
  type AgentEvent,
} from "@frockbot/protocol";

interface UtilityParentPort {
  postMessage(message: AgentEvent): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

interface UtilityProcess extends NodeJS.Process {
  parentPort?: UtilityParentPort;
}

const utilityParentPort = (process as UtilityProcess).parentPort;
if (!utilityParentPort) {
  throw new Error(
    "FrockBot agent worker requires an Electron utility-process parent",
  );
}
const parentPort: UtilityParentPort = utilityParentPort;

let session: AgentSession | undefined;
let activeRunId: string | undefined;
const abortedRuns = new Set<string>();

function post(event: AgentEvent): void {
  parentPort.postMessage(event);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]");
}

function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result))
    return "Tool finished";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "Tool finished";
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ((part as { type?: unknown }).type !== "text") return "";
      const value = (part as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!text) return "Tool finished";
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

async function initialize(): Promise<void> {
  try {
    const cwd = process.env.FROCKBOT_WORKSPACE ?? process.cwd();
    const modelRuntime = await ModelRuntime.create();
    const created = await createAgentSession({
      cwd,
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
    });
    session = created.session;
    session.subscribe((event) => {
      const runId = activeRunId;
      if (!runId) return;
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const text = event.assistantMessageEvent.delta;
        if (text) post({ type: "text-delta", runId, text });
      }
      if (event.type === "tool_execution_start") {
        post({
          type: "tool-start",
          runId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: event.args,
        });
      }
      if (event.type === "tool_execution_end") {
        post({
          type: "tool-end",
          runId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          text: summarizeToolResult(event.result),
          isError: event.isError,
        });
      }
    });
    post({
      type: "worker-ready",
      model: session.model
        ? { provider: session.model.provider, id: session.model.id }
        : undefined,
    });
  } catch (error) {
    post({ type: "error", phase: "startup", message: errorMessage(error) });
  }
}

async function runPrompt(
  command: Extract<AgentCommand, { type: "prompt" }>,
): Promise<void> {
  if (!session) {
    post({
      type: "error",
      runId: command.runId,
      phase: "run",
      message: "Pi is not ready",
    });
    return;
  }
  if (activeRunId) {
    post({
      type: "error",
      runId: command.runId,
      phase: "run",
      message: "Another turn is active",
    });
    return;
  }

  activeRunId = command.runId;
  post({ type: "run-started", runId: command.runId });
  try {
    await session.prompt(command.text);
    post({
      type: "settled",
      runId: command.runId,
      reason: abortedRuns.has(command.runId) ? "aborted" : "completed",
    });
  } catch (error) {
    post({
      type: "error",
      runId: command.runId,
      phase: "run",
      message: errorMessage(error),
    });
  } finally {
    abortedRuns.delete(command.runId);
    activeRunId = undefined;
  }
}

async function abortRun(runId: string): Promise<void> {
  if (!session || activeRunId !== runId) return;
  abortedRuns.add(runId);
  await session.abort();
}

async function shutdown(): Promise<void> {
  if (session?.isStreaming) await session.abort();
  session?.dispose();
  process.exit(0);
}

parentPort.on("message", (event) => {
  if (!isAgentCommand(event.data)) return;
  const command = event.data;
  if (command.type === "prompt") void runPrompt(command);
  if (command.type === "abort") void abortRun(command.runId);
  if (command.type === "shutdown") void shutdown();
});

process.once("SIGTERM", () => void shutdown());
void initialize();
