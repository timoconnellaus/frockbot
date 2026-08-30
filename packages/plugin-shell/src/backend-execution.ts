import type {
  AgentEffectAdmission,
  PersistSessionEvents,
  SessionEvent,
} from "@frockbot/agent-core";
import type {
  BotExecutionPlanV1,
  BotSettingsViewV1,
  ConnectionView,
} from "@frockbot/configuration-core";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";

export interface BotResidentProjection {
  generation: number;
  userId: string;
  botId: string;
  settings: BotSettingsViewV1;
  executionPlan: BotExecutionPlanV1;
  memory: MemoryPluginConfig;
  systemPromptSection: string;
  authorizeConnection(
    assignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView>;
}

export interface BotResidentTurnExecution {
  botId: string;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  /**
   * Runs after the exact resident handle is addressable but before Agent input
   * or recovery is activated. False means durable state fenced execution.
   */
  beforeStart(): Promise<boolean>;
  /** Serializes each new provider/tool effect against durable Stop intent. */
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  resume?: boolean;
}

/** Narrow cancellation request bound to one exact resident run. */
export interface BotResidentCancellation {
  botId: string;
  sessionId: string;
  runId: string;
  reason: "user";
}

/** The Bot host's sole resident Agent-runtime seam. */
export interface BotResidentExecution {
  project(projection: BotResidentProjection): Promise<void>;
  execute(execution: BotResidentTurnExecution): Promise<BotTurnCompletion>;
  /** Signals the resident Agent; true only when that exact run was signalled. */
  cancel(cancellation: BotResidentCancellation): Promise<boolean>;
  generation(): number | undefined;
}
