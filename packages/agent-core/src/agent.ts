import { type Context, Service } from "cordis";
import type { Session } from "./session.js";
import type { NormalizedModelRequest } from "./types.js";

export type AgentStatus = "idle" | "running" | "disposed";

export interface AgentOptions {
  botId: string;
  agentId?: string;
  sessionId: string;
  provider: string;
  model: string;
}

export interface AgentInput {
  messageId: string;
  text: string;
}

export type PreStepDecision =
  { kind: "enter"; inputs: AgentInput[] } | { kind: "reject"; reason: string };

export type RequestErrorAction = { kind: "retry" } | { kind: "fail" };

export interface Agent {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  readonly status: AgentStatus;
  send(text: string): string;
  resume(): void;
  cancel(reason?: "user" | "shutdown"): void;
  whenIdle(): Promise<void>;
}

export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface AgentFactory {
  create(options: AgentOptions): Promise<AgentHandle>;
}

declare module "cordis" {
  interface Context {
    agents: AgentRegistry;
  }

  interface Events {
    "agent/created": (agent: Agent) => void;
    "agent/disposed": (agent: Agent) => void;
    "agent/status": (agent: Agent, status: AgentStatus) => void;
    "agent/inbox/inserted": (agent: Agent, input: AgentInput) => void;
    "agent/inbox/claimed": (
      agent: Agent,
      inputs: AgentInput[],
      turn: number,
    ) => void;
    "agent/pre-step": (
      agent: Agent,
      inputs: AgentInput[],
      turn: number,
      step: number,
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>;
    "agent/request": (
      agent: Agent,
      request: NormalizedModelRequest,
      signal: AbortSignal,
      next: () => Promise<NormalizedModelRequest>,
    ) => Promise<NormalizedModelRequest>;
    "agent/request-error": (
      agent: Agent,
      error: unknown,
      signal: AbortSignal,
      next: () => Promise<RequestErrorAction>,
    ) => Promise<RequestErrorAction>;
    "agent/turn-stopping": (agent: Agent, turn: number) => Promise<void>;
    "agent/cancel-requested": (
      agent: Agent,
      reason: "user" | "shutdown",
    ) => void;
    "agent/error": (agent: Agent, error: unknown) => void;
  }
}

export class AgentRegistry extends Service {
  private agents = new Map<string, Agent>();
  private factory: AgentFactory | undefined;

  constructor(ctx: Context) {
    super(ctx, "agents");
  }

  setFactory(factory: AgentFactory): () => void {
    if (this.factory) throw new Error("an agent factory is already registered");
    this.factory = factory;
    return () => {
      if (this.factory === factory) this.factory = undefined;
    };
  }

  create(options: AgentOptions): Promise<AgentHandle> {
    if (!this.factory) throw new Error("no agent factory is registered");
    return this.factory.create(options);
  }

  register(agent: Agent): () => void {
    if (this.agents.has(agent.id))
      throw new Error(`agent "${agent.id}" already exists`);
    this.agents.set(agent.id, agent);
    this.ctx.emit("agent/created", agent);
    return () => {
      if (this.agents.get(agent.id) !== agent) return;
      this.agents.delete(agent.id);
      this.ctx.emit("agent/disposed", agent);
    };
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }
}
