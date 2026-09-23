import type { GroupReplyEvidenceV1 } from "@frockbot/core/contracts";
import type { GroupReplyFixtureV1 } from "./group-reply.js";

const MEMBERS = [
  {
    botId: "general",
    name: "General",
    description: "Everyday help, planning and writing.",
  },
  {
    botId: "books",
    name: "Xero Books",
    description:
      "Bookkeeping: invoices, bills, expenses and reconciliation in Xero.",
  },
  {
    botId: "codex",
    name: "Codex",
    description: "Writes and reviews code, and runs it on the Computer.",
  },
];

function evidence(
  over: Partial<GroupReplyEvidenceV1> & Pick<GroupReplyEvidenceV1, "message">,
): GroupReplyEvidenceV1 {
  const mentioned = over.message.mentions;
  const author = MEMBERS.find((member) => member.name === over.message.speaker);
  return {
    groupName: over.groupName ?? "General, Xero Books & Codex",
    members: over.members ?? MEMBERS,
    recent: over.recent ?? [],
    message: over.message,
    botAuthored: over.botAuthored ?? author !== undefined,
    candidates:
      over.candidates ??
      MEMBERS.map((member) => member.botId).filter(
        (botId) => !mentioned.includes(botId) && botId !== author?.botId,
      ),
  };
}

export const groupReplyFixturesV1: readonly GroupReplyFixtureV1[] = [
  {
    name: "bookkeeping-question-to-group",
    intent:
      "A bookkeeping question put to the group is for the bookkeeping Bot alone.",
    evidence: evidence({
      message: {
        speaker: "User",
        text: "Has the Acme invoice from last month been paid yet?",
        mentions: [],
      },
    }),
    expected: { reply: ["books"] },
  },
  {
    name: "code-question-to-group",
    intent: "A code question is for the coding Bot.",
    evidence: evidence({
      message: {
        speaker: "User",
        text: "The deploy script is failing with a permissions error on the build step. Can someone take a look?",
        mentions: [],
      },
    }),
    expected: { reply: ["codex"] },
  },
  {
    name: "everyone-asked",
    intent: "A question put to everyone asks every member.",
    evidence: evidence({
      message: {
        speaker: "User",
        text: "Quick round: everyone, tell me one thing you finished today.",
        mentions: [],
      },
    }),
    expected: { reply: ["general", "books", "codex"] },
  },
  {
    name: "greeting-to-group",
    intent: "Saying hi to a group chat gets a hello back from everyone.",
    evidence: evidence({
      message: { speaker: "User", text: "hi", mentions: [] },
    }),
    expected: { reply: ["general", "books", "codex"] },
  },
  {
    name: "greeting-after-a-break",
    intent: "A greeting after earlier work is still put to everyone.",
    evidence: evidence({
      recent: [
        { speaker: "User", text: "Can you reconcile March?" },
        {
          speaker: "Xero Books",
          text: "Done — March is reconciled, no exceptions.",
        },
        { speaker: "User", text: "Great, thanks!" },
      ],
      message: { speaker: "User", text: "Morning all", mentions: [] },
    }),
    expected: { reply: ["general", "books", "codex"] },
  },
  {
    name: "thanks-to-group",
    intent: "Thanks asks nothing of anyone.",
    evidence: evidence({
      recent: [
        { speaker: "User", text: "Can you reconcile March?" },
        {
          speaker: "Xero Books",
          text: "Done — March is reconciled, no exceptions.",
        },
      ],
      message: { speaker: "User", text: "Great, thanks!", mentions: [] },
    }),
    expected: { reply: [] },
  },
  {
    name: "mention-covers-it",
    intent: "A message that @mentions the right member needs nobody else.",
    evidence: evidence({
      message: {
        speaker: "User",
        text: "@Codex can you bump the Node version in the Dockerfile?",
        mentions: ["codex"],
      },
    }),
    expected: { reply: [] },
  },
  {
    name: "follow-up-by-name",
    intent: "A follow-up to what a member just said is for that member.",
    evidence: evidence({
      recent: [
        {
          speaker: "User",
          text: "What did we spend on software last quarter?",
        },
        {
          speaker: "Xero Books",
          text: "$4,120 across 14 subscriptions; GitHub and Figma are the largest.",
        },
      ],
      message: {
        speaker: "User",
        text: "Which of those are annual rather than monthly?",
        mentions: [],
      },
    }),
    expected: { reply: ["books"] },
  },
  {
    name: "member-greets-back",
    intent:
      "A member returning the User's hello is not a greeting the others answer.",
    evidence: evidence({
      recent: [
        { speaker: "User", text: "hi" },
        { speaker: "Xero Books", text: "Hi! Anything on the books today?" },
        { speaker: "Codex", text: "Hey — what are we building?" },
      ],
      message: {
        speaker: "General",
        text: "Hello! What can I help with today?",
        mentions: [],
      },
    }),
    expected: { reply: [] },
  },
  {
    name: "member-answer-asks-nobody",
    intent: "A member's answer to the User is not for the other members.",
    evidence: evidence({
      recent: [
        {
          speaker: "User",
          text: "What did we spend on software last quarter?",
        },
      ],
      message: {
        speaker: "Xero Books",
        text: "$4,120 across 14 subscriptions; GitHub and Figma are the largest.",
        mentions: [],
      },
    }),
    expected: { reply: [] },
  },
  {
    name: "bot-asks-bot-new-work",
    intent:
      "A member asking another for the part only it can do carries the request on.",
    evidence: evidence({
      recent: [
        {
          speaker: "User",
          text: "Plan the offsite: book a venue and tell me what it will cost us.",
        },
      ],
      message: {
        speaker: "General",
        text: "I've shortlisted two venues at $2,400 and $3,100. @Xero Books, how much is left in the events budget this quarter?",
        mentions: ["books"],
      },
      botAuthored: true,
      candidates: ["codex"],
    }),
    expected: { reply: [], mentions: "continues" },
  },
  {
    name: "bots-trading-thanks",
    intent: "Two members thanking each other is a loop.",
    evidence: evidence({
      recent: [
        { speaker: "User", text: "Get the Q2 numbers into the board deck." },
        {
          speaker: "Xero Books",
          text: "@General here are the Q2 numbers: revenue $182k, costs $140k.",
        },
        {
          speaker: "General",
          text: "Thanks @Xero Books! Added them to slide 4.",
        },
      ],
      message: {
        speaker: "Xero Books",
        text: "You're welcome @General! Great working with you.",
        mentions: ["general"],
      },
      botAuthored: true,
      candidates: ["codex"],
    }),
    expected: { reply: [], mentions: "loops" },
  },
  {
    name: "bot-wanders-off",
    intent:
      "A member dragging another into work the User did not ask for is drift.",
    evidence: evidence({
      recent: [
        {
          speaker: "User",
          text: "Send me the total of unpaid invoices, that's all I need.",
        },
        { speaker: "Xero Books", text: "Unpaid invoices total $12,480." },
      ],
      message: {
        speaker: "Xero Books",
        text: "@Codex while we're at it, could you build a dashboard app that charts all our invoices by month with a login system?",
        mentions: ["codex"],
      },
      botAuthored: true,
      candidates: ["general"],
    }),
    expected: { reply: [], mentions: "drifts" },
  },
];
