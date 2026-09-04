import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  E2E_DICTATED_TEXT_V1,
  E2E_DICTATION_FRAMES_PER_WORD_V1,
} from "./voice-fake-protocol.ts";

const encoder = new TextEncoder();
const reply =
  'data: {"choices":[{"delta":{"content":"Reply from the Frock AI stub."}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

class FrockAiGatewayFake extends RpcTarget {
  run(_request: Record<string, unknown>): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(reply));
          controller.close();
        },
      }),
    );
  }
}

/** Local RPC stand-in for the production AI Gateway binding. */
export class FrockAiFake extends WorkerEntrypoint {
  gateway(_gatewayId: string): FrockAiGatewayFake {
    return new FrockAiGatewayFake();
  }

  run(_model: string, _input: Record<string, unknown>): ReadableStream {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(reply));
        controller.close();
      },
    });
  }
}

/**
 * The name the deployed `frockbot-flock-ai-e2e` Worker was bound under before
 * the provider was renamed. An RPC entrypoint name is part of a deployed
 * Worker's surface, and this Worker and the app Worker that binds it are
 * deployed separately, so exporting both names means neither order of the two
 * deploys breaks the end-to-end environment. Remove it once the deployed
 * Worker is renamed.
 */
export { FrockAiFake as FlockAiFake };

/** Streamed a word at a time, so a spec can see text arrive mid-capture. */
const DICTATION_WORDS = E2E_DICTATED_TEXT_V1.split(" ").map(
  (word, index, all) => (index === all.length - 1 ? word : `${word} `),
);

/**
 * A fake OpenAI realtime **transcription** session (voice plan D3).
 *
 * The app Worker's `VoiceSession` object opens this instead of the real
 * upstream because the end-to-end environment sets `VOICE_UPSTREAM_URL`. It
 * speaks the provider's vocabulary, not FrockBot's: the point of the fake is
 * that the translation in `voice-upstream.ts` is the code under test, so the
 * frames here are the ones OpenAI documents.
 */
function fakeRealtimeTranscription(): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let frames = 0;
  let spoken = 0;
  server.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let message: { type?: unknown };
    try {
      message = JSON.parse(event.data) as { type?: unknown };
    } catch {
      return;
    }
    if (message.type === "transcription_session.update") {
      server.send(JSON.stringify({ type: "transcription_session.updated" }));
      return;
    }
    if (message.type === "input_audio_buffer.append") {
      frames += 1;
      const due = Math.min(
        DICTATION_WORDS.length,
        Math.floor(frames / E2E_DICTATION_FRAMES_PER_WORD_V1),
      );
      while (spoken < due) {
        server.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            delta: DICTATION_WORDS[spoken],
          }),
        );
        spoken += 1;
      }
      return;
    }
    if (message.type === "input_audio_buffer.commit") {
      server.send(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: E2E_DICTATED_TEXT_V1,
        }),
      );
      frames = 0;
      spoken = 0;
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (
      url.pathname === "/v1/realtime" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return fakeRealtimeTranscription();
    }
    return new Response("Frock AI fake speaks RPC only", { status: 404 });
  },
};
