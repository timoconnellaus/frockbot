# What the Gemini Live API actually does

Observed on 2026-09-17 against `models/gemini-3.8-live` through
`apps/cloudflare/test/voice-gemini-probe.ts`, which is run by hand and never
in CI. Everything below is a shape that came back off the wire, apart from the
few paragraphs that say they were not observed; where it contradicts
[ADR 0031](adr/0031-voice-gemini-live.md) the API wins and the contradiction
is called out. Re-run a scenario with
`bun apps/cloudflare/test/voice-gemini-probe.ts <name>`.

The endpoint is
`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`.
The key goes in the query string; there is no header auth on a browser-style
WebSocket, which is why the Durable Object holds the key.

## Framing

What comes back is **binary** WebSocket frames carrying JSON text, not text
frames. A Worker's outbound socket hands binary frames over as `Blob`s unless
it is told otherwise, and `TextDecoder` on a `Blob` throws — so the object sets
`socket.binaryType = "arraybuffer"` before it listens (`GeminiSessionV1.start`
in `apps/cloudflare/src/voice-assistant.ts`). A client that does not ask decodes
nothing: no `setupComplete` ever arrives, and the session goes with code
**1006** before it reaches `awake`.

The other direction has no such trap: our frames go up as text
(`socket.send(JSON.stringify(frame))`) and are accepted.

Observed 2026-09-18 through this Worker's own upstream socket, not through the
hand-run probe named above. The workerd regression is "bridges binary Live
messages both ways and meters what crossed"
(`apps/cloudflare/test/voice-assistant.workerd.ts`), whose fake upstream sends
binary for the same reason.

## Which models are live

`GET /v1beta/models` with `supportedGenerationMethods` containing
`bidiGenerateContent` returns, for our key: `gemini-3.8-live`,
`gemini-3.8-live-extended-thinking`, `gemini-3.1-flash-live-preview`,
`gemini-3.5-transcribe-live`, `gemini-3.5-live-translate-preview`,
`gemini-2.5-flash-native-audio-*`, `gemini-robotics-er-2-streaming-preview`.

## Setup

Accepted, with everything we need in one frame:

```json
{"setup":{
  "model":"models/gemini-3.8-live",
  "generationConfig":{
    "responseModalities":["AUDIO"],
    "speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"Puck"}}}},
  "systemInstruction":{"parts":[{"text":"…"}]},
  "outputAudioTranscription":{},
  "inputAudioTranscription":{},
  "sessionResumption":{},
  "realtimeInputConfig":{"automaticActivityDetection":{"disabled":false}},
  "tools":[{"googleSearch":{}},{"functionDeclarations":[…]}]}}
```

The server answers `{"setupComplete":{}}` and, unprompted, a first
`sessionResumptionUpdate`. `googleSearch` and `functionDeclarations` coexist
in one `tools` array as two entries.

An unknown field closes the socket immediately with code **1007** and a
readable reason (`Invalid JSON payload received. Unknown name "x" at 'setup'`).
That is the only error channel: there is no `error` message type.

### `contextWindowCompression` is sent in production but has not been probed

`buildGeminiLiveSetupV1` (`app/voice/gemini-live.ts`) adds one setup field to
every frame it builds — `"contextWindowCompression":{"slidingWindow":{}}`, so
a long audio conversation stays inside the context window rather than losing
its earliest turns. No probe run has sent it, so the shape here is the
documented `BidiGenerateContentSetup.contextWindowCompression.slidingWindow`
rather than one observed from this codebase, and the server picks the window
size. The failure to watch for is the deferred one `enableAffectiveDialog`
showed: setup accepted, then the first content frame closes with 1007 — a
rejected setup field costs every call rather than failing at review time. The
`compression` scenario sends it; run
`bun apps/cloudflare/test/voice-gemini-probe.ts compression` and replace this
paragraph with what comes back.

### `enableAffectiveDialog` is not usable here — ADR contradicted

- At the top level of `setup` it is rejected outright: `1007 Unknown name
"enableAffectiveDialog" at 'setup'`.
- Inside `generationConfig` the setup is **accepted** — and then the first
  content frame of the session closes the socket with `1007 Request contains
an invalid argument.` The failure is deferred, so a setup-only check passes
  and a real call dies on the person's first word.

So `gemini-3.8-live` does not take affective dialog. ADR 0031 decision 1
first said "affective dialog on" and now records this finding; we do not send
the field. Delivery goes through the persona prose instead, which is where
the ADR already puts accent, pace and attitude.

### `speechConfig.languageCode` is accepted — ADR contradicted, harmlessly

ADR 0031 first said native audio rejects `languageCode`. It does not: setup
is accepted and the turn completes normally with it set to `en-US`. We still
do not send it (the ADR's decision — language is pinned in prose, which also
covers accent); the ADR now gives that as the reason.

## A text turn

`clientContent` requires `role` on each turn. Without it the socket closes
`1007 Request contains an invalid argument.`; `contents` instead of `turns`
closes with `Unknown name "contents" at 'client_content'`.

```json
{
  "clientContent": {
    "turns": [{ "role": "user", "parts": [{ "text": "Say hello." }] }],
    "turnComplete": true
  }
}
```

`{"clientContent":{"turnComplete":true}}` on its own is also accepted and
makes the model speak unprompted — that is the "say your opening line" frame.
`{"realtimeInput":{"text":"…"}}` works too and needs no role.

## What comes back

Bare `{}` frames arrive between content frames, often many in a row. They
carry nothing and must be ignored rather than treated as malformed.

Audio, one part per frame, always 24 kHz — matching the client's downstream
rate, so nothing is resampled:

```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [
        {
          "inlineData": {
            "mimeType": "audio/pcm;rate=24000",
            "data": "<base64 pcm16le>"
          }
        }
      ],
      "role": "model"
    }
  }
}
```

Transcription rides on the same `serverContent` envelope, in fragments:

```json
{"serverContent":{"outputTranscription":{"text":"Hello, I am ready "}}}
{"serverContent":{"inputTranscription":{"text":"¿Qué?"}}}
```

Turn boundaries are two separate frames, in this order:

```json
{"serverContent":{"generationComplete":true}}
{"serverContent":{"turnComplete":true},"usageMetadata":{…}}
```

`generationComplete` fires when the model stops generating; `turnComplete`
when the turn is closed out. Both can be absent from a turn that is
interrupted, so neither alone is a reliable "the model finished" signal —
`switch_bot` waits for whichever arrives first.

`usageMetadata` is a **sibling** of `serverContent`, not a child:

```json
{
  "usageMetadata": {
    "promptTokenCount": 550,
    "responseTokenCount": 49,
    "totalTokenCount": 599,
    "promptTokensDetails": [
      { "modality": "TEXT", "tokenCount": 320 },
      { "modality": "AUDIO", "tokenCount": 205 }
    ],
    "responseTokensDetails": [{ "modality": "AUDIO", "tokenCount": 49 }],
    "thoughtsTokenCount": 71
  }
}
```

It is tokens, not seconds, and it arrives only at turn end — so it cannot be
the meter. The ledger counts bridged bytes instead.

## Audio in

`{"realtimeInput":{"audio":{"data":"<b64>","mimeType":"audio/pcm;rate=16000"}}}`
is accepted at the phone's 200 ms cadence with no acknowledgement of any kind.
`{"realtimeInput":{"audioStreamEnd":true}}` is accepted.

A synthetic tone is not speech, so automatic VAD ignores it: a probe cannot
produce a barge-in by flooding audio. Manual activity can:

- `setup.realtimeInputConfig.automaticActivityDetection.disabled: true`
- `{"realtimeInput":{"activityStart":{}}}` … audio … `{"realtimeInput":{"activityEnd":{}}}`

which cut a running model turn and produced, in order,
`{"serverContent":{"interrupted":true}}` then
`{"serverContent":{"turnComplete":true}}`. In production we leave automatic
detection on — the phone sends real speech — and treat `interrupted` as the
cue for `playback_interrupt`.

## Tools

`behavior: "NON_BLOCKING"` **is** accepted per function declaration, so the
ADR's non-blocking calling stands.

```json
{
  "toolCall": {
    "functionCalls": [
      { "name": "subagent", "args": { "request": "…" }, "id": "call_293627" }
    ]
  }
}
```

The id is a string the server picks. A response may come back much later:

```json
{
  "toolResponse": {
    "functionResponses": [
      {
        "id": "call_293627",
        "name": "subagent",
        "response": { "result": "…" },
        "scheduling": "WHEN_IDLE"
      }
    ]
  }
}
```

Six seconds after the call, with the turn already complete, `WHEN_IDLE` was
accepted and the model spoke a fresh turn with the result. An unknown
`scheduling` value closes the socket: `1007 Invalid value at
'tool_response.function_responses[0].scheduling'`, so the three names
(`WHEN_IDLE`, `INTERRUPT`, `SILENT`) must be exact.

`toolCallCancellation` was not observed — no probe produced one — so the
adapter decodes it (`{"toolCallCancellation":{"ids":["…"]}}`, the documented
shape) and drops the matching in-flight work without having seen it live.

## Session resumption

Unprompted after setup and again through the session:

```json
{ "sessionResumptionUpdate": { "newHandle": "2e780bb8-…", "resumable": true } }
```

Reconnecting with `setup.sessionResumption.handle` set to the last handle
worked after a deliberate close: the new session answered "You asked me to
remember the number 4291" about a fact established only in the old one. So
wake genuinely resumes, it does not merely re-prompt.

A handle the server does not know closes the socket with code **1008**,
`Requested entity was not found.` — a different code from the malformed-frame
1007, which is how the object tells "expired, start fresh with a handover"
from "we sent rubbish".

Google does not state the handle's lifetime in the response and the probe did
not wait one out, so `VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1` stays where it is
as our own policy, and the 1008 close is the real fallback trigger.

`goAway` was not observed: no probe session ran near the connection limit. The
adapter decodes `{"goAway":{"timeLeft":"…"}}` and treats it as "reconnect with
the handle now", untested against the live server.
