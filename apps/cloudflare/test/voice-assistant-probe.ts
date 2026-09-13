// The voice session object as the workerd suite drives it: the real class
// with every provider seam replaced by a scripted fake, plus a few RPCs that
// let a test read what the fakes saw.
//
// The fakes are the point. What the suite proves is the object's own
// behaviour — ownership, exclusivity, sleep and wake ordering, the ledger,
// delegation across eviction — not that Workers AI or ElevenLabs answer.
import type {
  VoiceTranscriberSessionOptionsV1,
  VoiceTranscriberV1,
} from "@frockbot/app/voice/sleeping-transcriber";
import type { Connection } from "agents";
import { VoiceAssistant } from "../src/voice-assistant.ts";
import type { VoiceDelegationRecordV1 } from "@frockbot/app/voice/ledger";
import type {
  VoiceMemoryJobV1,
  VoiceMemoryRecordV1,
} from "@frockbot/app/voice/memory";

interface ProbeSession {
  id: number;
  fed: number[];
  closed: boolean;
  options: VoiceTranscriberSessionOptionsV1;
}

/** What the scripted model does with a transcript. */
export interface VoiceProbeScript {
  /** Transcripts containing this word become an `ask_bot` call to `botId`. */
  delegateWord?: string;
  botId?: string;
  /** The whole model reply, so a test can choose its sentences. */
  reply?: string;
  /** The speech provider answers every sentence with nothing, as a refused key does. */
  silentTts?: boolean;
  /**
   * What the end-of-call memory request answers with. `operations` is
   * serialised as the update envelope; `raw` is sent exactly as given, so a
   * test can send something that is not an update at all; `fail` makes the
   * request itself throw, as an unreachable gateway does.
   */
  memory?: {
    operations?: Record<string, unknown>[];
    raw?: string;
    fail?: boolean;
  };
  /** Transcripts containing this word become a `remember` tool call. */
  rememberWord?: string;
  remember?: Record<string, unknown>;
  /** Transcripts containing this word become a `forget` tool call. */
  forgetWord?: string;
  forget?: string;
}

/** One scheduled row, with its payload as JSON. */
export interface VoiceScheduleRow {
  callback: string;
  payload: string;
}

/** One memory request the object made, as a test reads it back. */
export interface VoiceMemoryRequest {
  system?: string;
  /** Every message's content in order, so a test can look for a turn's words. */
  contents: string[];
  /** The instruction the request ends with. */
  instruction: string;
}

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/**
 * One emitted trace line, with the fields a test reads declared explicitly:
 * an index signature of `unknown` collapses to `never` across the Workers RPC
 * stub, which costs the array its element type at the call site.
 */
export interface VoiceTraceLine {
  event: string;
  connection?: string;
  device?: string;
  call?: string;
  elapsedMs?: number;
  code?: number;
  reason?: string;
  chars?: number;
  bytes?: number;
  chunk?: number;
  audioChunks?: number;
  audioBytes?: number;
  sentencesSpoken?: number;
  turn?: string;
  ms?: number;
  sinceTurnMs?: number;
}

export class WorkerdVoiceAssistant extends VoiceAssistant {
  #sessions: ProbeSession[] = [];
  #synthesized: string[] = [];
  #chats: Record<string, unknown>[] = [];
  #script: VoiceProbeScript = {};
  #dropDispatches = 0;
  #dispatched: string[] = [];
  #traces: VoiceTraceLine[] = [];
  #stalled: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #now: string | undefined;
  #memoryRequests: VoiceMemoryRequest[] = [];

  protected override now(): Date {
    return this.#now ? new Date(this.#now) : super.now();
  }

  /** A one-second window, so a cap can bite inside a test's patience. */
  protected override sttWindowSeconds(): number {
    return 1;
  }

  /** A short drain window, so a held answer is read out inside a test. */
  protected override replyDrainQuietMs(): number {
    return 300;
  }

  /** Drops the next N dispatches: the intent is durable, the send is lost. */
  protected override dispatchDelegation(
    userId: string,
    delegation: VoiceDelegationRecordV1,
  ): void {
    if (this.#dropDispatches > 0) {
      this.#dropDispatches -= 1;
      this.#dispatched.push(`dropped:${delegation.runId}`);
      return;
    }
    this.#dispatched.push(`sent:${delegation.runId}`);
    super.dispatchDelegation(userId, delegation);
  }

  /**
   * Records the line the object actually emits — the JSON string handed to
   * the console — so a test reads the telemetry an operator would read,
   * not a second construction of it.
   */
  protected override trace(
    connection: Connection,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    const { info, warn } = console;
    const capture = (...args: unknown[]) => {
      const payload = args[1];
      if (typeof payload === "string") {
        this.#traces.push(JSON.parse(payload) as VoiceTraceLine);
      }
    };
    console.info = capture;
    console.warn = capture;
    try {
      super.trace(connection, event, fields);
    } finally {
      console.info = info;
      console.warn = warn;
    }
  }

  protected override createTts() {
    return {
      synthesize: async (text: string) => {
        this.#synthesized.push(text);
        if (this.#script.silentTts) return null;
        // 20 ms of silence at 24 kHz: enough to be a real binary frame.
        return new ArrayBuffer(24_000 * 2 * 0.02);
      },
    };
  }

  protected override createInnerTranscriber(): VoiceTranscriberV1 {
    const sessions = this.#sessions;
    return {
      createSession: (options = {}) => {
        const session: ProbeSession = {
          id: sessions.length + 1,
          fed: [],
          closed: false,
          options,
        };
        sessions.push(session);
        return {
          feed: (chunk) => {
            session.fed.push(new Uint8Array(chunk)[0] ?? -1);
          },
          waitUntilReady: () => Promise.resolve(),
          close: () => {
            session.closed = true;
          },
        };
      },
    };
  }

  protected override async chatCompletion(
    body: Record<string, unknown>,
  ): Promise<ReadableStream<Uint8Array>> {
    const messages = body.messages as { role: string; content: string }[];
    const last = messages.at(-1)!;
    // The end-of-call memory request is recorded on its own: it belongs to no
    // spoken turn, and counting it as one would make every call look like it
    // asked the model once more than it did.
    if (last.content.includes("[end of conversation]")) {
      const script = this.#script.memory ?? {};
      this.#memoryRequests.push({
        ...(messages[0]?.role === "system"
          ? { system: messages[0].content }
          : {}),
        contents: messages.map((message) => message.content),
        instruction: last.content,
      });
      if (script.fail) throw new Error("the model gateway is unavailable");
      return sse([
        {
          choices: [
            {
              delta: {
                content:
                  script.raw ??
                  JSON.stringify({ operations: script.operations ?? [] }),
              },
            },
          ],
        },
      ]);
    }
    this.#chats.push(body);
    if (this.#stalled) await this.#stalled;
    if (last.role === "tool") {
      return sse([
        {
          choices: [
            { delta: { content: `Done: ${last.content.slice(0, 60)}` } },
          ],
        },
      ]);
    }
    const script = this.#script;
    const tool = (name: string, args: unknown) =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
            },
          ],
        },
      ]);
    if (
      script.rememberWord &&
      body.tools !== undefined &&
      last.content.includes(script.rememberWord)
    ) {
      return tool(
        "remember",
        script.remember ?? { text: last.content, kind: "preference" },
      );
    }
    if (
      script.forgetWord &&
      body.tools !== undefined &&
      last.content.includes(script.forgetWord)
    ) {
      return tool("forget", { text: script.forget ?? last.content });
    }
    if (
      script.delegateWord &&
      script.botId &&
      body.tools !== undefined &&
      last.content.includes(script.delegateWord)
    ) {
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: {
                      name: "ask_bot",
                      arguments: JSON.stringify({
                        bot_id: script.botId,
                        message: last.content,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    if (script.reply) {
      return sse([{ choices: [{ delta: { content: script.reply } }] }]);
    }
    return sse([
      { choices: [{ delta: { content: "You said: " } }] },
      { choices: [{ delta: { content: `${last.content}.` } }] },
    ]);
  }

  // -- probe RPCs -----------------------------------------------------------

  async probeTraces(): Promise<VoiceTraceLine[]> {
    return [...this.#traces];
  }

  async probeSetScript(script: VoiceProbeScript): Promise<void> {
    this.#script = script;
  }

  async probeSessions(): Promise<
    { id: number; fed: number[]; closed: boolean }[]
  > {
    return this.#sessions.map(({ id, fed, closed }) => ({ id, fed, closed }));
  }

  /** The fake transcriber "hears" a finished utterance on the newest session. */
  async probeUtterance(text: string): Promise<boolean> {
    const session = [...this.#sessions].reverse().find((s) => !s.closed);
    if (!session) return false;
    session.options.onUtterance?.(text);
    return true;
  }

  async probeSpeechStart(): Promise<boolean> {
    const session = [...this.#sessions].reverse().find((s) => !s.closed);
    if (!session) return false;
    session.options.onSpeechStart?.();
    return true;
  }

  async probeSynthesized(): Promise<string[]> {
    return [...this.#synthesized];
  }

  async probeChats(): Promise<number> {
    return this.#chats.length;
  }

  /** Every request's messages, so a test can prove what a call carried. */
  async probeChatMessages(): Promise<{ role: string; content: string }[][]> {
    return this.#chats.map(
      (body) => body.messages as { role: string; content: string }[],
    );
  }

  async probeSystemPrompts(): Promise<string[]> {
    return this.#chats.map((body) => {
      const messages = body.messages as { role: string; content: string }[];
      return (
        messages.find((message) => message.role === "system")?.content ?? ""
      );
    });
  }

  async probeSetNow(now: string): Promise<void> {
    this.#now = now;
  }

  async probeStorage(prefix: string): Promise<Record<string, unknown>> {
    const rows = await this.ctx.storage.list<unknown>({ prefix });
    return Object.fromEntries(rows);
  }

  async probeDropDispatches(count: number): Promise<void> {
    this.#dropDispatches = count;
  }

  async probeDispatched(): Promise<string[]> {
    return [...this.#dispatched];
  }

  async probePutStorage(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  /**
   * Holds the model's answer open, so the call has a reply in flight for as
   * long as the test wants one.
   */
  async probeStallChat(): Promise<void> {
    this.#stalled = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  /** Lets the held answer through. */
  async probeReleaseChat(): Promise<void> {
    const release = this.#release;
    this.#stalled = undefined;
    this.#release = undefined;
    release?.();
  }

  /** Runs the scheduled look-up by hand, as the alarm would. */
  async probeCheckDelegation(runId: string): Promise<void> {
    await this.checkDelegation({ runId });
  }

  // -- session memory -------------------------------------------------------

  /** Records the memory lines too, so a test reads what an operator would. */
  protected override traceMemory(
    event: string,
    fields: Record<string, unknown> = {},
    level: "info" | "warn" = "info",
  ): void {
    this.#traces.push({ event, ...fields } as VoiceTraceLine);
    void level;
  }

  async probeMemory(): Promise<VoiceMemoryRecordV1> {
    return this.memory().read();
  }

  async probeMemoryJobs(): Promise<VoiceMemoryJobV1[]> {
    return this.memory().jobs();
  }

  async probeMemoryRequests(): Promise<VoiceMemoryRequest[]> {
    return this.#memoryRequests.map((request) => ({ ...request }));
  }

  /** Runs the scheduled finalization by hand, as the alarm would. */
  async probeFinalizeMemory(callId: string): Promise<void> {
    await this.finalizeVoiceMemory({ callId });
  }

  /** Runs the abandoned-call alarm by hand. */
  async probeAbandonCall(callId: string): Promise<void> {
    await this.abandonVoiceCall({ callId });
  }

  /**
   * Every scheduled row, so a test can prove one end produced one job. The
   * payload is JSON rather than an object: an unknown crossing the RPC stub
   * collapses to `never` and costs the array its element type.
   */
  async probeSchedules(): Promise<VoiceScheduleRow[]> {
    return [...this.getSchedules()].map((schedule) => ({
      callback: schedule.callback,
      payload: JSON.stringify(schedule.payload ?? null),
    }));
  }

  /** Re-runs what waking does, without tearing the object down. */
  async probeRestart(): Promise<void> {
    await this.onStart();
  }
}
