import { describe, expect, test } from "bun:test";

import {
  LOCAL_MODEL_DROPPED_V1,
  LOCAL_MODEL_OFFLINE_V1,
  type MachineRelayCancelFrameV1,
  type MachineRelayFrameV1,
} from "@frockbot/core/machine-protocol";

import { MachineModelRelaysV1 } from "./model-relay.js";

function harness(connected = true) {
  const pushed: {
    machineId: string;
    frame: MachineRelayFrameV1 | MachineRelayCancelFrameV1;
  }[] = [];
  const relays = new MachineModelRelaysV1({
    connected: () => connected,
    push: (machineId, frame) => pushed.push({ machineId, frame }),
    now: () => Date.parse("2026-09-30T00:00:00.000Z"),
  });
  return { relays, pushed };
}

const request = {
  machineId: "mac-1",
  relayId: "chat:req-1",
  method: "POST" as const,
  url: "http://localhost:11434/v1/chat/completions",
  body: "{}",
  firstByteMs: 60_000,
};

describe("local model relays", () => {
  test("an offline Mac is refused before anything is sent", async () => {
    const { relays, pushed } = harness(false);
    await expect(relays.open(request)).rejects.toThrow(LOCAL_MODEL_OFFLINE_V1);
    expect(pushed).toEqual([]);
  });

  test("streams what the Mac sends back as a response", async () => {
    const { relays, pushed } = harness();
    const answer = relays.open(request);
    expect(pushed).toEqual([
      {
        machineId: "mac-1",
        frame: {
          type: "relay",
          relayId: "chat:req-1",
          method: "POST",
          url: "http://localhost:11434/v1/chat/completions",
          body: "{}",
          deadline: "2026-09-30T00:01:00.000Z",
          serverTime: "2026-09-30T00:00:00.000Z",
        },
      },
    ]);
    relays.receive("mac-1", {
      type: "relay-head",
      relayId: "chat:req-1",
      status: 200,
      contentType: "text/event-stream",
    });
    const response = await answer;
    relays.receive("mac-1", {
      type: "relay-data",
      relayId: "chat:req-1",
      data: "data: hi\n\n",
    });
    relays.receive("mac-1", { type: "relay-end", relayId: "chat:req-1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: hi\n\n");
    expect(relays.size).toBe(0);
  });

  test("another Mac cannot answer this Mac's relay", async () => {
    const { relays } = harness();
    const answer = relays.open(request);
    relays.receive("mac-2", {
      type: "relay-fail",
      relayId: "chat:req-1",
      error: "spoofed",
    });
    expect(relays.size).toBe(1);
    relays.receive("mac-1", {
      type: "relay-fail",
      relayId: "chat:req-1",
      error: "Nothing is answering at localhost:11434 on this Mac.",
    });
    await expect(answer).rejects.toThrow("Nothing is answering");
  });

  test("a Mac that drops before answering is offline", async () => {
    const { relays } = harness();
    const answer = relays.open(request);
    relays.closed("mac-1");
    await expect(answer).rejects.toThrow(LOCAL_MODEL_OFFLINE_V1);
  });

  test("a Mac that drops mid-answer fails the stream", async () => {
    const { relays } = harness();
    const answer = relays.open(request);
    relays.receive("mac-1", {
      type: "relay-head",
      relayId: "chat:req-1",
      status: 200,
    });
    const response = await answer;
    relays.closed("mac-1");
    await expect(response.text()).rejects.toThrow(LOCAL_MODEL_DROPPED_V1);
  });

  test("a consumer that stops reading cancels the Mac's request", async () => {
    const { relays, pushed } = harness();
    const answer = relays.open(request);
    relays.receive("mac-1", {
      type: "relay-head",
      relayId: "chat:req-1",
      status: 200,
    });
    const response = await answer;
    await response.body!.cancel();
    expect(pushed.at(-1)).toEqual({
      machineId: "mac-1",
      frame: { type: "relay-cancel", relayId: "chat:req-1" },
    });
    expect(relays.size).toBe(0);
  });

  test("no head by the deadline cancels and says so", async () => {
    const { relays, pushed } = harness();
    const answer = relays.open({ ...request, firstByteMs: 5 });
    await expect(answer).rejects.toThrow(/didn't start answering in time/);
    expect(pushed.at(-1)!.frame).toEqual({
      type: "relay-cancel",
      relayId: "chat:req-1",
    });
  });

  test("the same relay id twice is refused", async () => {
    const { relays } = harness();
    const first = relays.open(request);
    await expect(relays.open(request)).rejects.toThrow(/already running/);
    relays.closed("mac-1");
    await first.catch(() => undefined);
  });
});
