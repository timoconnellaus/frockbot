import { describe, expect, mock, test } from "bun:test";
import { deliverPendingVoiceNotificationsV1 } from "./pending-notifications.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const answer = {
  schemaVersion: 1 as const,
  answerId: "ask-1",
  botId: "research",
  botName: "Research",
  question: "What changed?",
  answer: "The release landed.",
  answeredAt: "2026-09-04T01:02:03.000Z",
};

describe("pending Voice notifications", () => {
  test("fires the client notification seam once per pending answer", async () => {
    const shared = storage();
    const notify = mock((_intent: { title: string; body: string }) =>
      Promise.resolve("web" as const),
    );

    expect(
      await deliverPendingVoiceNotificationsV1([answer], {
        storage: shared,
        notify,
      }),
    ).toBe(1);
    expect(
      await deliverPendingVoiceNotificationsV1([answer], {
        storage: shared,
        notify,
      }),
    ).toBe(0);
    expect(notify).toHaveBeenCalledWith({
      title: "Research answered",
      body: "The release landed.",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test("returns an unavailable notification claim for a later retry", async () => {
    const shared = storage();
    const notify = mock((_intent: { title: string; body: string }) =>
      Promise.resolve("unavailable" as const),
    );
    await deliverPendingVoiceNotificationsV1([answer], {
      storage: shared,
      notify,
    });
    await deliverPendingVoiceNotificationsV1([answer], {
      storage: shared,
      notify,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
