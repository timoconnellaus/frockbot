import type {
  ModelBindingSnapshot,
  LoopAgentInputV1,
  LoopAgentRuntimeV1,
  LoopRequestErrorDecisionV1,
  Session,
  SkillRefV1,
  TurnTypeV1,
} from "@frockbot/core/contracts";

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

export type RequestErrorAction = LoopRequestErrorDecisionV1;

export interface Agent extends LoopAgentRuntimeV1 {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  readonly status: AgentStatus;
  send(input: string | AgentSendV1): string;
  resume(): void;
  cancel(reason?: "user" | "shutdown", detail?: string): void;
  whenIdle(): Promise<void>;
}

export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface AgentFactory {
  create(options: AgentOptions): Promise<AgentHandle>;
}
