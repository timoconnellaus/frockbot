import { describe, expect, test } from "bun:test";
import {
  openVoiceAssistantV1,
  voiceAssistantUrlV1,
  type VoiceAssistantRuntimeV1,
} from "./voice-assistant.js";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  sent: unknown[] = [];
  send(value: unknown): void {
    this.sent.push(value);
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("Voice assistant browser transport", () => {
  test("builds the versioned per-device socket URL", () => {
    expect(voiceAssistantUrlV1("https://bot.example", "device-1")).toBe(
      "wss://bot.example/api/voice/assistant?version=1&device=device-1",
    );
  });

  test("buffers 16 kHz PCM until ready and decodes server events", () => {
    const socket = new FakeSocket();
    const events: string[] = [];
    const runtime: VoiceAssistantRuntimeV1 = {
      origin: () => "http://localhost:8787",
      createSocket: () => socket as unknown as WebSocket,
    };
    const session = openVoiceAssistantV1(
      "device-1",
      {
        ready(id, remaining) {
          events.push(`ready:${id}:${remaining}`);
        },
        state(value) {
          events.push(value);
        },
        transcript(entry) {
          events.push(entry.text);
        },
        tool(entry) {
          events.push(entry.label);
        },
        audio() {
          events.push("audio");
        },
        interrupted() {
          events.push("interrupted");
        },
        offline(reason) {
          events.push(reason);
        },
        failed(message) {
          events.push(message);
        },
        closed() {
          events.push("closed");
        },
      },
      runtime,
    );
    const audio = new ArrayBuffer(4);
    session.sendAudio(audio);
    expect(socket.sent).toEqual([]);
    socket.receive(
      JSON.stringify({
        schemaVersion: 1,
        type: "ready",
        sessionId: "session-1",
        quotaRemainingSeconds: 42,
      }),
    );
    expect(socket.sent).toEqual([audio]);
    socket.receive(audio);
    socket.receive(JSON.stringify({ schemaVersion: 1, type: "interrupted" }));
    session.stop();
    expect(events).toEqual(["ready:session-1:42", "audio", "interrupted"]);
    expect(socket.sent.at(-1)).toBe('{"schemaVersion":1,"type":"stop"}');
  });
});
