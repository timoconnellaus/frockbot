import { type Context, Service } from "cordis";
import type {
  ModelBindingSnapshot,
  LoopAgentInputV1,
  LoopAgentRuntimeV1,
  NormalizedModelRequest,
  Session,
  SkillRefV1,
  TurnTypeV1,
} from "@frockbot/kernel-contracts";

export type AgentStatus = "idle" | "running" | "disposed";

/** One exact new external effect whose durable intent is already journaled. */
export type AgentEffectAdmission =
  { kind: "model"; effectId: string } | { kind: "tool"; effectId: string };

export interface AgentOptions {
  botId: string;
  agentId?: string;
  sessionId: string;
  provider: string;
  model: string;
  /**
   * The kind of Turn this Agent's runs are admitted as. It selects the tool
   * catalog and nothing else; the kernel carries the value and holds no
   * opinion about what any turn type admits. Defaults to `chat`, which is what
   * every Turn recorded before turn admission existed replays as.
   */
  turnType?: TurnTypeV1;
  /**
   * The subagent role this Agent's runs are admitted under. A second ceiling
   * dimension on the same terms as `turnType`: it selects the tool catalog and
   * nothing else, and the kernel holds no opinion about what a role name
   * means. Only meaningful on a `subagent` Turn; absent means no narrowing.
   */
  subagentRole?: string;
  /** Durably linearizes each new effect against Stop immediately before use. */
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  modelBinding?: ModelBindingSnapshot;
}

export interface AgentInput extends LoopAgentInputV1 {
  messageId: string;
  text: string;
  /**
   * The Skills this input invoked from the composer. The kernel carries the
   * refs and resolves nothing: which Skill a ref names, and what happens to
   * its body, is the Skills Package's policy, read off this field in
   * `agent/pre-step`.
   */
  skills?: SkillRefV1[];
}

/** What `Agent.send` accepts: bare text, or text with invoked Skills. */
export interface AgentSendV1 {
  text: string;
  skills?: readonly SkillRefV1[];
}

export type PreStepDecision =
  { kind: "enter"; inputs: AgentInput[] } | { kind: "reject"; reason: string };

export type RequestErrorAction = { kind: "retry" } | { kind: "fail" };

export interface Agent extends LoopAgentRuntimeV1 {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  readonly status: AgentStatus;
  send(input: string | AgentSendV1): string;
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
    "agent/model-outcome-committed": (
      agent: Agent,
      requestId: string,
      outcome: "completed" | "not-started",
    ) => Promise<void>;
    "agent/turn-stopping": (agent: Agent, turn: number) => Promise<void>;
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
