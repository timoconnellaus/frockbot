import { describe, expect, test } from "bun:test";
import {
  buildGeminiLiveSetupV1,
  decodeGeminiBase64V1,
  decodeGeminiServerFrameV1,
  encodeGeminiAudioFrameV1,
  encodeGeminiBase64V1,
  encodeGeminiTextTurnV1,
  encodeGeminiToolResponseV1,
  geminiLiveUrlV1,
  GEMINI_LIVE_INPUT_MIME_V1,
  GEMINI_LIVE_MODEL_V1,
} from "./gemini-live.js";

describe("the setup frame", () => {
  test("carries the instruction, the voice, the tools and transcription", () => {
    const frame = buildGeminiLiveSetupV1({
      systemInstruction: "You are Sunny.",
      voiceName: "Puck",
      googleSearch: true,
      functionDeclarations: [
        {
          name: "subagent",
          description: "Hand off anything that will take more than a moment.",
          parameters: { type: "OBJECT", properties: {} },
          behavior: "NON_BLOCKING",
        },
      ],
    });
    const setup = frame.setup as Record<string, unknown>;
    expect(setup.model).toBe(GEMINI_LIVE_MODEL_V1);
    expect(setup.systemInstruction).toEqual({
      parts: [{ text: "You are Sunny." }],
    });
    expect(setup.generationConfig).toEqual({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
      },
    });
    expect(setup.inputAudioTranscription).toEqual({ mode: "SMART" });
    expect(setup.outputAudioTranscription).toEqual({ mode: "SMART" });
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.tools).toEqual([
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: "subagent",
            description: "Hand off anything that will take more than a moment.",
            parameters: { type: "OBJECT", properties: {} },
            behavior: "NON_BLOCKING",
          },
        ],
      },
    ]);
  });

  test("never sends affective dialog or a language code", () => {
    // Both were in ADR 0031 and both were answered by the API: affective
    // dialog kills the session on its first content frame, and the language
    // code's stated rejection does not happen. The frame carries neither.
    const setup = buildGeminiLiveSetupV1({
      systemInstruction: "hello",
      voiceName: "Puck",
    }).setup as Record<string, unknown>;
    expect(JSON.stringify(setup)).not.toContain("enableAffectiveDialog");
    expect(JSON.stringify(setup)).not.toContain("languageCode");
  });

  test("resumes a session when it is given a handle", () => {
    const setup = buildGeminiLiveSetupV1({
      systemInstruction: "hello",
      resumptionHandle: "2e780bb8-b4e9-42af-a9bc-f3f6aaf37070",
    }).setup as Record<string, unknown>;
    expect(setup.sessionResumption).toEqual({
      handle: "2e780bb8-b4e9-42af-a9bc-f3f6aaf37070",
    });
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  test("omits the tools array when there are none", () => {
    const setup = buildGeminiLiveSetupV1({ systemInstruction: "hello" })
      .setup as Record<string, unknown>;
    expect(setup.tools).toBeUndefined();
    expect(setup.generationConfig).toEqual({ responseModalities: ["AUDIO"] });
  });

  test("puts the key in the query string", () => {
    expect(geminiLiveUrlV1("abc/123", "wss://fake.test/live")).toBe(
      "wss://fake.test/live?key=abc%2F123",
    );
    expect(geminiLiveUrlV1("k", "wss://fake.test/live?x=1")).toBe(
      "wss://fake.test/live?x=1&key=k",
    );
  });
});

describe("client frames", () => {
  test("audio goes up as base64 PCM at 16 kHz", () => {
    const pcm = new Uint8Array([0, 1, 2, 3, 250, 255]);
    const frame = encodeGeminiAudioFrameV1(pcm);
    const audio = (frame.realtimeInput as Record<string, unknown>)
      .audio as Record<string, unknown>;
    expect(audio.mimeType).toBe(GEMINI_LIVE_INPUT_MIME_V1);
    expect(decodeGeminiBase64V1(audio.data as string)).toEqual(pcm);
  });

  test("base64 survives a part larger than one argument list", () => {
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = index % 256;
    expect(decodeGeminiBase64V1(encodeGeminiBase64V1(bytes))).toEqual(bytes);
  });

  test("unreadable base64 is empty audio, never a throw", () => {
    expect(decodeGeminiBase64V1("not base64 !!")).toEqual(new Uint8Array(0));
  });

  test("a text turn names its role, because the API refuses one without", () => {
    expect(encodeGeminiTextTurnV1("hello")).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "hello" }] }],
        turnComplete: true,
      },
    });
  });

  test("a tool answer carries the server's own id and its scheduling", () => {
    expect(
      encodeGeminiToolResponseV1([
        {
          id: "call_293627",
          name: "subagent",
          response: { result: "done" },
          scheduling: "WHEN_IDLE",
        },
        { id: "call_2", name: "status", response: { result: "idle" } },
      ]),
    ).toEqual({
      toolResponse: {
        functionResponses: [
          {
            id: "call_293627",
            name: "subagent",
            response: { result: "done" },
            scheduling: "WHEN_IDLE",
          },
          { id: "call_2", name: "status", response: { result: "idle" } },
        ],
      },
    });
  });
});

describe("decoding what the server sends", () => {
  test("setup completion", () => {
    expect(decodeGeminiServerFrameV1('{"setupComplete":{}}')).toEqual([
      { kind: "setup-complete" },
    ]);
  });

  test("bare and unknown frames carry nothing", () => {
    expect(decodeGeminiServerFrameV1("{}")).toEqual([]);
    expect(decodeGeminiServerFrameV1('{"serverContent":{}}')).toEqual([]);
    expect(decodeGeminiServerFrameV1('{"somethingNew":{"a":1}}')).toEqual([]);
    expect(decodeGeminiServerFrameV1("not json")).toEqual([]);
    expect(decodeGeminiServerFrameV1("[1,2]")).toEqual([]);
  });

  test("audio and the transcription fragment that rides with it", () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const events = decodeGeminiServerFrameV1(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: encodeGeminiBase64V1(pcm),
                },
              },
            ],
            role: "model",
          },
          outputTranscription: { text: "Hello, I " },
        },
      }),
    );
    expect(events).toEqual([
      { kind: "audio", pcm, mimeType: "audio/pcm;rate=24000" },
      { kind: "output-transcript", text: "Hello, I " },
    ]);
  });

  test("what the person said", () => {
    expect(
      decodeGeminiServerFrameV1(
        '{"serverContent":{"inputTranscription":{"text":"¿Qué?"}}}',
      ),
    ).toEqual([{ kind: "input-transcript", text: "¿Qué?" }]);
  });

  test("an interim while they are still speaking", () => {
    expect(
      decodeGeminiServerFrameV1(
        '{"serverContent":{"interimInputTranscription":{"text":"check Thurs"}}}',
      ),
    ).toEqual([{ kind: "input-transcript-interim", text: "check Thurs" }]);
  });

  test("the two turn boundaries, and usage beside the second", () => {
    expect(
      decodeGeminiServerFrameV1(
        '{"serverContent":{"generationComplete":true}}',
      ),
    ).toEqual([{ kind: "generation-complete" }]);
    expect(
      decodeGeminiServerFrameV1(
        JSON.stringify({
          serverContent: { turnComplete: true },
          usageMetadata: {
            promptTokenCount: 550,
            responseTokenCount: 49,
            totalTokenCount: 599,
          },
        }),
      ),
    ).toEqual([
      { kind: "turn-complete" },
      {
        kind: "usage",
        usage: { promptTokens: 550, responseTokens: 49, totalTokens: 599 },
      },
    ]);
  });

  test("an interruption is decoded before the boundary it arrives with", () => {
    expect(
      decodeGeminiServerFrameV1(
        '{"serverContent":{"interrupted":true,"turnComplete":true}}',
      ),
    ).toEqual([{ kind: "interrupted" }, { kind: "turn-complete" }]);
  });

  test("a tool call, with the id the server chose", () => {
    expect(
      decodeGeminiServerFrameV1(
        JSON.stringify({
          toolCall: {
            functionCalls: [
              {
                name: "subagent",
                args: { request: "research paperclips" },
                id: "call_293627",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        kind: "tool-call",
        calls: [
          {
            id: "call_293627",
            name: "subagent",
            args: { request: "research paperclips" },
          },
        ],
      },
    ]);
  });

  test("a nameless call is not a call", () => {
    expect(
      decodeGeminiServerFrameV1('{"toolCall":{"functionCalls":[{"id":"x"}]}}'),
    ).toEqual([]);
  });

  test("a cancellation names the calls to drop", () => {
    expect(
      decodeGeminiServerFrameV1('{"toolCallCancellation":{"ids":["call_1"]}}'),
    ).toEqual([{ kind: "tool-cancel", ids: ["call_1"] }]);
  });

  test("a resumption handle, and the server asking us to reconnect", () => {
    expect(
      decodeGeminiServerFrameV1(
        '{"sessionResumptionUpdate":{"newHandle":"h-1","resumable":true}}',
      ),
    ).toEqual([{ kind: "resumption", handle: "h-1", resumable: true }]);
    expect(decodeGeminiServerFrameV1('{"goAway":{"timeLeft":"10s"}}')).toEqual([
      { kind: "go-away", timeLeft: "10s" },
    ]);
  });
});
