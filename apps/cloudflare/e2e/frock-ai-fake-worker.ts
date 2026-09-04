import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  E2E_DICTATED_TEXT_V1,
  E2E_DICTATION_FRAMES_PER_WORD_V1,
  E2E_REALTIME_BETA_REMOVED_ERROR_V1,
  E2E_VOICE_ANSWER_V1,
  E2E_VOICE_INPUT_V1,
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
      server.send(
        JSON.stringify({
          type: "error",
          error: { message: E2E_REALTIME_BETA_REMOVED_ERROR_V1 },
        }),
      );
      return;
    }
    if (message.type === "session.update") {
      const session = (message as { session?: unknown }).session;
      const input =
        session &&
        typeof session === "object" &&
        (session as { type?: unknown }).type === "transcription"
          ? (session as { audio?: { input?: unknown } }).audio?.input
          : undefined;
      const valid =
        input !== null &&
        typeof input === "object" &&
        (input as { format?: { type?: unknown; rate?: unknown } }).format
          ?.type === "audio/pcm" &&
        (input as { format?: { rate?: unknown } }).format?.rate === 24_000 &&
        (input as { transcription?: { model?: unknown } }).transcription
          ?.model === "gpt-live-transcribe" &&
        (input as { turn_detection?: { type?: unknown } }).turn_detection
          ?.type === "server_vad";
      if (!valid) {
        server.send(
          JSON.stringify({
            type: "error",
            error: { message: "Invalid GA transcription session." },
          }),
        );
        return;
      }
      server.send(JSON.stringify({ type: "session.updated", session }));
      return;
    }
    if (message.type === "input_audio_buffer.append") {
      if (typeof (message as { audio?: unknown }).audio !== "string") {
        server.send(
          JSON.stringify({
            type: "error",
            error: { message: "Invalid GA audio append." },
          }),
        );
        return;
      }
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

/** Gemini Live vocabulary, kept deliberately stricter than the app protocol. */
function fakeGeminiLiveAssistant(): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let ready = false;
  let prompted = false;
  let heardAudio = false;

  const pcm = btoa(String.fromCharCode(0, 0, 0, 0));
  const answer = () => {
    server.send(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: pcm,
                },
              },
            ],
          },
          outputTranscription: { text: E2E_VOICE_ANSWER_V1 },
          turnComplete: true,
        },
      }),
    );
  };

  server.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.setup) {
      const setup = message.setup as {
        model?: unknown;
        generationConfig?: { responseModalities?: unknown };
        tools?: Array<{ functionDeclarations?: Array<{ name?: unknown }> }>;
        realtimeInputConfig?: { activityHandling?: unknown };
      };
      const names = setup.tools?.[0]?.functionDeclarations?.map(
        (declaration) => declaration.name,
      );
      const valid =
        setup.model === "models/gemini-3.1-flash-live-preview" &&
        Array.isArray(setup.generationConfig?.responseModalities) &&
        setup.generationConfig.responseModalities.includes("AUDIO") &&
        setup.realtimeInputConfig?.activityHandling ===
          "START_OF_ACTIVITY_INTERRUPTS" &&
        ["list_bots", "bot_activity", "memory_search", "pending_answers"].every(
          (name) => names?.includes(name),
        );
      if (!valid) {
        server.send(
          JSON.stringify({ error: { message: "Invalid Gemini setup." } }),
        );
        return;
      }
      ready = true;
      server.send(JSON.stringify({ setupComplete: {} }));
      server.send(
        JSON.stringify({
          sessionResumptionUpdate: {
            resumable: true,
            newHandle: "e2e-resumption-handle",
          },
        }),
      );
      return;
    }
    if ("realtimeInput" in message) {
      const input = message.realtimeInput as {
        text?: unknown;
        audio?: { data?: unknown; mimeType?: unknown };
      };
      if (typeof input.text === "string" && !prompted) {
        prompted = true;
        server.send(
          JSON.stringify({
            toolCall: {
              functionCalls: [
                { id: "pending-e2e", name: "pending_answers", args: {} },
              ],
            },
          }),
        );
        return;
      }
      if (
        ready &&
        !heardAudio &&
        typeof input.audio?.data === "string" &&
        input.audio.mimeType === "audio/pcm;rate=16000"
      ) {
        heardAudio = true;
        server.send(
          JSON.stringify({
            serverContent: { inputTranscription: { text: E2E_VOICE_INPUT_V1 } },
          }),
        );
        server.send(
          JSON.stringify({
            toolCall: {
              functionCalls: [{ id: "bots-e2e", name: "list_bots", args: {} }],
            },
          }),
        );
      }
      return;
    }
    if ("toolResponse" in message) {
      const response = message.toolResponse as {
        functionResponses?: Array<{ name?: unknown }>;
      };
      if (response.functionResponses?.[0]?.name === "list_bots") answer();
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
      if (request.headers.has("openai-beta")) {
        return new Response(E2E_REALTIME_BETA_REMOVED_ERROR_V1, {
          status: 400,
        });
      }
      return fakeRealtimeTranscription();
    }
    if (
      url.pathname === "/v1/gemini-live" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return fakeGeminiLiveAssistant();
    }
    return new Response("Frock AI fake speaks RPC only", { status: 404 });
  },
};
