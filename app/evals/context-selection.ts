import type { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  judgeMemoryRecallV1,
  MEMORY_RECALL_KEEP_MIN_V1,
} from "../supervision/memory-recall.js";
import { routineAttributionV1 } from "../routines/inbox.js";
import { createJevRoutineReportJudgeV1 } from "../supervision/routine-report.js";
import {
  nominateSkillsV1,
  type SkillCandidateV1,
} from "../supervision/skill-nomination.js";

// The labeled context-selection suite: which recalled memories a request
// keeps, and which Skills it names. Each case grades the set code would act
// on. Run with `bun run eval:context`.

export type ContextFixtureV1 =
  | {
      readonly kind: "routine";
      readonly name: string;
      readonly routine: string;
      readonly report: string;
      /** What the delivery should be. */
      readonly expected: "dismiss" | "quiet" | "loud";
    }
  | {
      readonly kind: "recall";
      readonly name: string;
      readonly request: string;
      readonly memories: readonly string[];
      /** The memories kept, by position. */
      readonly keep: readonly number[];
    }
  | {
      readonly kind: "skills";
      readonly name: string;
      readonly request: string;
      readonly skills: readonly SkillCandidateV1[];
      /** The Skills named, by `load`. */
      readonly named: readonly string[];
    };

export async function runContextCaseV1(
  client: TypeSafeClient,
  fixture: ContextFixtureV1,
): Promise<{ passed: boolean; expected: string; actual: string }> {
  if (fixture.kind === "routine") {
    // Delivery names the Routine by its wake title, so the eval does too.
    const verdict = await createJevRoutineReportJudgeV1(client)({
      routine: routineAttributionV1(fixture.routine),
      report: fixture.report,
    });
    const actual = !verdict
      ? "undecided"
      : !verdict.tell
        ? "dismiss"
        : verdict.quiet
          ? "quiet"
          : "loud";
    return {
      passed: actual === fixture.expected,
      expected: fixture.expected,
      actual: `${actual}${verdict ? ` (worth ${verdict.worth.toFixed(2)}, urgency ${verdict.urgency.toFixed(2)})` : ""}`,
    };
  }
  if (fixture.kind === "recall") {
    const scores = await judgeMemoryRecallV1(client, {
      request: fixture.request,
      candidates: fixture.memories.map((text, index) => ({
        id: String(index),
        text,
      })),
    });
    const kept = (scores ?? [])
      .flatMap((score, index) =>
        score >= MEMORY_RECALL_KEEP_MIN_V1 ? [index] : [],
      )
      .join(",");
    return {
      passed: scores !== undefined && kept === [...fixture.keep].join(","),
      expected: [...fixture.keep].join(","),
      actual: `${kept} (${(scores ?? []).map((score) => score.toFixed(2)).join(" ")})`,
    };
  }
  const named = (
    await nominateSkillsV1(client, {
      request: fixture.request,
      skills: fixture.skills,
    })
  )
    .map((skill) => skill.load)
    .sort()
    .join(",");
  const expected = [...fixture.named].sort().join(",");
  return { passed: named === expected, expected, actual: named };
}

const SKILLS: readonly SkillCandidateV1[] = [
  {
    load: "bot/emails",
    name: "My email voice",
    description:
      "How I write emails: short, warm, first names, no sign-off flourishes.",
  },
  {
    load: "bot/toasts",
    name: "Speeches and toasts",
    description: "How to write a speech or toast for a family occasion.",
  },
  {
    load: "managed/plugins",
    name: "Build a Plugin",
    description: "How to create, check and publish a FrockBot Plugin.",
  },
];

export const contextFixturesV1: readonly ContextFixtureV1[] = [
  {
    kind: "recall",
    name: "toast-keeps-the-family",
    request: "Write a toast for my sister Mia's wedding.",
    memories: [
      "Tim's sister Mia is a vet.",
      "Tim prefers aisle seats on flights.",
      "Mia is marrying Ben on 11 October.",
      "Tim's accountant is called Priya.",
    ],
    keep: [0, 2],
  },
  {
    kind: "recall",
    name: "flight-keeps-the-travel-habits",
    request: "Book me a flight to Melbourne on Friday.",
    memories: [
      "Tim prefers aisle seats on flights.",
      "Tim's sister Mia is a vet.",
      "Tim likes morning flights and never flies after 8pm.",
      "Tim's Qantas frequent flyer number is on file as QF-778.",
    ],
    keep: [0, 2, 3],
  },
  {
    kind: "skills",
    name: "an-email-names-the-email-voice",
    request: "Draft a reply to Sam about the contract.",
    skills: SKILLS,
    named: ["bot/emails"],
  },
  {
    kind: "skills",
    name: "a-sum-names-nothing",
    request: "What's 15% of 240?",
    skills: SKILLS,
    named: [],
  },
  {
    kind: "skills",
    name: "a-plugin-request-names-the-plugin-skill",
    request: "Make me a Plugin that shows my guitar practice streak.",
    skills: SKILLS,
    named: ["managed/plugins"],
  },
  {
    kind: "routine",
    name: "nothing-new-is-dismissed",
    routine: "Check my inbox for anything from the bank",
    report: "Checked your inbox. Nothing new from the bank since yesterday.",
    expected: "dismiss",
  },
  {
    kind: "routine",
    name: "a-digest-can-wait",
    routine: "Weekly reading digest",
    report:
      "This week's digest: 4 articles on e-bike batteries, 2 on cycling routes near Brisbane, and a long read on urban planning.",
    expected: "quiet",
  },
  {
    kind: "routine",
    name: "an-outage-is-loud",
    routine: "Watch my website",
    report:
      "Your website frockbot.com has returned 503 errors for the last 12 minutes; checkout is down.",
    expected: "loud",
  },
  {
    kind: "routine",
    name: "a-due-bill-today-is-told",
    routine: "Bills reminder",
    report: "Your electricity bill of $312.40 is due today.",
    expected: "loud",
  },
  {
    kind: "routine",
    name: "a-daily-status-is-told-even-when-quiet",
    routine: "Every morning, tell me how my servers are doing",
    report: "All three servers were healthy overnight; no alerts.",
    expected: "quiet",
  },
];
