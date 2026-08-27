import { app, utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import {
  isAgentEvent,
  type AgentCommand,
  type AgentEvent,
  type PromptRequest,
  type PromptResponse,
} from "@frockbot/protocol";

export class AgentProcess {
  #child: UtilityProcess | undefined;
  #generation = 0;
  #ready = false;
  #activeRunId: string | undefined;

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  start(): void {
    const generation = ++this.#generation;
    this.#ready = false;
    this.#activeRunId = undefined;

    try {
      const child = utilityProcess.fork(this.#workerPath(), [], {
        env: { ...process.env },
        serviceName: "FrockBot Pi agent",
      });
      this.#child = child;
      child.on("message", (message) => {
        if (generation !== this.#generation || !isAgentEvent(message)) return;
        this.#handleEvent(message);
      });
      child.on("exit", (code) => {
        if (generation !== this.#generation) return;
        this.#child = undefined;
        this.#ready = false;
        this.#activeRunId = undefined;
        this.emit({ type: "worker-exit", code });
      });
    } catch (error) {
      this.#child = undefined;
      this.emit({
        type: "error",
        phase: "startup",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  prompt(request: PromptRequest): PromptResponse {
    if (!this.#child || !this.#ready) {
      return { accepted: false, error: "Pi is still starting" };
    }
    if (this.#activeRunId) {
      return { accepted: false, error: "Another turn is already running" };
    }
    this.#activeRunId = request.runId;
    this.#post({ type: "prompt", ...request });
    return { accepted: true };
  }

  abort(runId: string): void {
    if (this.#activeRunId !== runId) return;
    this.#post({ type: "abort", runId });
  }

  restart(): void {
    this.#replaceChild();
    this.start();
  }

  dispose(): void {
    const child = this.#child;
    this.#generation += 1;
    this.#child = undefined;
    this.#ready = false;
    this.#activeRunId = undefined;
    if (!child) return;
    try {
      child.postMessage({ type: "shutdown" } satisfies AgentCommand);
    } finally {
      setTimeout(() => child.kill(), 500).unref();
    }
  }

  #replaceChild(): void {
    const child = this.#child;
    this.#generation += 1;
    this.#child = undefined;
    this.#ready = false;
    this.#activeRunId = undefined;
    child?.kill();
  }

  #post(command: AgentCommand): void {
    try {
      this.#child?.postMessage(command);
    } catch (error) {
      this.emit({
        type: "error",
        runId: "runId" in command ? command.runId : undefined,
        phase: "run",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleEvent(event: AgentEvent): void {
    if (event.type === "worker-ready") this.#ready = true;
    if (event.type === "settled" && event.runId === this.#activeRunId) {
      this.#activeRunId = undefined;
    }
    if (event.type === "error" && event.runId === this.#activeRunId) {
      this.#activeRunId = undefined;
    }
    this.emit(event);
  }

  #workerPath(): string {
    if (app.isPackaged)
      return join(process.resourcesPath, "agent-worker", "index.js");
    return join(app.getAppPath(), "resources", "agent-worker", "index.js");
  }
}
