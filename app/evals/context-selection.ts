import type { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  judgeMemoryRecallV1,
  MEMORY_RECALL_KEEP_MIN_V1,
} from "../supervision/memory-recall.js";
import { routineAttributionV1 } from "../routines/inbox.js";
import { createJevPageJudgeV1 } from "../supervision/page-state.js";
import { judgeMemoryWriteV1 } from "../supervision/memory-write.js";
import { createJevEmailTriageJudgeV1 } from "../supervision/email-triage.js";
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
      readonly kind: "write";
      readonly name: string;
      readonly fact: string;
      readonly tier: "profile" | "log" | "note";
      readonly kept: readonly string[];
      /** What the write should become: refused, not written, replacing kept[n], or written at a tier. */
      readonly expected:
        | "refuse-secret"
        | "already-kept"
        | `replaces:${number}`
        | `write:${"profile" | "log" | "note"}`;
    }
  | {
      readonly kind: "email";
      readonly name: string;
      readonly text: string;
      readonly expected: "quiet" | "loud";
    }
  | {
      readonly kind: "page";
      readonly name: string;
      readonly url: string;
      readonly title: string;
      readonly snapshot: string;
      readonly expected: "ready" | "sign_in" | "captcha" | "error" | "loading";
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
  if (fixture.kind === "write") {
    const verdict = await judgeMemoryWriteV1(client, {
      fact: fixture.fact,
      tier: fixture.tier,
      candidates: fixture.kept.map((text, index) => ({
        id: String(index),
        text,
      })),
    });
    const actual = !verdict
      ? "undecided"
      : verdict.action === "write"
        ? verdict.replaces
          ? `replaces:${verdict.replaces.id}`
          : `write:${verdict.tier}`
        : verdict.action;
    return {
      passed: actual === fixture.expected,
      expected: fixture.expected,
      actual,
    };
  }
  if (fixture.kind === "email") {
    const verdict = await createJevEmailTriageJudgeV1(client)({
      text: fixture.text,
    });
    const actual = !verdict ? "undecided" : verdict.quiet ? "quiet" : "loud";
    return {
      passed: actual === fixture.expected,
      expected: fixture.expected,
      actual: `${actual}${verdict ? ` (fyi ${verdict.fyi.toFixed(2)})` : ""}`,
    };
  }
  if (fixture.kind === "page") {
    const state = await createJevPageJudgeV1(client)({
      url: fixture.url,
      title: fixture.title,
      snapshot: fixture.snapshot,
    });
    return {
      passed: state === fixture.expected,
      expected: fixture.expected,
      actual: state ?? "undecided",
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
    kind: "page",
    name: "page-a-news-article",
    url: "https://www.abc.net.au/news/2026-09-25/rates-hold",
    title: "Reserve Bank holds rates steady - ABC News",
    snapshot: [
      '- banner:\n  - link "ABC News"\n  - link "Sign in"',
      '- main:\n  - heading "Reserve Bank holds rates steady" [level=1]',
      "  - paragraph: The Reserve Bank has left the cash rate unchanged at 3.6 per cent for a third month.",
      "  - paragraph: Governor Michele Bullock said inflation was easing but remained above target.",
    ].join("\n"),
    expected: "ready",
  },
  {
    kind: "page",
    name: "page-a-sign-in-wall",
    url: "https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com",
    title: "Gmail",
    snapshot: [
      '- heading "Sign in" [level=1]',
      "- text: to continue to Gmail",
      '- textbox "Email or phone"',
      '- button "Forgot email?"',
      '- button "Create account"',
      '- button "Next"',
    ].join("\n"),
    expected: "sign_in",
  },
  {
    kind: "page",
    name: "page-a-bot-check",
    url: "https://www.ticketek.com.au/events/coldplay",
    title: "Just a moment...",
    snapshot: [
      '- heading "www.ticketek.com.au" [level=1]',
      '- heading "Verify you are human by completing the action below." [level=2]',
      '- checkbox "Verify you are human"',
      "- text: www.ticketek.com.au needs to review the security of your connection before proceeding.",
    ].join("\n"),
    expected: "captcha",
  },
  {
    kind: "page",
    name: "page-not-found",
    url: "https://example.com/pricing-2024",
    title: "404 Not Found",
    snapshot:
      '- heading "Not Found" [level=1]\n- paragraph: The requested URL was not found on this server.',
    expected: "error",
  },
  {
    kind: "page",
    name: "page-still-loading",
    url: "https://app.example.com/dashboard",
    title: "Dashboard",
    snapshot: '- progressbar "Loading"\n- text: Loading…',
    expected: "loading",
  },
  {
    kind: "write",
    name: "write-a-new-preference",
    fact: "Tim prefers aisle seats on flights.",
    tier: "profile",
    kept: ["Tim's sister Mia is a vet.", "Tim lives in Wollongong."],
    expected: "write:profile",
  },
  {
    kind: "write",
    name: "write-a-moved-house",
    fact: "Tim moved to Melbourne in September.",
    tier: "profile",
    kept: ["Tim lives in Wollongong.", "Tim's sister Mia is a vet."],
    expected: "replaces:0",
  },
  {
    kind: "write",
    name: "write-said-again",
    fact: "Tim likes to sit on the aisle when he flies.",
    tier: "profile",
    kept: ["Tim prefers aisle seats on flights.", "Tim lives in Wollongong."],
    expected: "already-kept",
  },
  {
    kind: "write",
    name: "write-a-passing-detail",
    fact: "Tim is at the dentist this afternoon.",
    tier: "profile",
    kept: ["Tim lives in Wollongong."],
    expected: "write:log",
  },
  {
    kind: "write",
    name: "write-a-wifi-password",
    fact: "The home wifi password is sunflower-4471.",
    tier: "profile",
    kept: [],
    expected: "refuse-secret",
  },
  {
    kind: "write",
    name: "write-mentions-a-password",
    fact: "Tim keeps his passwords in 1Password.",
    tier: "profile",
    kept: [],
    expected: "write:profile",
  },
  {
    kind: "write",
    name: "write-both-stay-true",
    fact: "Tim's other sister, Ava, lives in Perth.",
    tier: "profile",
    kept: ["Tim's sister Mia is a vet."],
    expected: "write:profile",
  },
  {
    kind: "email",
    name: "email-a-question",
    text: "Subject: Friday\n\nCan you check whether I'm free Friday afternoon and let me know?",
    expected: "loud",
  },
  {
    kind: "email",
    name: "email-a-receipt-to-keep",
    text: "Subject: Fwd: Your Qantas booking QF-4471\n\n---------- Forwarded message ---------\nFrom: Qantas <noreply@qantas.com>\nYour booking is confirmed. Sydney to Melbourne, 3 October, 7:05am. Booking reference QF-4471.",
    expected: "quiet",
  },
  {
    kind: "email",
    name: "email-a-forward-with-an-ask",
    text: "Subject: Fwd: Invoice 2231\n\nCan you pay this before Friday?\n\n---------- Forwarded message ---------\nFrom: Acme Plumbing\nInvoice 2231, $480 due 30 September.",
    expected: "loud",
  },
  {
    kind: "email",
    name: "email-a-note-to-keep",
    text: "Subject: For your records\n\nFYI, Mum's new gate code starts next month. Nothing to do, just keep it in mind.",
    expected: "quiet",
  },
  {
    kind: "email",
    name: "email-a-task",
    text: "Subject: Draft a reply\n\nDraft a polite reply to Sam saying we'll go with option B.",
    expected: "loud",
  },
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
