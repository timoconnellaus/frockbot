import type { PersistSessionEvents, SessionEvent } from "@frockbot/agent-core";
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
  resume?: boolean;
}

/** The Bot host's sole resident Agent-runtime seam. */
export interface BotResidentExecution {
  project(projection: BotResidentProjection): Promise<void>;
  execute(execution: BotResidentTurnExecution): Promise<BotTurnCompletion>;
  generation(): number | undefined;
}
