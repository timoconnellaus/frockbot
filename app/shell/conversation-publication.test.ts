import { describe, expect, test } from "bun:test";
import { visiblePublicationsV1 } from "./conversation-publication.js";
import type { StoredRunV1 } from "@frockbot/core/durable";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { SessionEvent } from "@frockbot/core/contracts";

function run(events: SessionEvent[]): StoredRunV1<BotSettingsViewV1> {
  return {
    runId: "run-1",
    sessionId: "user-1:scout",
    status: "running",
    phase: "model",
    input: "hi",
    events,
    previousEventCount: 0,
    configurationSnapshot: {} as BotSettingsViewV1,
  } as unknown as StoredRunV1<BotSettingsViewV1>;
}

describe("visiblePublicationsV1", () => {
  test("one ordinary send is one message entity", () => {
    const send = {
      type: "send/to-user",
      seq: 0,
      timestamp: "2026-09-22T00:00:00.000Z",
      occurrenceId: "occ-1",
      payload: { type: "text", text: "Hello" },
    } as unknown as SessionEvent;
    const contributions = visiblePublicationsV1({
      cause: "events",
      run: run([send]),
      events: [send],
    });
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      kind: "message",
      entityId: "msg:user-1:scout:run-1:occ-1",
    });
  });

  test("a card send also publishes a card-revision for the same surface", () => {
    const send = {
      type: "send/to-user",
      seq: 0,
      timestamp: "2026-09-22T00:00:00.000Z",
      occurrenceId: "occ-card",
      payload: { type: "card", surfaceId: "surface-1", messages: [] },
    } as unknown as SessionEvent;
    const contributions = visiblePublicationsV1({
      cause: "events",
      run: run([send]),
      events: [send],
    });
    expect(contributions.map((item) => item.kind)).toEqual([
      "message",
      "card-revision",
    ]);
    expect(contributions[1]).toMatchObject({
      entityId: "card:surface-1",
      payload: { surfaceId: "surface-1", revision: 0 },
    });
  });

  test("private model chunks are not a visible contribution", () => {
    const chunk = {
      type: "model/request",
      seq: 0,
      timestamp: "2026-09-22T00:00:00.000Z",
      occurrenceId: "occ-model",
    } as unknown as SessionEvent;
    expect(
      visiblePublicationsV1({
        cause: "events",
        run: run([chunk]),
        events: [chunk],
      }),
    ).toEqual([]);
  });
});
