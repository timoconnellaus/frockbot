// An OpenAI Realtime upstream the workerd suite can drive by hand.
//
// The twin of `voice-gemini-fake.ts`: the same verbs a test drives the Gemini
// fake with, spoken in the GA Realtime API's events, and the same record of
// what the object sent, so a test asserts one shape whichever provider the
// call is on. What it proves is that the object, through the OpenAI codec,
// holds a call — not that OpenAI answers.
import type { GeminiFakeFrameV1 } from "./voice-gemini-fake.ts";

const SAMPLE_BYTE = String.fromCharCode(1);

/** What a test drives either fake with. */
export interface VoiceUpstreamFakeV1 {
  readonly frames: GeminiFakeFrameV1[];
  readonly url: string;
  hears(text: string): void;
  hearsInterim(text: string): void;
  says(text: string, audioBytes?: number): void;
  speaks(audioBytes?: number): void;
  endsTurn(): void;
  calls(name: string, args: Record<string, unknown>, id: string): void;
  callsAll(
    calls: { name: string; args: Record<string, unknown>; id: string }[],
  ): void;
  cancels(ids: string[]): void;
  interrupted(): void;
  goAway(): void;
  close(code?: number, reason?: string): void;
}

export class OpenAiRealtimeFakeV1 implements VoiceUpstreamFakeV1 {
  readonly frames: GeminiFakeFrameV1[] = [];
  readonly url: string;
  readonly headers: Record<string, string>;
  private readonly socket: WebSocket;
  private open = true;
  private responding = false;
  private items = 0;
  private item = "";

  constructor(url: string, headers: Record<string, string>, socket: WebSocket) {
    this.url = url;
    this.headers = headers;
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
    switch (parsed.type) {
      case "session.update": {
        const session = (parsed.session ?? {}) as {
          instructions?: string;
          audio?: { output?: { voice?: string } };
          tools?: { name: string }[];
        };
        this.frames.push({
          kind: "setup",
          instruction: session.instructions ?? "",
          voiceName: session.audio?.output?.voice ?? "",
          tools: (session.tools ?? []).map((tool) => tool.name),
        });
        this.send({ type: "session.created" });
        this.send({ type: "session.updated" });
        return;
      }
      case "input_audio_buffer.append": {
        const bytes = atob(String(parsed.audio ?? ""));
        this.frames.push({
          kind: "audio",
          bytes: bytes.length,
          tag: bytes.charCodeAt(0),
        });
        return;
      }
      case "conversation.item.create": {
        const item = (parsed.item ?? {}) as {
          type?: string;
          call_id?: string;
          output?: string;
          content?: { text?: string }[];
        };
        if (item.type === "function_call_output") {
          let result = item.output ?? "";
          try {
            const value = JSON.parse(result) as { result?: unknown };
            if (typeof value.result === "string") result = value.result;
          } catch {
            // Kept as sent.
          }
          this.frames.push({
            kind: "tool-response",
            callId: item.call_id ?? "",
            result,
          });
          return;
        }
        this.frames.push({ kind: "text", text: item.content?.[0]?.text ?? "" });
        return;
      }
      case "response.create":
        this.frames.push({ kind: "response" });
        return;
      case "conversation.item.truncate":
        this.frames.push({
          kind: "truncate",
          itemId: String(parsed.item_id ?? ""),
          audioEndMs: Number(parsed.audio_end_ms ?? 0),
        });
        return;
    }
    this.frames.push({ kind: "other" });
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.open) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      // The object's end has gone.
    }
  }

  private begin(): void {
    if (this.responding) return;
    this.responding = true;
    this.items += 1;
    this.item = `item_${this.items}`;
    this.send({
      type: "response.created",
      response: { id: `resp_${this.items}` },
    });
  }

  private done(output: unknown[] = [], status = "completed"): void {
    this.responding = false;
    this.send({
      type: "response.done",
      response: {
        status,
        output,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    });
  }

  hears(text: string): void {
    this.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_user",
      transcript: text,
    });
  }

  hearsInterim(text: string): void {
    this.send({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_user",
      delta: text,
    });
  }

  says(text: string, audioBytes = 4_800): void {
    this.begin();
    if (audioBytes > 0) this.speaks(audioBytes);
    if (text) {
      this.send({
        type: "response.output_audio_transcript.delta",
        item_id: this.item,
        delta: text,
      });
    }
    this.done();
  }

  speaks(audioBytes = 4_800): void {
    this.begin();
    this.send({
      type: "response.output_audio.delta",
      item_id: this.item,
      delta: btoa(SAMPLE_BYTE.repeat(audioBytes)),
    });
  }

  endsTurn(): void {
    this.done();
  }

  calls(name: string, args: Record<string, unknown>, id: string): void {
    this.callsAll([{ name, args, id }]);
  }

  /** Calls end their response: OpenAI puts them in `response.done`. */
  callsAll(
    calls: { name: string; args: Record<string, unknown>; id: string }[],
  ): void {
    this.begin();
    this.done(
      calls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      })),
    );
  }

  cancels(): void {
    // OpenAI never withdraws a call.
  }

  /**
   * The person talks over the reply. The server's detector says so and, with
   * `interrupt_response`, cancels the response it was still generating.
   */
  interrupted(): void {
    this.send({ type: "input_audio_buffer.speech_started" });
    if (this.responding) this.done([], "cancelled");
  }

  goAway(): void {
    this.send({
      type: "error",
      error: {
        code: "session_expired",
        message: "Your session hit the maximum duration of 60 minutes.",
      },
    });
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
