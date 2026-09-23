// A Gemini Live upstream the workerd suite can drive by hand.
//
// It speaks the shapes `docs/voice-gemini-probe.md` recorded off the real API
// and nothing else: the same setup acknowledgement, the same `serverContent`
// envelope, the same two turn boundaries, the same `toolCall` ids, the same
// 1008 for a handle the server does not know. What the suite proves is the
// Durable Object's own behaviour — the ledger, the meters, sleep and wake,
// a hand-over, a delegation across an eviction — and Google answering is not
// part of that.
//
// It is reached the way production reaches the real thing: the object reads
// `VOICE_ASSISTANT_UPSTREAM_URL`, puts the key on it, and opens a socket. The
// probe subclass answers that open with one end of a `WebSocketPair`, the
// same seam `voice-dictation.workerd.ts` uses for its own upstream.

/**
 * One byte of stand-in PCM. Built rather than written: a literal control
 * character in source does not survive the formatter.
 */
const SAMPLE_BYTE = String.fromCharCode(1);

/** One client frame the fake received, in the shape a test asserts on. */
export interface GeminiFakeFrameV1 {
  kind:
    "setup" | "audio" | "text" | "tool-response" | "turn-boundary" | "other";
  /** For `audio`: the decoded byte length, and the first byte as a tag. */
  bytes?: number;
  tag?: number;
  /** For `setup`: what the session was opened with. */
  instruction?: string;
  voiceName?: string;
  tools?: string[];
  handle?: string;
  /** For `text`: the turn's words. */
  text?: string;
  /** For `tool-response`: what went back, and when it is to be spoken. */
  callId?: string;
  callName?: string;
  result?: string;
  scheduling?: string;
}

/** What the fake was opened with, and what it has been told to do since. */
export class GeminiFakeV1 {
  readonly frames: GeminiFakeFrameV1[] = [];
  readonly url: string;
  private readonly socket: WebSocket;
  private open = true;

  constructor(url: string, socket: WebSocket) {
    this.url = url;
    this.socket = socket;
    socket.accept();
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      this.record(event.data);
    });
    socket.addEventListener("close", () => {
      this.open = false;
    });
  }

  private record(raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.frames.push({ kind: "other" });
      return;
    }
    const setup = parsed.setup as Record<string, unknown> | undefined;
    if (setup) {
      const generation = setup.generationConfig as
        | {
            speechConfig?: {
              voiceConfig?: { prebuiltVoiceConfig?: { voiceName?: string } };
            };
          }
        | undefined;
      const instruction = setup.systemInstruction as
        { parts?: { text?: string }[] } | undefined;
      const tools =
        (setup.tools as Record<string, unknown>[] | undefined) ?? [];
      const declared = tools.flatMap((entry) => {
        if (entry.googleSearch) return ["googleSearch"];
        const declarations = entry.functionDeclarations as
          { name: string }[] | undefined;
        return (declarations ?? []).map((declaration) => declaration.name);
      });
      const resumption = setup.sessionResumption as
        { handle?: string } | undefined;
      this.frames.push({
        kind: "setup",
        instruction: instruction?.parts?.[0]?.text ?? "",
        voiceName:
          generation?.speechConfig?.voiceConfig?.prebuiltVoiceConfig
            ?.voiceName ?? "",
        tools: declared,
        ...(resumption?.handle ? { handle: resumption.handle } : {}),
      });
      // The real server answers setup before anything else, and volunteers a
      // resumption handle straight after it.
      this.send({ setupComplete: {} });
      this.send({
        sessionResumptionUpdate: {
          newHandle: `handle-${this.frames.length}`,
          resumable: true,
        },
      });
      return;
    }
    const realtime = parsed.realtimeInput as
      Record<string, unknown> | undefined;
    if (realtime?.audio) {
      const audio = realtime.audio as { data?: string };
      const bytes = atob(audio.data ?? "");
      this.frames.push({
        kind: "audio",
        bytes: bytes.length,
        tag: bytes.charCodeAt(0),
      });
      return;
    }
    const content = parsed.clientContent as Record<string, unknown> | undefined;
    if (content) {
      const turns = content.turns as
        { role?: string; parts?: { text?: string }[] }[] | undefined;
      if (!turns) {
        this.frames.push({ kind: "turn-boundary" });
        return;
      }
      this.frames.push({
        kind: "text",
        text: turns[0]?.parts?.[0]?.text ?? "",
      });
      return;
    }
    const toolResponse = parsed.toolResponse as
      { functionResponses?: Record<string, unknown>[] } | undefined;
    if (toolResponse) {
      for (const answer of toolResponse.functionResponses ?? []) {
        const response = answer.response as { result?: string } | undefined;
        this.frames.push({
          kind: "tool-response",
          callId: String(answer.id ?? ""),
          callName: String(answer.name ?? ""),
          result: response?.result ?? "",
          scheduling: String(answer.scheduling ?? ""),
        });
      }
      return;
    }
    this.frames.push({ kind: "other" });
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.open) return;
    try {
      this.socket.send(new TextEncoder().encode(JSON.stringify(frame)));
    } catch {
      // The object's end has gone; its own close handling covers it.
    }
  }

  /** What the person said, as the session transcribes it. */
  hears(text: string): void {
    this.send({ serverContent: { inputTranscription: { text } } });
  }

  /** A hypothesis while they are still speaking. */
  hearsInterim(text: string): void {
    this.send({ serverContent: { interimInputTranscription: { text } } });
  }

  /**
   * One spoken turn: audio, its transcription, and both boundaries in the
   * order the real server sends them.
   */
  says(text: string, audioBytes = 4_800): void {
    // The real server sends several bare frames between content frames; one
    // proves the decoder ignores them.
    this.send({});
    this.send({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: btoa(SAMPLE_BYTE.repeat(audioBytes)),
              },
            },
          ],
          role: "model",
        },
        outputTranscription: { text },
      },
    });
    this.send({ serverContent: { generationComplete: true } });
    this.send({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokenCount: 100,
        responseTokenCount: 20,
        totalTokenCount: 120,
      },
    });
  }

  /** Audio with no boundary after it: a turn still in flight. */
  speaks(audioBytes = 4_800): void {
    this.send({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/pcm;rate=24000",
                data: btoa(SAMPLE_BYTE.repeat(audioBytes)),
              },
            },
          ],
          role: "model",
        },
      },
    });
  }

  /** Closes the turn a `speaks` opened. */
  endsTurn(): void {
    this.send({ serverContent: { generationComplete: true } });
    this.send({ serverContent: { turnComplete: true } });
  }

  /**
   * A function call. The real 3.8 server sends it before any audio and closes
   * the generation straight after, so a faithful turn is `calls` then
   * `endsTurn`, and the words come in a fresh turn once the result is back.
   */
  calls(name: string, args: Record<string, unknown>, id: string): void {
    this.callsAll([{ name, args, id }]);
  }

  /** Several function calls in one `toolCall`, the way the model batches them. */
  callsAll(
    functionCalls: {
      name: string;
      args: Record<string, unknown>;
      id: string;
    }[],
  ): void {
    this.send({ toolCall: { functionCalls } });
  }

  cancels(ids: string[]): void {
    this.send({ toolCallCancellation: { ids } });
  }

  interrupted(): void {
    this.send({ serverContent: { interrupted: true } });
  }

  goAway(): void {
    this.send({ goAway: { timeLeft: "1s" } });
  }

  close(code = 1000, reason = ""): void {
    this.open = false;
    try {
      this.socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }
}
