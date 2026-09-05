// The outbound seam for the integration project, and inside it a scriptable
// Gemini Live stand-in.
//
// Why a Worker rather than the Node-side function `createOutboundService`
// returns: a WebSocket upgrade cannot be answered from Node under this pool —
// `WebSocketPair` lives in workerd. The voice transport reaches its provider
// with the global `fetch`, so the only way to put a fake provider in front of
// a Durable Object without editing the Durable Object is to make the outbound
// itself a Worker. Everything that is not the voice upstream is handed
// straight back to the Node-side stub through a service binding, so the MCP,
// Composio and Ollama fakes behave exactly as they did before.
import type { AuxiliaryWorkerOptionsV1 } from "./frock-ai-fake.ts";

/** The service name `outboundService` points at. */
export const VOICE_UPSTREAM_FAKE_NAME = "voice-upstream-fake";

/** The host the fake answers on. Nothing resolves it; the outbound seam does. */
export const VOICE_UPSTREAM_FAKE_HOST = "voice-upstream.frockbot.test";

/**
 * The URL the integration Worker is configured with.
 *
 * `frock_ready_ms` shortens the transport's ready deadline the same way
 * `frock_idle_ms` shortens its silence ceiling: a test that must watch a
 * deadline expire cannot wait the production twenty seconds.
 */
export const VOICE_ASSISTANT_FAKE_UPSTREAM_URL = `ws://${VOICE_UPSTREAM_FAKE_HOST}/v1/gemini-live?frock_ready_ms=2000&frock_idle_ms=20000`;

/**
 * How the fake answers the next setup it is sent.
 *
 * - `stale-handle` — the shape Gemini takes when a stored resumption handle
 *   has expired: it closes the socket instead of answering, and answers
 *   normally as soon as a setup arrives without one.
 * - `silent` — accepts the socket, answers nothing, closes nothing.
 * - `closing` — closes on every setup, handle or not.
 * - `ready` — answers every setup.
 */
export type VoiceUpstreamFakeModeV1 =
  "ready" | "stale-handle" | "silent" | "closing";

/** Where a test sets the mode. Reached with the ordinary global `fetch`. */
export function voiceUpstreamFakeModeUrl(
  mode: VoiceUpstreamFakeModeV1,
): string {
  return `http://${VOICE_UPSTREAM_FAKE_HOST}/__fake/mode?mode=${mode}`;
}

/** What the fake has been sent, so a test can prove the second setup dropped the handle. */
export function voiceUpstreamFakeSetupsUrl(): string {
  return `http://${VOICE_UPSTREAM_FAKE_HOST}/__fake/setups`;
}

/** One recorded setup, as the transport sent it. */
export interface VoiceUpstreamFakeSetupV1 {
  handle?: string;
}

const SCRIPT = `
const HOST = ${JSON.stringify(VOICE_UPSTREAM_FAKE_HOST)};

let mode = "ready";
let setups = [];

function geminiLive() {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  server.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || !message.setup) return;
    const handle = message.setup.sessionResumption?.handle;
    setups.push(handle ? { handle } : {});
    if (mode === "silent") return;
    if (mode === "closing" || (mode === "stale-handle" && handle)) {
      // Gemini rejects an expired handle by closing, not by answering.
      server.close(1011, "session resumption refused");
      return;
    }
    server.send(JSON.stringify({ setupComplete: {} }));
    server.send(
      JSON.stringify({
        sessionResumptionUpdate: {
          resumable: true,
          newHandle: "integration-resumption-handle",
        },
      }),
    );
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === HOST) {
      if (url.pathname === "/__fake/mode") {
        mode = url.searchParams.get("mode") ?? "ready";
        setups = [];
        return Response.json({ mode });
      }
      if (url.pathname === "/__fake/setups") {
        return Response.json({ setups });
      }
      if (
        url.pathname === "/v1/gemini-live" &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        return geminiLive();
      }
      return new Response("Not found", { status: 404 });
    }
    return env.OUTBOUND.fetch(request);
  },
};
`;

/**
 * The auxiliary Worker, plus the Node-side outbound stub behind it.
 *
 * `outbound` is the same function the hermetic project binds directly; here it
 * sits one hop further out so the voice host can be peeled off in front of it.
 */
export function createVoiceUpstreamFakeWorker(
  compatibilityDate: string,
  outbound: (request: Request) => Promise<Response>,
): AuxiliaryWorkerOptionsV1 {
  return {
    name: VOICE_UPSTREAM_FAKE_NAME,
    modules: true,
    script: SCRIPT,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    serviceBindings: { OUTBOUND: outbound },
  };
}
