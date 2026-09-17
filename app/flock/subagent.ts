// `subagent`: the Bot handing work off to itself so it can answer now.
//
// ADR 0031 decided this for voice — "the model decides what is long" — and
// listed the same tool in text Turns as the next step. Nothing classifies a
// task here: the model calls this when it thinks the work will take more than
// a moment, exactly as it would in a call.
//
// WHAT IT ADMITS. One ordinary Turn on *this* Bot's `agent` lane, through the
// path `bot_message` uses pointed at the Bot that called it. That lane is the
// point: the hand-off queues behind whatever the person or a Routine has
// running and never supersedes it, and it carries this Bot's own tools and
// Session. There is no result channel and nothing waits — what the hand-off
// has to say, it says with `send_to_user`, in the thread, in the Bot's own
// words like any other Turn.
//
// TWO FENCES ON DEPTH. The manifest offers the Capability on `chat` alone, so
// the `agent` Turn a hand-off runs as is never handed the tool. The depth on
// the admitted Turn's origin is the second fence, read back off the durable
// record: it survives eviction, and it is what refuses a second level if that
// ceiling is ever widened.
import { packageAdmissionCeilingV1 } from "@frockbot/core/contracts";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import { flockDefinitionV1 } from "./definition.js";

export const SUBAGENT_TOOL_V1 = "subagent";
/** The manifest Capability the tool is contributed under. */
export const SUBAGENT_HANDOFF_CAPABILITY_V1 = "subagent-handoff";

/** The longest task one hand-off may carry. */
export const SUBAGENT_TASK_MAX_V1 = 2_000;

/**
 * How many hand-offs one Turn may make.
 *
 * A guardrail against a fan-out, not an authority: it is counted in the
 * Contribution, which is built once per admitted Turn, so a Turn recovered
 * after eviction starts counting again. The durable bounds are the lane, which
 * runs hand-offs one at a time, and the depth on the origin.
 */
export const SUBAGENT_SPAWNS_PER_TURN_V1 = 4;

/** What one admitted hand-off is, to the Turn that asked for it. */
export interface SubagentSpawnOutcomeV1 {
  runId: string;
  status: "started" | "already-started";
}

/**
 * The host seam one admitted Turn's hand-offs run through. The Bot Durable
 * Object supplies it; this Package holds no authority and decides nothing
 * durable — the run id, the origin and the admission are all behind `spawn`.
 */
export interface SubagentHandoffHostV1 {
  /**
   * How many hand-offs deep the Turn calling the tool already is. Zero for a
   * Turn a person or a Routine started.
   */
  handoffDepth: number;
  spawn(request: {
    task: string;
    effectId: string;
  }): Promise<SubagentSpawnOutcomeV1>;
}

const SUBAGENT_SCHEMA = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "The complete task, written for someone with none of this conversation in front of them. Say what to do and what to tell the person when it is done.",
    },
  },
  required: ["task"],
  additionalProperties: false,
} as const;

export interface SubagentInputV1 {
  task: string;
}

export function decodeSubagentInputV1(input: unknown): SubagentInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (!Object.keys(value).every((key) => key === "task")) {
    throw new Error("input has unknown fields");
  }
  if (typeof value.task !== "string") throw new Error("task must be a string");
  const task = value.task.trim();
  if (!task) throw new Error("task must not be empty");
  if (task.length > SUBAGENT_TASK_MAX_V1) throw new Error("task is too long");
  return { task };
}

function subagentAdmissionCeilingV1(
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  return packageAdmissionCeilingV1(flockDefinitionV1, capabilityId);
}

/** The manifest's own ceiling on the Capability, read back out of it. */
export function subagentHandoffAdmissionCeilingV1():
  readonly TurnTypeV1[] | undefined {
  return subagentAdmissionCeilingV1(SUBAGENT_HANDOFF_CAPABILITY_V1);
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

export function createSubagentTool(
  host: SubagentHandoffHostV1,
): ToolDefinition {
  // Per Turn, because the Contribution this closes over is built per Turn.
  let spawned = 0;
  return {
    name: SUBAGENT_TOOL_V1,
    namespace: "frockbot",
    description:
      "Hand off anything that will take more than a moment, then reply now. The work continues on its own and reports to the person when done.",
    inputSchema: SUBAGENT_SCHEMA as unknown as Record<string, unknown>,
    // The run id is derived from the tool-call occurrence behind the seam, so
    // a replay after eviction asks for the Turn it already admitted and is
    // told it is already running rather than starting a second one.
    idempotent: true,
    validate: (input) => {
      try {
        decodeSubagentInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: SubagentInputV1;
      try {
        decoded = decodeSubagentInputV1(input);
      } catch (error) {
        return refusal(
          `subagent was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (host.handoffDepth >= 1) {
        return refusal(
          "subagent was refused: you are already a hand-off, and a hand-off cannot hand off again. Do this work yourself.",
        );
      }
      if (spawned >= SUBAGENT_SPAWNS_PER_TURN_V1) {
        return refusal(
          `subagent was refused: you have already handed off ${SUBAGENT_SPAWNS_PER_TURN_V1} times this turn, which is the limit. Do the rest yourself or ask the person what matters most.`,
        );
      }
      let outcome: SubagentSpawnOutcomeV1;
      try {
        outcome = await host.spawn({
          task: decoded.task,
          effectId: context.effectId,
        });
      } catch (error) {
        return refusal(
          `subagent failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      spawned += 1;
      // The shape the model reads: the work is running and it is free to
      // answer now. There is no result to wait for — the hand-off speaks for
      // itself in this conversation when it is done.
      return {
        content: JSON.stringify({ runId: outcome.runId, status: "started" }),
        isError: false,
      };
    },
  };
}
