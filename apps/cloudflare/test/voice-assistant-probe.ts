// The voice session object as the workerd suite drives it: the real class
// with its upstream replaced by a scripted Gemini fake, plus a few RPCs that
// let a test read what that fake saw and make it answer.
//
// The fake is the point. What the suite proves is the object's own behaviour
// — ownership, exclusivity, sleep and wake ordering, the ledger, a delegation
// across an eviction — not that Gemini answers.
import type { Connection } from "agents";
import { VoiceAssistant } from "../src/voice-assistant.ts";
import { GeminiFakeV1, type GeminiFakeFrameV1 } from "./voice-gemini-fake.ts";
import type { VoiceDelegationRecordV1 } from "@frockbot/app/voice/ledger";
import type {
  VoiceMemoryJobV1,
  VoiceMemoryRecordV1,
} from "@frockbot/app/voice/memory";

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

/** What the end-of-call memory request answers with. */
export interface VoiceProbeScript {
  memory?: {
    operations?: Record<string, unknown>[];
    raw?: string;
    fail?: boolean;
  };
  /** The next opened session refuses, as an unreachable upstream does. */
  refuseUpstream?: boolean;
  /**
   * The next opened session closes with this code the moment it is opened. A
   * 1008 is the real server's answer to a resumption handle it has forgotten.
   */
  closeUpstreamWith?: number;
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
  audioChunks?: number;
  audioBytes?: number;
  turns?: number;
  turn?: string;
  tool?: string;
  run?: string;
  bot?: string;
  voice?: string;
  state?: string;
  source?: string;
  resumed?: boolean;
  handover?: number;
  ms?: number;
  failure?: string;
  answerChars?: number;
}

export class WorkerdVoiceAssistant extends VoiceAssistant {
  #fakes: GeminiFakeV1[] = [];
  #script: VoiceProbeScript = {};
  #dropDispatches = 0;
  #dispatched: string[] = [];
  #traces: VoiceTraceLine[] = [];
  #now: string | undefined;
  #memoryRequests: VoiceMemoryRequest[] = [];
  #silenceTimeoutMs: number | undefined;
  #idleSleepMs: number | undefined;

  protected override now(): Date {
    return this.#now ? new Date(this.#now) : super.now();
  }

  protected override modelSilenceTimeoutMs(): number {
    return this.#silenceTimeoutMs ?? super.modelSilenceTimeoutMs();
  }

  protected override serverIdleSleepMs(): number {
    return this.#idleSleepMs ?? super.serverIdleSleepMs();
  }

  /**
   * The upstream, as one half of a pair. The url is the one the object built
   * from `VOICE_ASSISTANT_UPSTREAM_URL`, so the test still proves the object
   * reads the var and puts its key on it.
   */
  protected override async openGeminiSocket(url: string): Promise<WebSocket> {
    if (this.#script.refuseUpstream) {
      throw new Error("upstream refused the upgrade (503)");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // The production seam accepts the socket before handing it back; a socket
    // nobody accepted throws on its first send.
    client.accept();
    // Outbound Worker sockets deliver Google's binary JSON as Blobs by default.
    client.binaryType = "blob";
    const fake = new GeminiFakeV1(url, server);
    this.#fakes.push(fake);
    const closeWith = this.#script.closeUpstreamWith;
    if (closeWith !== undefined) {
      this.#script = { ...this.#script, closeUpstreamWith: undefined };
      // After the object has had a chance to send its setup, as the real
      // server's refusal does.
      setTimeout(
        () => fake.close(closeWith, "Requested entity was not found."),
        10,
      );
    }
    return client;
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

  /** Records the memory lines too, so a test reads what an operator would. */
  protected override traceMemory(
    event: string,
    fields: Record<string, unknown> = {},
    level: "info" | "warn" = "info",
  ): void {
    this.#traces.push({ event, ...fields } as VoiceTraceLine);
    void level;
  }

  /**
   * Only the end-of-call memory update goes to a chat model now, so this seam
   * answers that one request and nothing else.
   */
  protected override async chatCompletion(
    body: Record<string, unknown>,
  ): Promise<ReadableStream<Uint8Array>> {
    const messages = body.messages as { role: string; content: string }[];
    const last = messages.at(-1)!;
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

  // -- driving the fake upstream --------------------------------------------

  /** The newest session the object opened, which is the live one. */
  #fake(): GeminiFakeV1 | undefined {
    return this.#fakes.at(-1);
  }

  async probeUpstreamCount(): Promise<number> {
    return this.#fakes.length;
  }

  /** Every frame the newest session received, oldest first. */
  async probeUpstreamFrames(): Promise<GeminiFakeFrameV1[]> {
    return [...(this.#fake()?.frames ?? [])];
  }

  /** Every frame every session of this object received. */
  async probeAllUpstreamFrames(): Promise<GeminiFakeFrameV1[][]> {
    return this.#fakes.map((fake) => [...fake.frames]);
  }

  /** The URL the object opened the newest session with, key and all. */
  async probeUpstreamUrl(): Promise<string> {
    return this.#fake()?.url ?? "";
  }

  /** The session transcribes what the person said. */
  async probeHears(text: string): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.hears(text);
    return true;
  }

  /** One whole spoken turn: audio, its transcript, and both boundaries. */
  async probeSays(text: string, audioBytes?: number): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.says(text, audioBytes);
    return true;
  }

  /** Audio with no boundary: a turn still in flight. */
  async probeSpeaks(audioBytes?: number): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.speaks(audioBytes);
    return true;
  }

  async probeEndsTurn(): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.endsTurn();
    return true;
  }

  async probeCalls(
    name: string,
    args: Record<string, unknown>,
    id = "call_1",
  ): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.calls(name, args, id);
    return true;
  }

  async probeCancelsCalls(ids: string[]): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.cancels(ids);
    return true;
  }

  async probeInterrupted(): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.interrupted();
    return true;
  }

  async probeGoAway(): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.goAway();
    return true;
  }

  async probeCloseUpstream(code = 1006, reason = "dropped"): Promise<boolean> {
    const fake = this.#fake();
    if (!fake) return false;
    fake.close(code, reason);
    return true;
  }

  // -- probe RPCs -----------------------------------------------------------

  async probeTraces(): Promise<VoiceTraceLine[]> {
    return [...this.#traces];
  }

  async probeSetScript(script: VoiceProbeScript): Promise<void> {
    this.#script = script;
  }

  async probeSetSilenceTimeoutMs(ms: number): Promise<void> {
    this.#silenceTimeoutMs = ms;
  }

  async probeSetIdleSleepMs(ms: number): Promise<void> {
    this.#idleSleepMs = ms;
  }

  async probeSetNow(now: string): Promise<void> {
    this.#now = now;
  }

  async probeStorage(prefix: string): Promise<Record<string, unknown>> {
    const rows = await this.ctx.storage.list<unknown>({ prefix });
    return Object.fromEntries(rows);
  }

  async probePutStorage(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async probeDropDispatches(count: number): Promise<void> {
    this.#dropDispatches = count;
  }

  async probeDispatched(): Promise<string[]> {
    return [...this.#dispatched];
  }

  /** Runs the scheduled look-up by hand, as the alarm would. */
  async probeCheckDelegation(runId: string): Promise<void> {
    await this.checkDelegation({ runId });
  }

  /**
   * Scheduled announcements firing at once, which is a thing the scheduler
   * does: each held answer books its own row, and two rows that come due
   * together run together. Nothing here reaches past the public callback.
   */
  async probeAnnounceConcurrently(runIds: string[]): Promise<void> {
    await Promise.all(
      runIds.map((runId) => this.announceDelegation({ runId })),
    );
  }

  // -- session memory -------------------------------------------------------

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
