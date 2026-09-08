import { expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import type { SendToUserPayloadV1 } from "@frockbot/core/contracts";
import { createNotification } from "./bot.js";

const settings = initializeBotSettingsV1("Bob");

test("private model text without a send creates no reply notification", () => {
  expect(
    createNotification(settings, {
      runId: "run",
      text: "private model text",
      events: [],
    }),
  ).toBeUndefined();
});

const payloads: SendToUserPayloadV1[] = [
  { type: "text", text: "Delivered answer" },
  {
    type: "widget",
    widget: {
      prompt: "Which option?",
      options: ["Continue"],
      allowCustom: true,
      dismissOnMoveOn: false,
    },
  },
];
for (const payload of payloads) {
  test(`an explicit ${payload.type} send notifies without copying model text`, () => {
    const notification = createNotification(settings, {
      runId: "run",
      text: "private model text",
      events: [
        {
          type: "send/to-user",
          seq: 0,
          timestamp: "2026-09-08T00:00:00.000Z",
          turn: 1,
          step: 1,
          occurrenceId: "tool:send",
          payload,
        },
      ],
    });
    expect(notification?.title).toBe("Bob replied");
    expect(notification?.body).toBe(
      payload.type === "text" ? payload.text : "",
    );
  });
}
