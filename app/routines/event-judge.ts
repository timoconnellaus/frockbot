// Classify a connected-app firing once, before the conversational model.
//
// Schedule, webhook, and Plugin firings never ask: a clock has no payload,
// and those doors already have a drop of their own. Connection firings ask
// once per fire id. The receipt is what makes a replay after eviction cheap
// rather than a second paid question.
//
// Cut 2 records the verdict and still admits the Turn. Cut 4 is what skips.

import type {
  RoutineEventEvidenceV1,
  RoutineEventJudgeV1,
  RoutineEventPayloadV1,
  RoutineEventVerdictV1,
} from "@frockbot/core/contracts";
import type { RoutineFireV1 } from "./firing.js";
import type { RoutineRecordV1 } from "./records.js";
import { RoutineDecodeError, routineExactKeys, routineText } from "./records.js";
import { routineEventJudgeKeyV1 } from "./storage-keys.js";

const PAYLOAD_SNIPPET_MAX = 512;
const LABEL_MAX = 16;
const LABEL_LENGTH_MAX = 64;

export interface RoutineEventJudgeReceiptV1 {
  schemaVersion: 1;
  fireId: string;
  eventId: string;
  verdict: RoutineEventVerdictV1;
  classifiedAt: string;
}

const VERDICTS = new Set<RoutineEventVerdictV1>([
  "clearly_unrelated",
  "is_or_might_be",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeRoutineEventJudgeReceiptV1(
  value: unknown,
): RoutineEventJudgeReceiptV1 | undefined {
  if (value === undefined) return undefined;
  const candidate = record(value, "Routine event-judge receipt");
  routineExactKeys(
    candidate,
    ["schemaVersion", "fireId", "eventId", "verdict", "classifiedAt"],
    [],
    "Routine event-judge receipt",
  );
  if (candidate.schemaVersion !== 1) {
    throw new RoutineDecodeError(
      "Routine event-judge receipt schemaVersion is unsupported",
    );
  }
  if (
    typeof candidate.verdict !== "string" ||
    !VERDICTS.has(candidate.verdict as RoutineEventVerdictV1)
  ) {
    throw new RoutineDecodeError("Routine event-judge receipt verdict is invalid");
  }
  return {
    schemaVersion: 1,
    fireId: routineText(candidate.fireId, 256, "Routine event-judge fireId"),
    eventId: routineText(candidate.eventId, 256, "Routine event-judge eventId"),
    verdict: candidate.verdict as RoutineEventVerdictV1,
    classifiedAt: routineText(
      candidate.classifiedAt,
      40,
      "Routine event-judge classifiedAt",
    ),
  };
}

/**
 * The event id the fire id already carries. A connection discriminator is
 * `connect-<eventId>`; the fire id is `rf-<routineId>-` plus that, sanitized.
 */
export function connectionEventIdFromFireV1(fire: RoutineFireV1): string {
  const marker = "-connect-";
  const at = fire.fireId.indexOf(marker);
  return at === -1 ? fire.fireId : fire.fireId.slice(at + marker.length);
}

function textField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, PAYLOAD_SNIPPET_MAX);
}

function labelsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(0, LABEL_LENGTH_MAX))
    .slice(0, LABEL_MAX);
  return labels.length === 0 ? undefined : labels;
}

function pickFrom(row: Record<string, unknown>): RoutineEventPayloadV1 {
  const subject = textField(row.subject ?? row.Subject);
  const sender = textField(
    row.sender ?? row.from ?? row.From ?? row.message_from,
  );
  const to = textField(row.to ?? row.To);
  const snippet = textField(
    row.snippet ??
      row.message_text ??
      row.text ??
      row.body ??
      row.preview,
  );
  const labels = labelsOf(row.labels ?? row.labelIds ?? row.label_ids);
  return {
    ...(subject === undefined ? {} : { subject }),
    ...(sender === undefined ? {} : { sender }),
    ...(to === undefined ? {} : { to }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(labels === undefined ? {} : { labels }),
  };
}

/** Project the cue's delivered body. Strip the raw Gmail `payload` object. */
export function projectRoutineEventPayloadV1(cue: string): RoutineEventPayloadV1 {
  const marker = "Delivered payload:";
  const at = cue.indexOf(marker);
  if (at === -1) return {};
  const raw = cue.slice(at + marker.length).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { snippet: raw.slice(0, PAYLOAD_SNIPPET_MAX) };
    }
    return pickFrom(parsed as Record<string, unknown>);
  } catch {
    return raw.length === 0 ? {} : { snippet: raw.slice(0, PAYLOAD_SNIPPET_MAX) };
  }
}

export function routineEventEvidenceV1(input: {
  fire: RoutineFireV1;
  routine?: RoutineRecordV1;
}): RoutineEventEvidenceV1 | undefined {
  if (input.fire.trigger !== "connection") return undefined;
  const triggerType =
    input.routine?.trigger?.kind === "connection"
      ? input.routine.trigger.triggerType
      : "connection";
  return {
    eventId: connectionEventIdFromFireV1(input.fire),
    fireId: input.fire.fireId,
    routineName: input.routine?.name ?? input.fire.routineId,
    prompt: input.routine?.prompt ?? "",
    triggerType,
    payload: projectRoutineEventPayloadV1(input.fire.cue),
  };
}

export async function classifyRoutineFireOnceV1(input: {
  fire: RoutineFireV1;
  routine?: RoutineRecordV1;
  judge: RoutineEventJudgeV1;
  read: (key: string) => Promise<unknown>;
  write: (key: string, value: RoutineEventJudgeReceiptV1) => Promise<void>;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<RoutineEventVerdictV1 | undefined> {
  const evidence = routineEventEvidenceV1(input);
  if (evidence === undefined) return undefined;
  const key = routineEventJudgeKeyV1(input.fire.fireId);
  const prior = decodeRoutineEventJudgeReceiptV1(await input.read(key));
  if (prior) return prior.verdict;
  const verdict = await input.judge.classify(evidence, input.signal);
  await input.write(key, {
    schemaVersion: 1,
    fireId: input.fire.fireId,
    eventId: evidence.eventId,
    verdict,
    classifiedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  return verdict;
}
