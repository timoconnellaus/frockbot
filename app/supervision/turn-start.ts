import {
  choice,
  noul,
  score,
  type JsonValue,
  type SystemOneResult,
  type TypeSafeClient,
  type Usage,
} from "@typesafe-ai/sdk";
import {
  SPECIALIST_CAPABILITIES_V1,
  type SpecialistCapabilityV1,
  type SupervisionJudgmentV1,
  type TurnDirective,
  type TurnInputOriginV1,
  type TurnStartEvidence,
} from "@frockbot/core/contracts";

// The start-of-Turn Jev questions, and every threshold code applies to their
// answers. Jev judges; `composeTurnDirectiveV1` decides. Every Turn is asked
// these before its first model call. Tuning is a change here plus
// `bun run eval:turn-start`.

/** Pinned because the suite's expected answers were labeled against it. */
export const TURN_START_MODEL_V1 = "jev-1.13.0";

/** Off, so one case is one call: the runner owns its own attempts. */
export const TURN_START_RETRY_V1 = { maxRetries: 0 } as const;

/** Per attempt. With retries off this is also the per-case budget. */
export const TURN_START_ATTEMPT_TIMEOUT_MS_V1 = 30_000;

/** End-to-end budget across the whole suite, owned by the caller's signal. */
export const TURN_START_RUN_TIMEOUT_MS_V1 = 600_000;

/**
 * The Noul at or above which a Turn acknowledges first. `NO` is grading only.
 * Labeled for this model and these words; neither moves to another question
 * or another Jev version without rerunning the suite.
 */
export const TURN_START_ACKNOWLEDGE_YES_V1 = 0.6;
export const TURN_START_ACKNOWLEDGE_NO_V1 = 0.4;

/**
 * What Jev sees at the start of a Turn. Narrower than `TurnStartEvidence`
 * on purpose: policy and specialist profiles bear on the steps, not on these
 * questions, and open work is described in words here because a continuation
 * item's evidence refs mean nothing to a reader without the log.
 */
export interface TurnStartJudgmentEvidenceV1 {
  readonly input: {
    readonly text: string;
    readonly origin: TurnInputOriginV1;
  };
  /** Recent User and Bot messages, oldest first, ending before `input`. */
  readonly conversation: readonly {
    readonly speaker: "user" | "bot";
    readonly text: string;
  }[];
  /** Work already in progress or offered, and where it stands. */
  readonly openWork: readonly {
    readonly id: string;
    readonly status: "open" | "blocked";
    readonly description: string;
  }[];
}

/**
 * The judgment evidence of an admitted Turn. Only open and blocked work that
 * code could describe is shown; a bare reference would mean nothing to Jev.
 */
export function turnStartJudgmentEvidenceV1(
  evidence: TurnStartEvidence,
): TurnStartJudgmentEvidenceV1 {
  return {
    input: { text: evidence.input.text, origin: evidence.input.origin },
    conversation: evidence.conversation.map((message) => ({
      speaker: message.speaker,
      text: message.text,
    })),
    openWork: evidence.continuation.flatMap((item) =>
      (item.status === "open" || item.status === "blocked") &&
      item.description !== undefined
        ? [
            {
              id: item.id,
              status: item.status,
              description: item.description,
            },
          ]
        : [],
    ),
  };
}

/** The state Jev sees: exactly the evidence, so nothing reaches it unseen. */
export function turnStartStateV1(
  evidence: TurnStartJudgmentEvidenceV1,
): Record<string, JsonValue> {
  return {
    input: { text: evidence.input.text, origin: evidence.input.origin },
    conversation: evidence.conversation.map((message) => ({
      speaker: message.speaker,
      text: message.text,
    })),
    openWork: evidence.openWork.map((item) => ({
      id: item.id,
      status: item.status,
      description: item.description,
    })),
  };
}

const capabilityCriteria = {
  none: "No specialist: the Bot does it itself, in its reply or with its own tools in a few steps, including a quick opinion on something short",
  planning: "Laying out a multi-part plan or schedule before any of it is done",
  research: "Finding and comparing information from many sources",
  coding: "Writing, fixing or building code or a tool",
  criticism:
    "A thorough review of something long the User made, part by part, for its weaknesses",
  mentoring: "Getting unstuck on work that has already failed more than once",
} as const satisfies Record<"none" | SpecialistCapabilityV1, string>;

/**
 * Six narrow judgments, one per decision code makes. `objective` is not a
 * `TurnDirective` field: it is what says a short message is about the work
 * already open, which continuation routes on.
 */
export const turnStartQuestionsV1 = {
  acknowledge: noul(
    {
      target: "The Bot's first message this Turn, in answer to `input.text`",
      decision:
        "Should that first message be a short acknowledgement, sent before the Bot does any other work this Turn?",
      requirements: [
        "Answering well takes more than one quick lookup: several tool calls, building, checking, researching, or carrying on with work already under way in `openWork`",
        "Without a word first, the User would see nothing until that work ends",
      ],
    },
    {
      true: "Both hold: there is real work to do, and the User would otherwise wait in silence",
      false:
        "The Bot can give its whole answer in its first message, at most after one quick lookup",
    },
  ),
  complexity: choice(
    {
      target:
        "The work a good answer to `input.text` takes, including any work in `openWork` it carries on",
      decision: "How much work is that?",
      rules: [
        "A message that nudges, checks on or retries open work carries that work's size, however short the message is.",
        "Judge the work, not the length of the reply.",
        "Finding and comparing several options is many steps, however few searches it might take.",
      ],
    },
    {
      simple:
        "One reply from what the Bot already knows, or a single quick lookup",
      moderate: "A few tool calls about one thing, or one short piece of work",
      complex:
        "Many steps: building, debugging, researching and comparing several things, reading or writing something long, or carrying on with work like that",
    },
  ),
  objective: choice(
    {
      target: "`input.text`, the User's newest message",
      decision: "What is it about?",
      rules: [
        "Read it with `conversation` and `openWork`: a short message sent while work is open is usually about that work — a nudge, a call for a word, or a question about how it is going. Thanks that expects nothing more is not.",
        "With nothing in `openWork`, there is no open work.",
        "A message that plainly asks for something else is a new request, however much work is open.",
      ],
    },
    {
      open_work:
        "The work in progress or offered: carry on with it, retry it, check on it or ask how it is going, change it or stop it, or a nudge or call for a word while it runs",
      new_request: "Something the Bot should do that is not the open work",
      conversation_only:
        "Asks nothing of any work: thanks or a greeting that expects nothing back, or small talk while no work is open",
    },
  ),
  ambiguity: choice(
    {
      target: "`input.text`, read with `conversation` and `openWork`",
      decision: "Can the Bot act on it without asking the User what they mean?",
      rules: [
        "Only a real fork counts: two readings that lead to different actions, with nothing in the conversation to choose between them.",
        "A detail the Bot can sensibly choose itself is not a fork.",
      ],
    },
    {
      clear: "What to do is settled by the message and what came before it",
      needs_clarification:
        "It could mean different things that lead to different actions, and nothing settles which",
    },
  ),
  consequence: score(
    {
      target: "The work `input.text` asks for, done as the User means it",
      decision: "How far does its effect reach, and how recoverable is it?",
      rule: "Judge the effect of doing it, not whether the User may ask for it. Answering a question changes nothing.",
    },
    [
      "Nothing leaves FrockBot and the Bot could undo it without the User noticing",
      "A change inside FrockBot the User can see and reverse themselves",
      "Something reaches a third party or outside system but can still be corrected",
      "Irreversible once done: money moves, data is destroyed, or a message reaches people it cannot be recalled from",
    ] as const,
  ),
  capability: choice(
    {
      target:
        "The work `input.text` asks for, with any open work it carries on",
      decision: "Which specialist capability, if any, does it most need?",
      rules: [
        "Answer none when the Bot can do it with its own tools in a few steps.",
        "Work that has already failed more than once and is asked for again needs mentoring, whatever kind of work it is.",
        "Name one: the capability the work cannot be done well without.",
      ],
    },
    capabilityCriteria,
  ),
} as const;

export type TurnStartAnswersV1 = SystemOneResult<
  typeof turnStartQuestionsV1
>["answers"];

export type TurnStartObjectiveV1 = TurnStartAnswersV1["objective"]["choice"];
export type TurnStartCapabilityV1 = TurnStartAnswersV1["capability"]["choice"];

export interface TurnStartReviewV1 {
  readonly model: string;
  readonly usage: Usage;
  readonly requestId: string | undefined;
  readonly answers: TurnStartAnswersV1;
}

/**
 * One bounded call. A service failure propagates as the SDK's error, never as
 * an answer: a transport failure is not a judgment.
 */
export async function reviewTurnStartV1(
  client: TypeSafeClient,
  evidence: TurnStartJudgmentEvidenceV1,
  options: {
    readonly signal?: AbortSignal;
    /** A Turn's budget; the evals ask once per case. */
    readonly budget?: {
      readonly retry: { readonly maxRetries: number };
      readonly timeout: number;
    };
  } = {},
): Promise<TurnStartReviewV1> {
  const { data, requestId } = await client
    .systemOne(
      {
        state: turnStartStateV1(evidence),
        questions: turnStartQuestionsV1,
        model: TURN_START_MODEL_V1,
      },
      {
        retry: options.budget?.retry ?? TURN_START_RETRY_V1,
        timeout: options.budget?.timeout ?? TURN_START_ATTEMPT_TIMEOUT_MS_V1,
        signal: options.signal,
      },
    )
    .withResponse();
  return {
    model: data.model,
    usage: data.usage,
    requestId,
    answers: data.answers,
  };
}

const CAPABILITIES: readonly string[] = SPECIALIST_CAPABILITIES_V1;

function isSpecialistCapabilityV1(
  value: string,
): value is SpecialistCapabilityV1 {
  return CAPABILITIES.includes(value);
}

/** Where a person is waiting on the Turn's first word. */
const WAITING_ORIGINS_V1: readonly TurnInputOriginV1[] = ["user", "voice"];

function probability(
  answer: { readonly probabilities: Readonly<Record<string, number>> },
  label: string,
): number {
  return answer.probabilities[label] ?? 0;
}

/** The answers as the durable record keeps them. */
export function turnStartJudgmentsV1(
  answers: TurnStartAnswersV1,
): SupervisionJudgmentV1[] {
  const picked = (
    question: string,
    answer: {
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
    },
  ): SupervisionJudgmentV1 => ({
    question,
    answer: answer.choice,
    value: probability(answer, answer.choice),
  });
  return [
    { question: "acknowledge", value: answers.acknowledge.noul },
    picked("complexity", answers.complexity),
    picked("objective", answers.objective),
    picked("ambiguity", answers.ambiguity),
    { question: "consequence", value: answers.consequence.score },
    picked("capability", answers.capability),
  ];
}

/**
 * What code makes of the answers. An acknowledgement needs Jev over the
 * threshold, a request clear enough to act on — a question to the User is
 * already the first word — a message that asks for something, and a person
 * waiting on it. When any of that is unsure there is no steering, and the
 * Bot's own judgment stands. The rest is read across; `steering` stays empty
 * because no start-of-Turn answer maps to a reason code yet.
 */
export function composeTurnDirectiveV1(
  answers: TurnStartAnswersV1,
  origin: TurnInputOriginV1,
  model?: string,
): TurnDirective {
  const capability = answers.capability.choice;
  return {
    acknowledge:
      answers.acknowledge.noul >= TURN_START_ACKNOWLEDGE_YES_V1 &&
      answers.ambiguity.choice === "clear" &&
      answers.objective.choice !== "conversation_only" &&
      WAITING_ORIGINS_V1.includes(origin),
    complexity: answers.complexity.choice,
    consequence: answers.consequence.score,
    ambiguity: answers.ambiguity.choice,
    requiredCapabilities: isSpecialistCapabilityV1(capability)
      ? [capability]
      : [],
    steering: [],
    judgments: turnStartJudgmentsV1(answers),
    ...(model === undefined ? {} : { model }),
  };
}
