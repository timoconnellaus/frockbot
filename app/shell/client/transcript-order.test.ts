import { plugin } from "bun";
import { describe, expect, test } from "bun:test";
import type { ClientRun } from "@frockbot/client-core";

// The client graph reaches Vue single-file components; Bun has no loader for
// them and this test exercises projection and ordering, not rendering.
plugin({
  name: "transcript-order-vue-test-loader",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
});

const { projectDurableRuns, turnStampV1 } = await import("./index.js");
import type { WebChatMessage } from "../shared.js";
import { orderTranscriptV1 } from "./transcript-order.ts";

/** How the thread reads, one line per row, in the order it is drawn. */
function thread(messages: readonly WebChatMessage[]): string[] {
  return orderTranscriptV1(messages, "2026-09-05T12:30:00.000Z")
    .filter((message) => message.text || message.notice)
    .map((message) => `${message.role}: ${message.text || message.notice}`);
}

/*
 * The production sweep on v0.3.31: a message is sent, and while its reply is
 * streaming two more are sent. Each of the three Turns is admitted by the
 * backend a moment after the browser drew it, so a Turn's user line ends up
 * carrying the run's durable `admittedAt` while the reply this tab received
 * from its own POST carried the browser clock from before the send.
 */
const HAIKU = "Soft wool on green hills";
const ANSWER = "Got it — both messages arrived.";

function run(input: Partial<ClientRun> & { runId: string }): ClientRun {
  return {
    input: "",
    status: "completed",
    events: [],
    admittedAt: "2026-09-05T12:19:00.000Z",
    ...input,
  } as ClientRun;
}

describe("the order a thread is drawn in", () => {
  test("keeps a reply under the messages it answers across three sends", () => {
    const state = { messages: [] as WebChatMessage[] };
    projectDurableRuns(state, [], [
      run({
        runId: "run-a",
        input: "QA check: reply with a short haiku about sheep.",
        admittedAt: "2026-09-05T12:19:00.000Z",
        responseText: HAIKU,
      }),
      run({
        runId: "run-b",
        input: "Second message sent while the first reply is still running.",
        admittedAt: "2026-09-05T12:19:21.000Z",
        responseText: ANSWER,
      }),
      run({
        runId: "run-c",
        input: "Third message queued during the run.",
        admittedAt: "2026-09-05T12:19:31.000Z",
        status: "running",
      }),
    ] as ClientRun[]);

    // What the POST for the second message did before this fix: stamp the
    // reply with the browser's clock at the moment send was pressed, which is
    // earlier than every durable stamp the backend went on to assign.
    for (const message of state.messages) {
      if (message.runId === "run-b" && message.role === "assistant") {
        message.at = "2026-09-05T12:19:20.000Z";
      }
    }

    expect(thread(state.messages)).toEqual([
      "user: QA check: reply with a short haiku about sheep.",
      `assistant: ${HAIKU}`,
      "user: Second message sent while the first reply is still running.",
      `assistant: ${ANSWER}`,
      "user: Third message queued during the run.",
    ]);
  });

  test("stamps a Turn's reply with the moment its own message was admitted", () => {
    const state = { messages: [] as WebChatMessage[] };
    projectDurableRuns(state, [], [
      run({
        runId: "run-b",
        input: "Second message sent while the first reply is still running.",
        admittedAt: "2026-09-05T12:19:21.000Z",
        responseText: ANSWER,
      }),
    ] as ClientRun[]);

    expect(turnStampV1(state.messages, "run-b")).toBe(
      "2026-09-05T12:19:21.000Z",
    );
  });

  test("still sorts a line the product wrote between Turns by its own time", () => {
    const messages: WebChatMessage[] = [
      {
        id: "run-a:user",
        runId: "run-a",
        role: "user",
        text: "first",
        at: "2026-09-05T12:19:00.000Z",
        status: "completed",
        tools: [],
        sends: [],
      },
      {
        id: "run-a:assistant",
        runId: "run-a",
        role: "assistant",
        text: "first reply",
        at: "2026-09-05T12:19:00.000Z",
        status: "completed",
        tools: [],
        sends: [],
      },
      {
        id: "run-b:user",
        runId: "run-b",
        role: "user",
        text: "second",
        at: "2026-09-05T12:20:00.000Z",
        status: "completed",
        tools: [],
        sends: [],
      },
      {
        id: "announcement-1",
        runId: "announcement-1",
        role: "system",
        text: "Renamed to Test by user",
        at: "2026-09-05T12:19:30.000Z",
        status: "completed",
        tools: [],
        sends: [],
      },
    ];

    expect(thread(messages)).toEqual([
      "user: first",
      "assistant: first reply",
      "system: Renamed to Test by user",
      "user: second",
    ]);
  });
});
