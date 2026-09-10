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
import { VoiceAssistant } from "../src/voice-assistant.ts";
import type { VoiceDelegationRecordV1 } from "@frockbot/app/voice/ledger";

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

export class WorkerdVoiceAssistant extends VoiceAssistant {
  #sessions: ProbeSession[] = [];
  #synthesized: string[] = [];
  #chats: Record<string, unknown>[] = [];
  #script: VoiceProbeScript = {};
  #dropDispatches = 0;
  #dispatched: string[] = [];

  /** A one-second window, so a cap can bite inside a test's patience. */
  protected override sttWindowSeconds(): number {
    return 1;
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

  protected override createTts() {
    return {
      synthesize: async (text: string) => {
        this.#synthesized.push(text);
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
    this.#chats.push(body);
    const messages = body.messages as { role: string; content: string }[];
    const last = messages.at(-1)!;
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
    return sse([
      { choices: [{ delta: { content: "You said: " } }] },
      { choices: [{ delta: { content: `${last.content}.` } }] },
    ]);
  }

  // -- probe RPCs -----------------------------------------------------------

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

  /** Runs the scheduled look-up by hand, as the alarm would. */
  async probeCheckDelegation(runId: string): Promise<void> {
    await this.checkDelegation({ runId });
  }
}
