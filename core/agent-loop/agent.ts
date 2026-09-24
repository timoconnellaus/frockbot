import type {
  ModelBindingSnapshot,
  LoopAgentInputV1,
  LoopAgentRuntimeV1,
  LoopRequestErrorDecisionV1,
  MessageAttachmentV1,
  Session,
  SessionEvent,
  SkillRefV1,
  TurnTypeV1,
} from "@frockbot/core/contracts";

export type AgentStatus = "idle" | "running" | "disposed";

/** One exact new external effect whose durable intent is already journaled. */
export type AgentEffectAdmission =
  { kind: "model"; effectId: string } | { kind: "tool"; effectId: string };

/** One dispatch of a model request, as a tool-input watcher is shown it. */
export interface ToolInputDispatchV1 {
  requestId: string;
  turn: number;
  step: number;
  /** What the active run had logged when the dispatch began. */
  journal: readonly SessionEvent[];
}

/** What watches one dispatch's tool calls being written. */
export interface ToolInputWatchV1 {
  /** One fragment of call `id`'s JSON arguments, in the order written. */
  delta(call: { id: string; name: string }, fragment: string): void;
  /** The dispatch is over, whatever became of it. Called once. */
  end(): void;
}

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
  /**
   * How many further effects this run's durable record can still admit.
   *
   * Only a caller that plans several admissions at once needs it: a `batch`
   * asks before it expands, so a batch that cannot fit is refused as a tool
   * error the model can act on rather than throwing out of the admission that
   * would have overflowed the record. Absent ⇒ the host keeps no such record
   * and admits without bound.
   */
  remainingEffectAdmissions?(): Promise<number>;
  /**
   * Whether a person's message is waiting for this Turn. Asked at each step
   * boundary that would otherwise continue: when it answers true the Turn ends
   * there, completed, and the message runs next with everything this Turn did
   * already in its context. Nothing in flight is cut off or sent again.
   * Absent ⇒ the Turn never yields.
   */
  userMessageWaiting?(): Promise<boolean>;
  /**
   * A window onto the model writing its tool calls, one dispatch at a time.
   *
   * Nothing it is shown is journaled, and nothing it does reaches the loop:
   * the durable log and every model request are exactly what they would be
   * without it, and a Turn resumed after eviction shows it nothing until its
   * next dispatch. A watcher that throws is ignored. Absent ⇒ the fragments go
   * nowhere.
   */
  watchToolInput?(dispatch: ToolInputDispatchV1): ToolInputWatchV1 | undefined;
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

/** What `Agent.send` accepts: bare text, or text with Skills and files. */
export interface AgentSendV1 {
  text: string;
  skills?: readonly SkillRefV1[];
  /**
   * The files the person attached, as references. A message may be files
   * alone, so `text` may be empty when these are present.
   */
  attachments?: readonly MessageAttachmentV1[];
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
