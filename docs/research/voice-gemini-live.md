# Gemini Live protocol notes for Voice B1

## Status

Researched against Google and Cloudflare's official documentation on 2026-09-04. This note records the wire-level facts needed by Voice B1 and calls out three inconsistencies in the current vendor docs.

## Decision-ready summary

- The current model code is **`gemini-3.1-flash-live-preview`**, and the raw setup message names it as `models/gemini-3.1-flash-live-preview`. There is no documented `gemini-3.1-flash-live` alias. The model is preview, supports the Live API and synchronous function calling, and has a 131,072-token input limit. [Gemini 3.1 Flash Live Preview model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)
- Direct server-to-server connections use the `v1beta` endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=...`. The API key therefore remains on the Worker/DO side. [Raw WebSocket quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [WebSocket API reference](https://ai.google.dev/api/live)
- Audio is mono raw little-endian signed **PCM16**. Input should be native **16 kHz** and sent as `audio/pcm;rate=16000`; output is always **24 kHz PCM16**. Google recommends small input chunks (20–100 ms) for latency. [Live API capabilities: audio formats](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)
- Native-audio models support `AUDIO` as the response modality; transcripts are obtained by enabling input/output audio transcription rather than requesting a simultaneous text modality. [Live API capabilities: limitations](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- For Cloudflare AI Gateway realtime Google AI Studio traffic, the only documented WebSocket route is **`wss://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google`**, not `/google-ai-studio`. With a provider key in the request, Cloudflare's example appends `?api_key=<google_api_key>`. With BYOK, omit the provider key but still authenticate the gateway with `cf-aig-authorization`. [Cloudflare Realtime WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/) · [Cloudflare BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

## Setup and message flow

The first and only first client message is `setup`; wait for top-level `setupComplete` before sending audio, text, or tool responses. A setup matching the API reference is:

```json
{
  "setup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "generationConfig": {
      "responseModalities": ["AUDIO"]
    },
    "systemInstruction": {
      "parts": [{ "text": "..." }]
    },
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "list_bots",
            "description": "...",
            "parameters": { "type": "OBJECT", "properties": {} }
          }
        ]
      }
    ],
    "realtimeInputConfig": {
      "automaticActivityDetection": { "disabled": false },
      "activityHandling": "START_OF_ACTIVITY_INTERRUPTS"
    },
    "inputAudioTranscription": {},
    "outputAudioTranscription": {},
    "sessionResumption": {},
    "contextWindowCompression": { "slidingWindow": {} }
  }
}
```

`model`, `generationConfig`, `systemInstruction`, `tools`, `realtimeInputConfig`, transcription, resumption, and context compression are fields of `BidiGenerateContentSetup`. The setup is immutable for an open connection. On a resumed connection all setup parameters except the model may change. [WebSocket API reference](https://ai.google.dev/api/live)

Send captured audio as base64 in:

```json
{
  "realtimeInput": {
    "audio": {
      "data": "<base64 PCM16LE>",
      "mimeType": "audio/pcm;rate=16000"
    }
  }
}
```

Audio responses arrive as base64 `serverContent.modelTurn.parts[*].inlineData.data`. Gemini 3.1 may put multiple parts in one server-content event, so every part must be processed rather than only index zero. Use `serverContent.generationComplete` to mark generation finished and `serverContent.turnComplete` to mark the turn finished. [Raw WebSocket quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [Gemini 3.1 migration notes](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) · [WebSocket API reference](https://ai.google.dev/api/live)

For Gemini 3.1, ordinary text during a live conversation belongs in `realtimeInput.text`. `clientContent` is reserved for initial-history seeding when `historyConfig.initialHistoryInClientContent` is enabled. Therefore B1's kickoff text should be sent through `realtimeInput.text` after `setupComplete`, unless it is deliberately supplied as seeded history. [Gemini 3.1 migration notes](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) · [WebSocket API reference](https://ai.google.dev/api/live)

Gemini 3.1 Flash Live does not support `proactivity.proactiveAudio`. “Speak first” must therefore be implemented with that explicit kickoff text, not proactive-audio configuration. [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

## Transcription

Enable transcripts by including both empty configs in setup:

```json
{
  "inputAudioTranscription": {},
  "outputAudioTranscription": {}
}
```

Stable transcript events are `serverContent.inputTranscription` and `serverContent.outputTranscription`, each with `text` and `languageCode`. Input transcription is independent of other server messages and has no guaranteed ordering. The final output transcription is sent before `generationComplete` or `interrupted`, but exact ordering against audio/model parts is not guaranteed, so transcript assembly must be event-driven rather than index-correlated. The reference also exposes frequently updated `serverContent.interimInputTranscription`; it should be treated as optional unless the selected model is observed emitting it. [Live API transcription examples](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [WebSocket API reference](https://ai.google.dev/api/live)

## Automatic VAD, interruption, and playback

Automatic activity detection is enabled by default on continuous realtime audio. Explicitly retaining `automaticActivityDetection.disabled: false` is valid. Its sensitivity, prefix padding, and silence duration are configurable, but Google's current quality guidance recommends roughly 500–800 ms of silence and says the server default is about 800 ms. [Live API capabilities: VAD](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

`realtimeInputConfig.activityHandling` defaults to `START_OF_ACTIVITY_INTERRUPTS`: detected user activity cuts off the model's current response (barge-in). On `serverContent.interrupted: true`, stop playback and empty all queued 24 kHz audio immediately. Interrupted turns do not emit `generationComplete`; they proceed through `interrupted` and then `turnComplete`. A top-level `toolCallCancellation.ids` may also cancel calls issued in the interrupted server turn. [WebSocket API reference](https://ai.google.dev/api/live) · [Live API capabilities: VAD](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

When server VAD remains enabled and microphone audio pauses for more than a second or is switched off, send `{ "realtimeInput": { "audioStreamEnd": true } }` to flush buffered audio. Sending later audio reopens that input stream. Do not send manual `activityStart`/`activityEnd` unless automatic detection is disabled. [Live API capabilities: automatic VAD](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [WebSocket API reference](https://ai.google.dev/api/live)

## Functions and tool responses

Function declarations are supplied under `setup.tools[].functionDeclarations`. Gemini emits:

```json
{
  "toolCall": {
    "functionCalls": [{ "id": "call-id", "name": "list_bots", "args": {} }]
  }
}
```

After bounded local execution, return the same `id` and `name` through the dedicated bidi tool-response message:

```json
{
  "toolResponse": {
    "functionResponses": [
      {
        "id": "call-id",
        "name": "list_bots",
        "response": { "result": {} }
      }
    ]
  }
}
```

The Live API does not execute or respond to custom functions automatically. Gemini 3.1 Flash Live supports only synchronous function calling: generation waits until the matching response is returned. Multiple calls can appear in one event, and each response is matched by `id`. [Tool use with Live API](https://ai.google.dev/gemini-api/docs/live-api/tools) · [Raw WebSocket quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [WebSocket API reference](https://ai.google.dev/api/live)

## Resumption, reconnects, and limits

Including `setup.sessionResumption` asks the server to emit top-level `sessionResumptionUpdate` events. Retain the latest update for which `resumable` is true and `newHandle` is non-empty. Reconnect with:

```json
{
  "setup": {
    "model": "models/gemini-3.1-flash-live-preview",
    "sessionResumption": { "handle": "<latest newHandle>" }
  }
}
```

Resumption is temporarily unavailable while the model is generating or executing functions; those updates have `resumable: false` and an empty handle. Reusing an older handle from such a point can lose subsequent data, so persist only positive updates and reconcile any in-flight transcript/tool state after reconnect. Current session-management documentation says handles remain valid for **2 hours after the session terminates**. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) · [WebSocket API reference](https://ai.google.dev/api/live)

Gemini sends top-level `goAway.timeLeft` before terminating a connection as `ABORTED`. Open a replacement socket before the deadline and supply the latest resumable handle. The documented connection lifetime is about **10 minutes**. Without context compression, an audio-only session is limited to **15 minutes** (audio plus video: 2 minutes); sliding-window context compression allows extension without a fixed session-duration limit. Native-audio sessions have a 128k context window. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) · [Live API capabilities: limitations](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [Live API best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)

For an unexpected socket close, establish a new socket and send the same setup with the most recent valid handle. The protocol does not promise replay of client audio or tool effects that were in flight after that handle; callers must not blindly duplicate those inputs/effects. This last sentence is an implementation inference from Google's warning that resuming an earlier handle during a non-resumable point can lose data. [WebSocket API reference](https://ai.google.dev/api/live)

## Cloudflare AI Gateway BYOK

Cloudflare's realtime Google AI Studio example uses:

```text
wss://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google
```

For a server/Worker request, authenticate the gateway with the HTTP header `cf-aig-authorization: Bearer <Cloudflare token>`. Cloudflare also documents a browser-only WebSocket subprotocol form, `cf-aig-authorization.<token>`, but Voice B1 must not put this credential in the browser. If Google credentials are not stored with BYOK, Cloudflare's realtime example passes the provider key as `?api_key=<google_api_key>`. With BYOK configured, remove the provider credential and retain `cf-aig-authorization`; the default BYOK alias is selected unless `cf-aig-byok-alias` is supplied. [Cloudflare Realtime WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/) · [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) · [Cloudflare BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

## Vendor-document ambiguities to test

1. **Gateway path conflict.** Cloudflare documents `/google` for realtime Google AI Studio WebSockets. It documents `/google-ai-studio` only as the base path for provider-native HTTP/REST calls. No official source found documents `wss://.../google-ai-studio` for realtime traffic. B1 should use `/google` or retain a fake/configurable upstream seam until a real gateway smoke test proves another path. [Realtime WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/) · [Google AI Studio provider endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/)
2. **Raw setup placement conflict.** Google's WebSocket API schema, official protocol definition, official Go SDK serialization test, and Cloudflare's realtime example place `responseModalities` inside `setup.generationConfig`, while Google's raw-WebSocket quickstart currently places it directly under `setup`. The schema is the stronger contract, so B1 should emit `generationConfig: { responseModalities: ["AUDIO"] }` and cover the exact setup JSON in its fake/integration test. [WebSocket API reference](https://ai.google.dev/api/live) · [Google Generative Language protocol definition](https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/generative_service.proto) · [Google Go SDK Live API test](https://github.com/googleapis/go-genai/blob/main/live_test.go) · [Raw WebSocket quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) · [Cloudflare Realtime WebSockets API](https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/)
3. **Handle naming typo.** The API reference's `SessionResumptionConfig` prose says handles come from `SessionResumptionUpdate.token`, but the actual response field documented immediately below is `newHandle`, and the session-management examples use `newHandle`. Decode and persist `newHandle`. [WebSocket API reference](https://ai.google.dev/api/live) · [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
