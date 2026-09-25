import { noul, type JsonValue, type TypeSafeClient } from "@typesafe-ai/sdk";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// Which recalled memories bear on what the person asked now. Recall finds
// candidates by words, meaning and time; Jev judges each against the request,
// and Memory keeps and orders them by that judgment. Context quality, not
// safety: a judgment that fails leaves recall as it found it.

/** The most candidates one judgment reads; the rest keep their recall order. */
export const MEMORY_RECALL_JUDGED_MAX_V1 = 12;

/** Below this, a memory is judged no help and left out of the Turn. */
export const MEMORY_RECALL_KEEP_MIN_V1 = 0.2;

/** A judgment that takes longer than this costs the Turn more than it gives. */
export const MEMORY_RECALL_TIMEOUT_MS_V1 = 3_000;

const MEMORY_RECALL_TEXT_CHARS_V1 = 400;

export interface MemoryRecallCandidateV1 {
  readonly id: string;
  readonly text: string;
}

function clip(text: string): string {
  return text.length <= MEMORY_RECALL_TEXT_CHARS_V1
    ? text
    : `${text.slice(0, MEMORY_RECALL_TEXT_CHARS_V1)}…`;
}

export function memoryRecallStateV1(input: {
  request: string;
  candidates: readonly MemoryRecallCandidateV1[];
}): Record<string, JsonValue> {
  return {
    request: clip(input.request),
    candidates: input.candidates.map((candidate) => clip(candidate.text)),
  };
}

/** One Noul per candidate, keyed by its position. */
export function memoryRecallQuestionsV1(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `m${index}`,
      noul(
        {
          target: `\`candidates[${index}]\`, something the Bot remembers`,
          decision:
            "Does it help the Bot answer or act on `request` now — a fact, preference or earlier event the reply should take into account?",
        },
        {
          true: "It bears on this request",
          false: "It is about something else, or adds nothing to this request",
        },
      ),
    ]),
  );
}

/**
 * How much each candidate bears on the request, in order, or `undefined`
 * when Jev could not say — recall then keeps its own order.
 */
export async function judgeMemoryRecallV1(
  client: TypeSafeClient,
  input: {
    request: string;
    candidates: readonly MemoryRecallCandidateV1[];
    signal?: AbortSignal;
  },
): Promise<number[] | undefined> {
  const judged = input.candidates.slice(0, MEMORY_RECALL_JUDGED_MAX_V1);
  if (judged.length === 0) return [];
  try {
    const { answers } = await client.systemOne(
      {
        state: memoryRecallStateV1({
          request: input.request,
          candidates: judged,
        }),
        questions: memoryRecallQuestionsV1(judged.length),
        model: RESPONSE_REVIEW_MODEL_V1,
      },
      {
        retry: { maxRetries: 0 },
        timeout: MEMORY_RECALL_TIMEOUT_MS_V1,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const scores = judged.map((_, index) => {
      const answer = (answers as Record<string, { noul?: unknown }>)[
        `m${index}`
      ];
      return typeof answer?.noul === "number" ? answer.noul : undefined;
    });
    return scores.every((score) => score !== undefined)
      ? (scores as number[])
      : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
}

/**
 * The candidates to keep, most relevant first. Judged ones below the keep
 * line go; ones past the judged window follow in recall order.
 */
export function rankRecalledV1<T>(
  hits: readonly T[],
  scores: readonly number[] | undefined,
): T[] {
  if (!scores) return [...hits];
  const judged = hits
    .slice(0, scores.length)
    .map((hit, index) => ({ hit, score: scores[index] ?? 0, index }))
    .filter((entry) => entry.score >= MEMORY_RECALL_KEEP_MIN_V1)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.hit);
  return [...judged, ...hits.slice(scores.length)];
}
