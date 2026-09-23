import {
  APIError,
  choice,
  noul,
  TypeSafeError,
  type ChoiceResponse,
  type JsonValue,
  type NoulResponse,
  type Question,
  type TypeSafeClient,
  type Usage,
} from "@typesafe-ai/sdk";
import type {
  GroupMentionFlowV1,
  GroupReplyDecisionV1,
  GroupReplyEvidenceV1,
} from "@frockbot/core/contracts";

// Who in a Group Chat answers a message. One yes/no question per member Jev
// may ask, one question whether the message calls for any member at all, and
// — for a member's message that mentions others — whether asking them carries
// the conversation on. The labelled runner lives beside this file.

/** Pinned because the fixtures' expected answers were labelled against it. */
export const GROUP_REPLY_MODEL_V1 = "jev-1.13.0";

export const GROUP_REPLY_RETRY_V1 = { maxRetries: 0 } as const;
export const GROUP_REPLY_ATTEMPT_TIMEOUT_MS_V1 = 30_000;
export const GROUP_REPLY_RUN_TIMEOUT_MS_V1 = 300_000;

/** Above this, a member is asked. */
export const GROUP_REPLY_THRESHOLD_V1 = 0.5;

function nameOf(evidence: GroupReplyEvidenceV1, botId: string): string {
  return (
    evidence.members.find((member) => member.botId === botId)?.name ?? botId
  );
}

export function groupReplyStateV1(
  evidence: GroupReplyEvidenceV1,
): Record<string, JsonValue> {
  return {
    group: evidence.groupName,
    members: evidence.members.map((member) => ({
      name: member.name,
      ...(member.description ? { description: member.description } : {}),
    })),
    thread: evidence.recent.map((line) => ({
      speaker: line.speaker,
      text: line.text,
    })),
    message: {
      speaker: evidence.message.speaker,
      text: evidence.message.text,
      mentions: evidence.message.mentions.map((botId) =>
        nameOf(evidence, botId),
      ),
    },
  };
}

const memberKey = (index: number) => `member_${index}`;

export function groupReplyQuestionsV1(
  evidence: GroupReplyEvidenceV1,
): Record<string, Question> {
  const questions: Record<string, Question> = {
    answer: choice(
      {
        target: "The latest `message` in this group chat",
        decision:
          "Does the message call for an answer or action from a member Bot who has not been @mentioned in it?",
        rules: [
          "The group is the User and the member Bots listed in `members`. Every member reads every message.",
          "A member @mentioned in `message.mentions` is already answering; judge only whether someone else is needed.",
          "A question, request or task put to the group, or to a member by name without @, calls for an answer.",
          "Thanks, acknowledgements, reactions and remarks that ask nothing do not.",
          "A message that only hands a question to the @mentioned members does not call for anyone else.",
        ],
      },
      {
        needed: {
          include:
            "Someone besides the mentioned members should answer or act on this now",
        },
        not_needed: {
          include:
            "Nobody else needs to answer: it asks nothing, or the mentioned members have it",
        },
      },
    ),
  };
  evidence.candidates.forEach((botId, index) => {
    const member = evidence.members.find(
      (candidate) => candidate.botId === botId,
    );
    const name = member?.name ?? botId;
    questions[memberKey(index)] = noul(
      {
        target: `The member Bot "${name}"${member?.description ? `, which is for: ${member.description}` : ""}`,
        decision: `Should ${name} answer or act on the latest message now?`,
        rules: [
          `Yes when the message is put to ${name} by name, is squarely ${name}'s kind of work, follows up on what ${name} said last, or is put to everyone.`,
          `No when it is for someone else, asks nothing, or another member is clearly the one it is for.`,
          "Several members may each be right to answer; judge this member on its own.",
        ],
      },
      {
        true: `${name} should answer or act now`,
        false: `${name} should stay quiet`,
      },
    );
  });
  if (evidence.botAuthored && evidence.message.mentions.length > 0) {
    questions.flow = choice(
      {
        target:
          "The latest `message`, written by a member Bot, and the members it @mentions",
        decision:
          "Would asking the @mentioned members carry the conversation forward?",
        rules: [
          "The User started this conversation; the members work for them.",
          "continues: the mention asks for something new that moves the User's request on.",
          "loops: the mention asks for something already asked or answered in `thread`, or bounces the same question back and forth, or is only thanks and pleasantries between Bots.",
          "drifts: the mention pursues something the User did not ask for and would not want time spent on.",
        ],
      },
      {
        continues: { include: "Asking them moves the User's request on" },
        loops: {
          include: "Asking them repeats, bounces back, or trades pleasantries",
        },
        drifts: {
          include: "Asking them wanders away from what the User wanted",
        },
      },
    );
  }
  return questions;
}

export type GroupReplyAnswersV1 = Record<string, ChoiceResponse | NoulResponse>;

export interface GroupReplyReviewV1 {
  readonly model: string;
  readonly usage: Usage;
  readonly requestId: string | undefined;
  readonly answers: GroupReplyAnswersV1;
}

export async function reviewGroupReplyV1(
  client: TypeSafeClient,
  evidence: GroupReplyEvidenceV1,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GroupReplyReviewV1> {
  const { data, requestId } = await client
    .systemOne(
      {
        state: groupReplyStateV1(evidence),
        questions: groupReplyQuestionsV1(evidence),
        model: GROUP_REPLY_MODEL_V1,
      },
      {
        retry: GROUP_REPLY_RETRY_V1,
        timeout: GROUP_REPLY_ATTEMPT_TIMEOUT_MS_V1,
        signal: options.signal,
      },
    )
    .withResponse();
  return {
    model: data.model,
    usage: data.usage,
    requestId,
    answers: data.answers as GroupReplyAnswersV1,
  };
}

function yesOf(answer: ChoiceResponse | NoulResponse | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

/**
 * The decision the answers make. A member is asked when Jev says yes; when
 * it says the message needs someone but no member cleared the bar, the most
 * likely member is asked, so a question to the group is never left hanging.
 */
export function groupReplyDecisionOfV1(
  evidence: GroupReplyEvidenceV1,
  answers: GroupReplyAnswersV1,
): GroupReplyDecisionV1 {
  const scored = evidence.candidates
    .map((botId, index) => ({ botId, yes: yesOf(answers[memberKey(index)]) }))
    .sort((left, right) => right.yes - left.yes);
  const reply = scored
    .filter((member) => member.yes > GROUP_REPLY_THRESHOLD_V1)
    .map((member) => member.botId);
  const answer = answers.answer;
  if (
    reply.length === 0 &&
    scored.length > 0 &&
    answer?.type === "choice" &&
    answer.choice === "needed"
  ) {
    reply.push(scored[0]!.botId);
  }
  const flow = answers.flow;
  return {
    reply,
    ...(flow?.type === "choice"
      ? { mentions: flow.choice as GroupMentionFlowV1 }
      : {}),
  };
}

export interface GroupReplyExpectationV1 {
  /** Exactly these members are asked, in any order. */
  readonly reply: readonly string[];
  readonly mentions?: GroupMentionFlowV1;
}

export interface GroupReplyCheckV1 {
  readonly question: string;
  readonly expected: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface GroupReplyGradeV1 {
  readonly passed: boolean;
  readonly checks: readonly GroupReplyCheckV1[];
}

export function gradeGroupReplyV1(
  expected: GroupReplyExpectationV1,
  decision: GroupReplyDecisionV1,
): GroupReplyGradeV1 {
  const want = [...expected.reply].sort().join(", ") || "nobody";
  const got = [...decision.reply].sort().join(", ") || "nobody";
  const checks: GroupReplyCheckV1[] = [
    { question: "reply", expected: want, actual: got, passed: want === got },
  ];
  if (expected.mentions !== undefined) {
    checks.push({
      question: "mentions",
      expected: expected.mentions,
      actual: decision.mentions ?? "none",
      passed: decision.mentions === expected.mentions,
    });
  }
  return { passed: checks.every((check) => check.passed), checks };
}

export interface GroupReplyFixtureV1 {
  readonly name: string;
  readonly intent: string;
  readonly evidence: GroupReplyEvidenceV1;
  readonly expected: GroupReplyExpectationV1;
}

export function describeGroupReplyFailureV1(error: unknown) {
  if (error instanceof APIError)
    return {
      kind: error.constructor.name,
      message: error.message,
      status: error.status,
      requestId: error.requestId ?? null,
    };
  if (error instanceof TypeSafeError)
    return { kind: error.constructor.name, message: error.message };
  return { kind: "Error", message: String(error) };
}
