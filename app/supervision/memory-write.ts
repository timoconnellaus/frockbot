import {
  choice,
  noul,
  type JsonValue,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import type {
  MemoryWriteEvidenceV1,
  MemoryWriteVerdictV1,
} from "../memory/engine-tools.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// What a fact the Bot is about to remember is, against what it already keeps.
// Code has already refused the obvious credential shapes; Jev catches the
// secrets they miss, a fact already kept, a newer value of one, and a
// passing detail filed as lasting. Memory quality, not a gate on the Turn: a
// judgment that fails leaves the write as it was asked.

/** At or above: the fact holds a secret and is refused. */
export const MEMORY_WRITE_SECRET_YES_V1 = 0.7;

/** At or below: a profile fact will not last, so it is kept as a log entry. */
export const MEMORY_WRITE_LASTING_NO_V1 = 0.2;

/** At or above: the fact says what a kept one says, so nothing is written. */
export const MEMORY_WRITE_SAME_MIN_V1 = 0.8;

/** At or above: the fact is a newer value of a kept one, which it replaces. */
export const MEMORY_WRITE_UPDATES_MIN_V1 = 0.7;

/** The most kept facts one judgment compares against. */
export const MEMORY_WRITE_CANDIDATES_MAX_V1 = 5;

/** A write waits on this at most; past it, the fact is written as asked. */
export const MEMORY_WRITE_TIMEOUT_MS_V1 = 3_000;

const MEMORY_WRITE_TEXT_CHARS_V1 = 400;

function clip(text: string): string {
  return text.length <= MEMORY_WRITE_TEXT_CHARS_V1
    ? text
    : `${text.slice(0, MEMORY_WRITE_TEXT_CHARS_V1)}…`;
}

export function memoryWriteStateV1(
  evidence: MemoryWriteEvidenceV1,
): Record<string, JsonValue> {
  return {
    fact: clip(evidence.fact),
    tier: evidence.tier,
    kept: evidence.candidates
      .slice(0, MEMORY_WRITE_CANDIDATES_MAX_V1)
      .map((candidate) => clip(candidate.text)),
  };
}

const RELATION_LABELS_V1 = {
  unrelated: "About something else",
  adds_to:
    "About the same subject, and once `fact` is known the kept one is still true",
  same: "Says the same thing, perhaps in other words",
  updates:
    "Once `fact` is known the kept one is no longer true: where they live, what they prefer, a date or a number has changed",
} as const;

export function memoryWriteQuestionsV1(evidence: MemoryWriteEvidenceV1) {
  const kept = Math.min(
    evidence.candidates.length,
    MEMORY_WRITE_CANDIDATES_MAX_V1,
  );
  return {
    secret: noul(
      {
        target: "`fact`, which the Bot is about to remember",
        decision:
          "Does `fact` hold a secret that must never be stored: a password, passcode or PIN, an API key or token, a card, bank or account number, a recovery code or a private key?",
        requirements: [
          "The secret value itself is in `fact`, not only a mention that one exists",
        ],
      },
      {
        true: "It holds a secret value",
        false: "It holds no secret value",
      },
    ),
    ...(evidence.tier === "profile"
      ? {
          lasting: noul(
            {
              target: "`fact`",
              decision:
                "Will `fact` still be true and worth knowing about the person weeks from now?",
            },
            {
              true: "A lasting fact: a preference, a detail of their life, how they like things done",
              false:
                "A passing detail: today's plan, a one-off errand, a mood, something already done",
            },
          ),
        }
      : {}),
    ...Object.fromEntries(
      Array.from({ length: kept }, (_, index) => [
        `k${index}`,
        choice(
          {
            target: `\`fact\`, against \`kept[${index}]\` which the Bot already remembers`,
            decision: `How does \`fact\` relate to \`kept[${index}]\`?`,
            rules: ["When more than one fits, pick the one listed first."],
          },
          RELATION_LABELS_V1,
        ),
      ]),
    ),
  };
}

type Answer = {
  readonly noul?: number;
  readonly choice?: string;
  readonly probabilities?: Readonly<Record<string, number>>;
};

/** What code makes of the answers. */
export function composeMemoryWriteVerdictV1(
  evidence: MemoryWriteEvidenceV1,
  answers: Readonly<Record<string, Answer>>,
): MemoryWriteVerdictV1 {
  if ((answers.secret?.noul ?? 0) >= MEMORY_WRITE_SECRET_YES_V1) {
    return { action: "refuse-secret" };
  }
  const kept = evidence.candidates.slice(0, MEMORY_WRITE_CANDIDATES_MAX_V1);
  const relation = (label: keyof typeof RELATION_LABELS_V1) =>
    kept
      .map((candidate, index) => ({
        candidate,
        p: answers[`k${index}`]?.probabilities?.[label] ?? 0,
        chosen: answers[`k${index}`]?.choice === label,
      }))
      .filter((entry) => entry.chosen)
      .sort((a, b) => b.p - a.p)[0];
  const same = relation("same");
  if (same && same.p >= MEMORY_WRITE_SAME_MIN_V1) {
    return { action: "already-kept", id: same.candidate.id };
  }
  const updates = relation("updates");
  const tier =
    evidence.tier === "profile" &&
    (answers.lasting?.noul ?? 1) <= MEMORY_WRITE_LASTING_NO_V1
      ? "log"
      : evidence.tier;
  return {
    action: "write",
    tier,
    ...(updates && updates.p >= MEMORY_WRITE_UPDATES_MIN_V1
      ? {
          replaces: { id: updates.candidate.id, text: updates.candidate.text },
        }
      : {}),
  };
}

/** The verdict, or `undefined` when Jev could not say. */
export async function judgeMemoryWriteV1(
  client: TypeSafeClient,
  evidence: MemoryWriteEvidenceV1,
  signal?: AbortSignal,
): Promise<MemoryWriteVerdictV1 | undefined> {
  try {
    const { answers } = await client.systemOne(
      {
        state: memoryWriteStateV1(evidence),
        questions: memoryWriteQuestionsV1(evidence),
        model: RESPONSE_REVIEW_MODEL_V1,
      },
      {
        retry: { maxRetries: 0 },
        timeout: MEMORY_WRITE_TIMEOUT_MS_V1,
        ...(signal ? { signal } : {}),
      },
    );
    return composeMemoryWriteVerdictV1(
      evidence,
      answers as Readonly<Record<string, Answer>>,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
}
