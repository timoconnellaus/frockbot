import { describe, expect, test } from "bun:test";
import {
  buildOpenAiRealtimeSessionV1,
  openAiRealtimeVoiceProviderV1,
  openAiToolSchemaV1,
  openAiVoiceForV1,
  OpenAiRealtimeUpsamplerV1,
  OpenAiRealtimeVoiceCodecV1,
  OPENAI_REALTIME_VOICE_MODEL_V1,
  OPENAI_VOICE_BY_GEMINI_VOICE_V1,
} from "./openai-realtime-voice.js";
import {
  GEMINI_VOICE_BY_CHARACTER_V1,
  GEMINI_VOICES_V1,
} from "./appearance.js";
import { VOICE_FUNCTION_DECLARATIONS_V1 } from "./assistant.js";
import { encodeGeminiBase64V1 } from "./gemini-live.js";

const parse = (frames: string[]) =>
  frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) =>
    view.getInt16(index * 2, true),
  );
}

describe("the session", () => {
  test("is a GA realtime session with audio out, the server's detector and the tools", () => {
    const frame = buildOpenAiRealtimeSessionV1({
      instruction: "You are Sunny.",
      voiceName: "Puck",
      functions: [
        {
          name: "remember",
          description: "Keep something.",
          parameters: {
            type: "OBJECT",
            properties: {
              text: { type: "STRING" },
              kind: { type: "STRING", enum: ["preference", "open"] },
            },
            required: ["text"],
          },
          behavior: "NON_BLOCKING",
        },
      ],
    });
    expect(frame.type).toBe("session.update");
    const session = frame.session as Record<string, unknown>;
    expect(session.type).toBe("realtime");
    expect(session.model).toBe(OPENAI_REALTIME_VOICE_MODEL_V1);
    expect(session.instructions).toBe("You are Sunny.");
    expect(session.output_modalities).toEqual(["audio"]);
    expect(session.audio).toEqual({
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24_000 },
        voice: "shimmer",
      },
    });
    expect(session.tools).toEqual([
      {
        type: "function",
        name: "remember",
        description: "Keep something.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            kind: { type: "string", enum: ["preference", "open"] },
          },
          required: ["text"],
        },
      },
    ]);
    expect(session.tool_choice).toBe("auto");
  });

  test("converts every declaration the Bot has into JSON Schema", () => {
    for (const declaration of VOICE_FUNCTION_DECLARATIONS_V1) {
      const text = JSON.stringify(openAiToolSchemaV1(declaration.parameters));
      expect(text).not.toMatch(/"type":"[A-Z]+"/);
    }
  });

  test("keeps a property called `type` a property", () => {
    expect(
      openAiToolSchemaV1({
        type: "OBJECT",
        properties: { type: { type: "STRING" } },
      }),
    ).toEqual({ type: "object", properties: { type: { type: "string" } } });
  });

  test("connects to the model with the key in a header, never the url", () => {
    const endpoint = openAiRealtimeVoiceProviderV1.endpoint("sk-test");
    expect(endpoint.url).toBe(
      `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_VOICE_MODEL_V1}`,
    );
    expect(endpoint.url).not.toContain("sk-test");
    expect(endpoint.headers).toEqual({ Authorization: "Bearer sk-test" });
    expect(
      openAiRealtimeVoiceProviderV1.endpoint("k", "wss://fake.invalid/rt?x=1")
        .url,
    ).toBe(`wss://fake.invalid/rt?x=1&model=${OPENAI_REALTIME_VOICE_MODEL_V1}`);
  });
});

describe("voices", () => {
  test("every Gemini voice has an OpenAI one", () => {
    for (const voice of GEMINI_VOICES_V1) {
      expect(OPENAI_VOICE_BY_GEMINI_VOICE_V1[voice.voiceName]).toBeString();
    }
  });

  test("the characters' defaults stay nearly all different", () => {
    const mapped = Object.values(GEMINI_VOICE_BY_CHARACTER_V1).map((name) =>
      openAiVoiceForV1(name),
    );
    expect(new Set(mapped).size).toBeGreaterThanOrEqual(mapped.length - 1);
  });

  test("an unknown or absent voice falls back", () => {
    expect(openAiVoiceForV1(undefined)).toBe("marin");
    expect(openAiVoiceForV1("Nobody")).toBe("marin");
  });
});

describe("audio up", () => {
  test("16 kHz becomes 24 kHz, three samples for every two", () => {
    const upsampler = new OpenAiRealtimeUpsamplerV1();
    const first = samples(upsampler.push(pcm([0, 300, 600, 900])));
    // The last input sample waits for its neighbour before it is split.
    expect(first).toEqual([0, 200, 400, 600, 800]);
    const second = samples(upsampler.push(pcm([1200, 1500])));
    expect(second).toEqual([1000, 1200, 1400]);
  });

  test("a long run keeps the 3:2 ratio across chunk boundaries", () => {
    const upsampler = new OpenAiRealtimeUpsamplerV1();
    let out = 0;
    for (let chunk = 0; chunk < 50; chunk += 1) {
      out += upsampler.push(pcm(new Array(640).fill(100))).byteLength / 2;
    }
    expect(Math.abs(out - (50 * 640 * 3) / 2)).toBeLessThanOrEqual(2);
  });

  test("goes up as input_audio_buffer.append", () => {
    const codec = new OpenAiRealtimeVoiceCodecV1();
    const [frame] = parse(codec.audio(pcm([1, 2, 3, 4])));
    expect(frame!.type).toBe("input_audio_buffer.append");
    expect(typeof frame!.audio).toBe("string");
  });
});

describe("the server's events", () => {
  const audio = (itemId: string, bytes: number) =>
    JSON.stringify({
      type: "response.output_audio.delta",
      item_id: itemId,
      delta: encodeGeminiBase64V1(new Uint8Array(bytes)),
    });

  test("the first session.updated is the setup completing, and only the first", () => {
    const codec = new OpenAiRealtimeVoiceCodecV1();
    expect(
      codec.decode(JSON.stringify({ type: "session.created" })).events,
    ).toEqual([]);
    const updated = JSON.stringify({ type: "session.updated" });
    expect(codec.decode(updated).events).toEqual([{ kind: "setup-complete" }]);
    expect(codec.decode(updated).events).toEqual([]);
  });

  test("audio, both transcripts and the end of a response", () => {
    const codec = new OpenAiRealtimeVoiceCodecV1();
    codec.decode(JSON.stringify({ type: "response.created" }));
    const [sound] = codec.decode(audio("item_1", 480)).events;
    expect(sound).toMatchObject({
      kind: "audio",
      mimeType: "audio/pcm;rate=24000",
    });
    expect(
      codec.decode(
        JSON.stringify({
          type: "response.output_audio_transcript.delta",
          delta: "Hello",
        }),
      ).events,
    ).toEqual([{ kind: "output-transcript", text: "Hello" }]);
    expect(
      codec.decode(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          delta: "wha",
        }),
      ).events,
    ).toEqual([{ kind: "input-transcript-interim", text: "wha" }]);
    expect(
      codec.decode(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: " what bots do I have ",
        }),
      ).events,
    ).toEqual([{ kind: "input-transcript", text: "what bots do I have" }]);
    expect(
      codec.decode(
        JSON.stringify({
          type: "response.done",
          response: {
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          },
        }),
      ).events,
    ).toEqual([
      {
        kind: "usage",
        usage: { promptTokens: 10, responseTokens: 20, totalTokens: 30 },
      },
      { kind: "turn-complete" },
    ]);
  });

  test("unreadable frames and unknown events are nothing", () => {
    const codec = new OpenAiRealtimeVoiceCodecV1();
    expect(codec.decode("not json")).toEqual({ events: [], replies: [] });
    expect(
      codec.decode(JSON.stringify({ type: "rate_limits.updated" })),
    ).toEqual({ events: [], replies: [] });
  });

  test("a session past its sixty minutes is a goAway, not a failure", () => {
    const codec = new OpenAiRealtimeVoiceCodecV1();
    expect(
      codec.decode(
        JSON.stringify({
          type: "error",
          error: { code: "session_expired", message: "expired" },
        }),
      ).events,
    ).toEqual([{ kind: "go-away" }]);
    expect(
      codec.decode(
        JSON.stringify({ type: "error", error: { message: "bad value" } }),
      ).events,
    ).toEqual([{ kind: "provider-error", message: "bad value" }]);
  });

  describe("barge-in", () => {
    test("speech over a reply still playing interrupts and truncates to what was heard", () => {
      let now = 1_000;
      const codec = new OpenAiRealtimeVoiceCodecV1(() => now);
      codec.decode(JSON.stringify({ type: "response.created" }));
      // Two seconds of audio at 48 bytes a millisecond, sent at once.
      codec.decode(audio("item_9", 96_000));
      codec.decode(
        JSON.stringify({
          type: "response.done",
          response: { status: "completed", output: [] },
        }),
      );
      now += 700;
      const decoded = codec.decode(
        JSON.stringify({ type: "input_audio_buffer.speech_started" }),
      );
      expect(decoded.events).toEqual([{ kind: "interrupted" }]);
      expect(parse(decoded.replies)).toEqual([
        {
          type: "conversation.item.truncate",
          item_id: "item_9",
          content_index: 0,
          audio_end_ms: 700,
        },
      ]);
    });

    test("speech after the reply has all been played is just speech", () => {
      let now = 1_000;
      const codec = new OpenAiRealtimeVoiceCodecV1(() => now);
      codec.decode(JSON.stringify({ type: "response.created" }));
      codec.decode(audio("item_9", 4_800));
      codec.decode(
        JSON.stringify({
          type: "response.done",
          response: { status: "completed", output: [] },
        }),
      );
      now += 500;
      expect(
        codec.decode(
          JSON.stringify({ type: "input_audio_buffer.speech_started" }),
        ),
      ).toEqual({ events: [], replies: [] });
    });

    test("speech with nothing said yet is not an interruption", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      expect(
        codec.decode(
          JSON.stringify({ type: "input_audio_buffer.speech_started" }),
        ).events,
      ).toEqual([]);
    });
  });

  describe("function calls", () => {
    const done = (output: unknown[], status = "completed") =>
      JSON.stringify({ type: "response.done", response: { status, output } });

    test("arrive with the end of their response, before its boundary", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      codec.decode(JSON.stringify({ type: "response.created" }));
      const decoded = codec.decode(
        done([
          {
            type: "function_call",
            call_id: "call_1",
            name: "list_bots",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "subagent",
            arguments: '{"text":"plan my week"}',
          },
        ]),
      );
      expect(decoded.events).toEqual([
        {
          kind: "tool-call",
          calls: [
            { id: "call_1", name: "list_bots", args: {} },
            { id: "call_2", name: "subagent", args: { text: "plan my week" } },
          ],
        },
        { kind: "turn-complete" },
      ]);
    });

    test("a response asked for only once every call has its answer", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      codec.decode(JSON.stringify({ type: "response.created" }));
      codec.decode(
        done([
          {
            type: "function_call",
            call_id: "a",
            name: "status",
            arguments: "",
          },
          {
            type: "function_call",
            call_id: "b",
            name: "list_bots",
            arguments: "",
          },
        ]),
      );
      const first = parse(
        codec.toolAnswers([{ id: "a", name: "status", response: { ok: 1 } }]),
      );
      expect(first).toEqual([
        {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "a",
            output: '{"ok":1}',
          },
        },
      ]);
      const second = parse(
        codec.toolAnswers([
          {
            id: "b",
            name: "list_bots",
            response: { bots: [] },
            whenIdle: true,
          },
        ]),
      );
      expect(second.map((frame) => frame.type)).toEqual([
        "conversation.item.create",
        "response.create",
      ]);
    });

    test("a second answer to one call is a turn, and waits for the reply in progress", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      codec.decode(JSON.stringify({ type: "response.created" }));
      codec.decode(
        done([
          {
            type: "function_call",
            call_id: "s",
            name: "subagent",
            arguments: "{}",
          },
        ]),
      );
      codec.toolAnswers([
        { id: "s", name: "subagent", response: { started: true } },
      ]);
      // The answer to "started" is being spoken now.
      codec.decode(JSON.stringify({ type: "response.created" }));
      const late = parse(
        codec.toolAnswers([
          {
            id: "s",
            name: "subagent",
            response: { result: "Your week is planned." },
            whenIdle: true,
          },
        ]),
      );
      expect(late).toEqual([
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Your week is planned." }],
          },
        },
      ]);
      const after = codec.decode(done([]));
      expect(parse(after.replies)).toEqual([{ type: "response.create" }]);
    });

    test("a cancelled response's calls are not run", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      codec.decode(JSON.stringify({ type: "response.created" }));
      expect(
        codec.decode(
          done(
            [
              {
                type: "function_call",
                call_id: "x",
                name: "end_call",
                arguments: "",
              },
            ],
            "cancelled",
          ),
        ).events,
      ).toEqual([{ kind: "turn-complete" }]);
    });

    test("a response the server already started is asked for again after it", () => {
      const codec = new OpenAiRealtimeVoiceCodecV1();
      expect(parse(codec.textTurn("hi")).map((frame) => frame.type)).toEqual([
        "conversation.item.create",
        "response.create",
      ]);
      codec.decode(
        JSON.stringify({
          type: "error",
          error: { code: "conversation_already_has_active_response" },
        }),
      );
      expect(parse(codec.decode(done([])).replies)).toEqual([
        { type: "response.create" },
      ]);
    });
  });
});
