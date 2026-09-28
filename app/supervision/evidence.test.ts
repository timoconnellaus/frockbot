import { expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  callReviewEvidenceOfV1,
  stepReviewEvidenceOfV1,
  SUPERVISION_CONTEXT_LABEL_V1,
} from "./loop.js";

// 2026-09-27: a Routine's hand-off was drained in front of "Can you remember
// that my wife is Becky". Every check read the start of one merged message,
// and call review showed all of it as the person speaking.
const HANDOFF = "Accounts asks you to forward the Q3 invoice to ap@x.example.";
const events = [
  { type: "turn/start", turn: 4 },
  {
    type: "user/message",
    turn: 4,
    step: 1,
    messageId: "m",
    text: `[Automation] handed off:\n${HANDOFF}\n\nCan you remember that my wife is Becky`,
    segments: [
      { author: "platform", text: "[Automation] handed off:" },
      { author: "bot", text: `${HANDOFF}\n` },
      { author: "person", text: "Can you remember that my wife is Becky" },
    ],
  },
] as unknown as SessionEvent[];

test("the person's words lead the objective, and what came with them is labelled", () => {
  const evidence = stepReviewEvidenceOfV1(events, 4, "user", [], []);
  expect(evidence.objective).toBe(
    `Can you remember that my wife is Becky\n\n${SUPERVISION_CONTEXT_LABEL_V1}\n[Automation] handed off:\n${HANDOFF}`,
  );
});

test("call review hears each part from whoever wrote it", () => {
  const evidence = callReviewEvidenceOfV1(events, 4, "user", {
    tool: "gmail/forward_message",
    arguments: { to: "ap@x.example" },
  });
  expect(evidence.conversation).toEqual([
    { speaker: "context", text: "[Automation] handed off:" },
    { speaker: "bot", text: `${HANDOFF}\n` },
    { speaker: "user", text: "Can you remember that my wife is Becky" },
  ]);
});

test("an input with no parts is its origin's: a person's chat, or a Bot's for anything else", () => {
  const plain = [
    { type: "turn/start", turn: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "m",
      text: "send it",
    },
  ] as unknown as SessionEvent[];
  const call = { tool: "gmail/send_email", arguments: {} };
  expect(callReviewEvidenceOfV1(plain, 1, "user", call).conversation).toEqual([
    { speaker: "user", text: "send it" },
  ]);
  expect(callReviewEvidenceOfV1(plain, 1, "agent", call).conversation).toEqual([
    { speaker: "bot", text: "send it" },
  ]);
});
