import { describe, expect, test } from "bun:test";
import type { ClientRunV1 } from "@frockbot/app/shell/run-protocol";
import {
  renderVoiceBotHistoryV1,
  renderVoiceBotSearchV1,
  renderVoiceBotStatusV1,
  VOICE_HISTORY_RESULT_CHARS_V1,
  VOICE_HISTORY_TEXT_CHARS_V1,
} from "./history.js";

const at = "2026-09-13T03:00:00.000Z";
const bot = { botId: "remy", botName: "Remy" };
const run = (input: Partial<ClientRunV1> = {}): ClientRunV1 => ({
  schemaVersion: 3,
  runId: "r1",
  admittedAt: at,
  input: "What is the plan?",
  status: "completed",
  events: [],
  ...input,
});
const send = (text: string, ordinal = 0): ClientRunV1["events"][number] => ({
  type: "send/to-user",
  ordinal,
  payload: { type: "text", text },
});

describe("voice reads of Bot conversation", () => {
  test("reads explicit messages with the actual requester, time and source", () => {
    const result = JSON.parse(
      renderVoiceBotHistoryV1({
        ...bot,
        runs: [
          run({
            via: { kind: "voice" },
            events: [
              {
                type: "tool/call",
                call: { id: "private-call", name: "secret-tool" },
              },
              {
                type: "tool/result",
                callId: "private-call",
                content: "private tool output",
                isError: false,
              },
              send("I sent the plan to your email."),
              {
                type: "reply/to-caller",
                caller: "voice",
                text: "Your morning is free.",
              },
            ],
            outcome: { type: "completed", text: "private model scratch" },
          }),
        ],
      }),
    );
    expect(result.timestamp).toBe("turn admission");
    expect(result.messages).toEqual([
      {
        runId: "r1",
        at,
        role: "voice",
        messageId: "r1:voice",
        text: "What is the plan?",
      },
      {
        runId: "r1",
        at,
        role: "assistant",
        to: "user",
        messageId: "r1:send:0",
        text: "I sent the plan to your email.",
      },
      {
        runId: "r1",
        at,
        role: "assistant",
        to: "voice",
        messageId: "r1:voice",
        text: "Your morning is free.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("reads visible questions and file labels without fetching attachments", () => {
    const result = JSON.parse(
      renderVoiceBotHistoryV1({
        ...bot,
        runs: [
          run({
            events: [
              {
                type: "send/to-user",
                ordinal: 0,
                payload: {
                  type: "widget",
                  widget: {
                    prompt: "Which day?",
                    options: ["Monday", "Tuesday"],
                  },
                },
              },
              {
                type: "send/to-user",
                ordinal: 1,
                payload: {
                  type: "attachment",
                  name: "Plan.pdf",
                  url: "https://files.example/opaque-download",
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(result.messages[1].text).toBe(
      "Asked: Which day? Options: Monday; Tuesday",
    );
    expect(result.messages[2].text).toBe("Shared attachment: Plan.pdf");
    expect(result.messages[2].messageId).toBe("r1:send:1");
    expect(JSON.stringify(result)).not.toContain("opaque-download");
  });

  test("keeps newest messages in conversation order and reports the bound", () => {
    const result = JSON.parse(
      renderVoiceBotHistoryV1(
        {
          ...bot,
          runs: [
            run({
              runId: "new",
              admittedAt: "2026-09-13T04:00:00.000Z",
              events: [send("new answer")],
            }),
            run({ runId: "old", events: [send("old answer")] }),
          ],
        },
        3,
      ),
    );
    expect(
      result.messages.map((message: { text: string }) => message.text),
    ).toEqual(["old answer", "What is the plan?", "new answer"]);
    expect(result.truncated).toBe(true);
  });

  test("bounds encoded output without broken JSON or lost source identity", () => {
    const longRun = "r".repeat(125);
    const serialized = renderVoiceBotHistoryV1(
      {
        ...bot,
        runs: Array.from({ length: 15 }, (_, i) =>
          run({
            runId: `${longRun}${i}`,
            input: String.fromCharCode(34).repeat(1_000),
          }),
        ),
      },
      8,
    );
    expect(serialized.length).toBeLessThanOrEqual(
      VOICE_HISTORY_RESULT_CHARS_V1,
    );
    const result = JSON.parse(serialized);
    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.at(-1).runId).toBe(`${longRun}14`);
    for (const message of result.messages)
      expect(message.text.length).toBeLessThanOrEqual(
        VOICE_HISTORY_TEXT_CHARS_V1,
      );
  });

  test("labels another Bot's request without impersonating the User", () => {
    const result = JSON.parse(
      renderVoiceBotHistoryV1({
        ...bot,
        runs: [run({ via: { kind: "bot", botId: "finch", name: "Finch" } })],
      }),
    );
    expect(result.messages[0].role).toBe("bot");
    expect(result.messages[0].fromBotId).toBe("finch");
  });

  test("reads queued and active work without exposing model scratch", () => {
    const result = JSON.parse(
      renderVoiceBotStatusV1({
        ...bot,
        runs: [
          run({
            runId: "queued",
            status: "running",
            queued: true,
            admittedAt: "2026-09-13T04:00:00.000Z",
          }),
          run({
            runId: "active",
            status: "running",
            partialText: "private partial",
            input: "Research",
            events: [send("Checking sources.")],
          }),
        ],
      }),
    );
    expect(result.activity).toBe("working");
    expect(result.queued).toBe(1);
    expect(result.request.runId).toBe("active");
    expect(result.request.status).toBe("running");
    expect(result.lastMessage.text).toBe("Checking sources.");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("distinguishes queued-only, failed and empty conversation state", () => {
    const queued = JSON.parse(
      renderVoiceBotStatusV1({
        ...bot,
        runs: [run({ status: "running", queued: true })],
      }),
    );
    expect(queued.activity).toBe("queued");
    expect(queued.request.status).toBe("queued");
    const failed = JSON.parse(
      renderVoiceBotStatusV1({
        ...bot,
        runs: [
          run({
            status: "failed",
            outcome: { type: "failed", message: "failed", text: "scratch" },
          }),
        ],
      }),
    );
    expect(failed.activity).toBe("idle");
    expect(failed.request.status).toBe("failed");
    expect(failed.lastMessage).toBeUndefined();
    expect(JSON.parse(renderVoiceBotStatusV1({ ...bot, runs: [] }))).toEqual({
      ...bot,
      activity: "idle",
      queued: 0,
    });
  });

  test("search excludes tools, foreign Bots and unreadable runs, keeping voice attribution", () => {
    const result = JSON.parse(
      renderVoiceBotSearchV1({
        ...bot,
        runs: [
          run({
            via: { kind: "voice" },
            events: [
              { type: "reply/to-caller", caller: "voice", text: "Your plan" },
            ],
          }),
        ],
        results: {
          schemaVersion: 1,
          query: "plan",
          truncated: false,
          indexState: "rebuilding",
          hits: [
            {
              botId: "remy",
              runId: "r1",
              at,
              kind: "user",
              snippet: "What is the plan?",
            },
            {
              botId: "remy",
              runId: "r1",
              at,
              kind: "assistant",
              snippet: "Your plan",
            },
            {
              botId: "remy",
              runId: "r1",
              at,
              kind: "tool",
              snippet: "private tool plan",
            },
            {
              botId: "foreign",
              runId: "r1",
              at,
              kind: "user",
              snippet: "foreign plan",
            },
            {
              botId: "remy",
              runId: "unknown",
              at,
              kind: "assistant",
              snippet: "missing plan",
            },
          ],
        },
      }),
    );
    expect(result.messages).toEqual([
      { role: "voice", at, runId: "r1", text: "What is the plan?" },
      { role: "assistant", at, runId: "r1", text: "Your plan" },
    ]);
    expect(result.indexState).toBe("rebuilding");
    expect(JSON.stringify(result)).not.toMatch(
      /private|foreign plan|missing plan/,
    );
  });
});
