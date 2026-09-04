// The browser end of the composer's dictation socket.
//
// Thin on purpose. Everything that decides anything — the quota, the
// credential, the provider's vocabulary — is on the far side of this socket in
// the `VoiceSession` Durable Object; this is the wire and the decode, and the
// composer above it never sees a raw frame.
import {
  parseVoiceDictationServerFrameV1,
  VOICE_DICTATION_VERSION_V1,
  type VoiceDictationClientFrameV1,
} from "@frockbot/protocol";
import type {
  VoiceDictationObserverV1,
  VoiceDictationSessionV1,
} from "@frockbot/client-core";

export const VOICE_DICTATION_ROUTE_V1 = "/api/voice/dictation";

export interface VoiceDictationRuntimeV1 {
  origin(): string;
  createSocket(url: string): WebSocket;
}

function browserRuntime(): VoiceDictationRuntimeV1 {
  return {
    origin: () => window.location.origin,
    createSocket: (url) => new WebSocket(url),
  };
}

export function voiceDictationUrlV1(origin: string): string {
  const url = new URL(VOICE_DICTATION_ROUTE_V1, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("version", String(VOICE_DICTATION_VERSION_V1));
  return url.toString();
}

/**
 * Opens one dictation session.
 *
 * Returns immediately: the composer shows the capture the moment the person
 * presses the button and audio is buffered until `ready` arrives, so a slow
 * upstream costs the first syllable rather than the whole utterance.
 */
export function openVoiceDictationV1(
  observer: VoiceDictationObserverV1,
  runtime: VoiceDictationRuntimeV1 = browserRuntime(),
): VoiceDictationSessionV1 {
  const socket = runtime.createSocket(voiceDictationUrlV1(runtime.origin()));
  socket.binaryType = "arraybuffer";
  const pending: ArrayBuffer[] = [];
  let ready = false;
  let finished = false;

  const control = (frame: VoiceDictationClientFrameV1): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  };

  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let frame;
    try {
      frame = parseVoiceDictationServerFrameV1(event.data);
    } catch {
      // A frame this client cannot read is one a newer server sent; ignoring
      // it is what keeps an older tab dictating rather than failing.
      return;
    }
    switch (frame.type) {
      case "ready":
        ready = true;
        // Whatever was said before the upstream answered still counts.
        for (const chunk of pending.splice(0)) socket.send(chunk);
        observer.ready();
        return;
      case "delta":
        observer.delta(frame.text);
        return;
      case "transcript":
        observer.transcript(frame.text);
        return;
      case "final":
        finished = true;
        observer.final();
        return;
      case "error":
        finished = true;
        observer.failed(frame.message);
        return;
    }
  });
  socket.addEventListener("error", () => {
    if (finished) return;
    finished = true;
    observer.failed("The dictation connection dropped. Try again in a moment.");
  });
  socket.addEventListener("close", () => {
    observer.closed();
  });

  return {
    sendAudio(pcm16) {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!ready) {
        // Bounded: about ten seconds of 24 kHz PCM16 at the worklet's frame
        // size. A server that never says `ready` must not grow this forever.
        if (pending.length < 320) pending.push(pcm16);
        return;
      }
      socket.send(pcm16);
    },
    commit() {
      control({ schemaVersion: 1, type: "commit" });
    },
    cancel() {
      control({ schemaVersion: 1, type: "cancel" });
    },
    close() {
      try {
        socket.close(1000, "dictation ended");
      } catch {
        // Already closed.
      }
    },
  };
}
