import type {
  CallReviewEvidenceV1,
  SessionEvent,
  StepProposalEvidence,
  ToolCall,
} from "@frockbot/core/contracts";
import type { StoredRunOriginV1 } from "@frockbot/core/durable";
import { resolveDynamicToolNameV1 } from "../audit/classify.js";
import {
  callReviewEvidenceOfV1,
  stepReviewEvidenceOfV1,
  turnInputOriginV1,
} from "../supervision/loop.js";

// Candidate eval cases from a recorded run: every call review and step review
// the run made, with the evidence rebuilt from its journal by the functions
// production used, and the decision production recorded. A candidate is not a
// case until a person labels it; the harvest only saves looking it up.

/** One run as `debug.sh run` prints it. */
export interface HarvestRunV1 {
  readonly runId: string;
  readonly input: string;
  readonly commandFingerprint?: string;
  readonly events: readonly SessionEvent[];
  readonly omittedEvents?: number;
}

export interface HarvestedCallV1 {
  readonly kind: "call";
  readonly runId: string;
  readonly occurrenceId: string;
  readonly turn: number;
  readonly step: number;
  readonly recorded: unknown;
  /** Absent when the journal holds no call for the id, as for egress reviews. */
  readonly evidence?: CallReviewEvidenceV1;
  readonly tool: string;
}

export interface HarvestedStepV1 {
  readonly kind: "step";
  readonly runId: string;
  readonly turn: number;
  readonly step: number;
  readonly recorded: unknown;
  readonly evidence: StepProposalEvidence;
}

export type HarvestedCaseV1 = HarvestedCallV1 | HarvestedStepV1;

/** The origin the run was admitted with, read from its command fingerprint. */
export function harvestOriginV1(
  run: HarvestRunV1,
): StoredRunOriginV1 | undefined {
  const fingerprint = run.commandFingerprint ?? "";
  const json = fingerprint.slice(fingerprint.indexOf("{"));
  try {
    const command = JSON.parse(json) as { origin?: StoredRunOriginV1 };
    return command.origin;
  } catch {
    return undefined;
  }
}

/**
 * The run's events, with its input restored as the Turn's first user message
 * when the debug snapshot trimmed it: a long run keeps only its tail, and every
 * check reads the Turn's input.
 */
function journalOf(run: HarvestRunV1): SessionEvent[] {
  const events = [...run.events];
  const turn = events.find((event) => "turn" in event)?.turn;
  if (turn === undefined) return events;
  const hasInput = events.some(
    (event) => event.type === "user/message" && event.turn === turn,
  );
  if (hasInput) return events;
  return [
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: "harvest-restored-input",
      text: run.input,
    } as SessionEvent,
    ...events,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The arguments review saw: a dynamic call's inner arguments, else its input. */
function reviewedArguments(name: string, input: unknown) {
  if (
    isRecord(input) &&
    isRecord(input.arguments) &&
    name === "call_dynamic_tool"
  )
    return input.arguments;
  return isRecord(input) ? input : {};
}

export function harvestRunV1(run: HarvestRunV1): HarvestedCaseV1[] {
  const journal = journalOf(run);
  const origin = turnInputOriginV1(harvestOriginV1(run));
  const cases: HarvestedCaseV1[] = [];
  journal.forEach((event, index) => {
    const before = journal.slice(0, index);
    if (event.type === "supervision/call") {
      const call = journal.find(
        (candidate) =>
          candidate.type === "tool/call" &&
          candidate.occurrenceId === event.occurrenceId,
      ) as Extract<SessionEvent, { type: "tool/call" }> | undefined;
      cases.push({
        kind: "call",
        runId: run.runId,
        occurrenceId: event.occurrenceId,
        turn: event.turn,
        step: event.step,
        tool: event.tool,
        recorded: event.decision,
        ...(call
          ? {
              evidence: callReviewEvidenceOfV1(before, event.turn, origin, {
                tool: resolveDynamicToolNameV1(call.name, call.input),
                arguments: reviewedArguments(call.name, call.input),
              }),
            }
          : {}),
      });
    }
    if (event.type === "supervision/step") {
      const response = before.findLast(
        (candidate) =>
          candidate.type === "assistant/message" &&
          candidate.turn === event.turn &&
          candidate.step === event.step,
      ) as Extract<SessionEvent, { type: "assistant/message" }> | undefined;
      if (!response) return;
      const upTo = journal.slice(0, journal.indexOf(response) + 1);
      cases.push({
        kind: "step",
        runId: run.runId,
        turn: event.turn,
        step: event.step,
        recorded: event.decision,
        evidence: stepReviewEvidenceOfV1(
          upTo,
          event.turn,
          origin,
          response.toolCalls as readonly ToolCall[],
          [],
        ),
      });
    }
  });
  return cases;
}
