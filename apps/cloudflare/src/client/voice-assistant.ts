// The browser end of the app-wide Voice assistant socket. Provider vocabulary
// and credentials stay behind the VoiceSession Durable Object; this module
// only decodes the stable browser protocol and carries PCM frames.
import {
  parseVoiceAssistantServerFrameV1,
  VOICE_ASSISTANT_VERSION_V1,
  type VoiceAssistantClientFrameV1,
} from "@frockbot/protocol";
import type {
  VoiceAssistantObserverV1,
  VoiceAssistantSessionV1,
} from "@frockbot/client-core";

export const VOICE_ASSISTANT_ROUTE_V1 = "/api/voice/assistant";

export interface VoiceAssistantRuntimeV1 {
  origin(): string;
  createSocket(url: string): WebSocket;
}

function browserRuntime(): VoiceAssistantRuntimeV1 {
  return {
    origin: () => window.location.origin,
    createSocket: (url) => new WebSocket(url),
  };
}

export function voiceAssistantUrlV1(origin: string, deviceId: string): string {
  const url = new URL(VOICE_ASSISTANT_ROUTE_V1, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("version", String(VOICE_ASSISTANT_VERSION_V1));
  url.searchParams.set("device", deviceId);
  return url.toString();
}

export function openVoiceAssistantV1(
  deviceId: string,
  observer: VoiceAssistantObserverV1,
  runtime: VoiceAssistantRuntimeV1 = browserRuntime(),
): VoiceAssistantSessionV1 {
  const socket = runtime.createSocket(
    voiceAssistantUrlV1(runtime.origin(), deviceId),
  );
  socket.binaryType = "arraybuffer";
  const pending: ArrayBuffer[] = [];
  let ready = false;
  let finished = false;

  socket.addEventListener("message", (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) {
      if (!finished) observer.audio(event.data);
      return;
    }
    if (typeof event.data !== "string") return;
    let frame;
    try {
      frame = parseVoiceAssistantServerFrameV1(event.data);
    } catch {
      return;
    }
    switch (frame.type) {
      case "ready":
        ready = true;
        for (const audio of pending.splice(0)) socket.send(audio);
        observer.ready(frame.sessionId, frame.quotaRemainingSeconds);
        return;
      case "state":
        observer.state(frame.state);
        return;
      case "transcript":
        observer.transcript(frame);
        return;
      case "tool":
        observer.tool(frame);
        return;
      case "interrupted":
        observer.interrupted();
        return;
      case "offline":
        finished = true;
        observer.offline(frame.reason, frame.message);
        return;
    }
  });
  socket.addEventListener("error", () => {
    if (finished) return;
    finished = true;
    observer.failed("Voice lost its connection. Try turning it on again.");
  });
  socket.addEventListener("close", () => observer.closed());

  const control = (frame: VoiceAssistantClientFrameV1): void => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(frame));
  };

  return {
    sendAudio(pcm16) {
      if (finished) return;
      if (!ready) {
        // About ten seconds at 16 kHz; a stalled server cannot grow this list.
        if (pending.length < 320) pending.push(pcm16);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(pcm16);
    },
    stop() {
      control({ schemaVersion: 1, type: "stop" });
    },
    close() {
      try {
        socket.close(1000, "Voice client closed");
      } catch {
        // Closing an already closed socket is a no-op from the caller's view.
      }
    },
  };
}
