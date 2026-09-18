// Opt-in latency diagnostics for one voice call, server side.
//
// A client build that asked for them (`FROCKBOT_VOICE_DIAGNOSTICS`, off in
// everything shipped) puts one randomly generated id on the assistant socket
// as `?trace=`. When — and only when — that value is a UUID, the entry Worker
// and the voice object write a line per milestone under it, so the two sides
// of a slow call can be read next to each other.
//
// Three things keep this safe to leave in the tree:
//
//   * **The trace is not authority.** It names nothing, grants nothing and is
//     never stored. The bearer header still decides who may open the socket;
//     this only decides whether a few extra `console.info` lines are written.
//   * **Validated, or ignored.** Anything that is not a UUID enables nothing
//     and is never echoed into a log, so a crafted URL cannot put a string of
//     its choosing into an operator's log stream.
//   * **Metadata only.** Each line carries the id, the side, the milestone,
//     elapsed milliseconds, a wall stamp and named numeric or enum fields.
//     Never a word spoken, never a prompt, never a header, never a credential,
//     never an upstream key.

import { VOICE_ASSISTANT_PATH_V1 } from "./shared.js";

/** The query parameter the client puts its id on. */
export const VOICE_TRACE_QUERY_V1 = "trace";

/** What every diagnostic line starts with, both sides. */
export const VOICE_TIMING_PREFIX_V1 = "voice timing";

const UUID_V1 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a value is the one shape a trace may have: a canonical UUID. */
export function isVoiceTraceIdV1(value: unknown): value is string {
  return typeof value === "string" && UUID_V1.test(value);
}

/**
 * The trace a request carries, or undefined.
 *
 * Undefined is the answer for a request that named none, named something that
 * is not a UUID, or named several — a repeated parameter is a client nobody
 * wrote, and diagnostics are not worth guessing which one it meant.
 */
export function voiceTraceOfV1(url: URL): string | undefined {
  const values = url.searchParams.getAll(VOICE_TRACE_QUERY_V1);
  if (values.length !== 1) return undefined;
  return isVoiceTraceIdV1(values[0]) ? values[0] : undefined;
}

/**
 * One side's clock and id: the milestones of one call, or nothing at all.
 *
 * `performance.now()` is the clock because it is monotonic where it moves at
 * all. On Workers it is pinned between I/O — two marks with no I/O between
 * them read the same millisecond, which is the truth about that code: it did
 * no waiting. Elapsed is from this object's own start and belongs to this
 * process; a client's elapsed is from the person's press on the client's
 * clock, and the two are never subtracted from one another.
 */
export class VoiceTimingV1 {
  private readonly origin = performance.now();
  private readonly said = new Set<string>();

  constructor(
    readonly trace: string,
    private readonly write: (line: string) => void = (line) =>
      console.info(VOICE_TIMING_PREFIX_V1, line),
    private readonly side: "server" | "edge" = "server",
  ) {}

  get elapsedMs(): number {
    return Math.max(0, Math.round(performance.now() - this.origin));
  }

  /**
   * One milestone. `fields` is a whitelist by construction: every call site
   * names its keys, and each value is a number, a boolean or a short token
   * this code chose.
   */
  mark(event: string, fields: Record<string, unknown> = {}): void {
    this.write(
      JSON.stringify({
        trace: this.trace,
        side: this.side,
        event,
        elapsedMs: this.elapsedMs,
        at: new Date().toISOString(),
        ...fields,
      }),
    );
  }

  /** A milestone that means "the first of these on this call". */
  markOnce(event: string, fields: Record<string, unknown> = {}): void {
    if (this.said.has(event)) return;
    this.said.add(event);
    this.mark(event, fields);
  }
}

/**
 * The timing sink for a request, or undefined when it asked for none. The
 * undefined is the point: every call site is `timing?.mark(…)`, so a request
 * without diagnostics does no work and writes no line.
 */
export function voiceTimingForV1(
  url: URL,
  side: "server" | "edge" = "server",
): VoiceTimingV1 | undefined {
  const trace = voiceTraceOfV1(url);
  return trace === undefined
    ? undefined
    : new VoiceTimingV1(trace, undefined, side);
}

/**
 * The edge's own timing for the assistant upgrade, or undefined.
 *
 * `edge` rather than `server` because it is a different process from the voice
 * object's: the Worker in front of it. Its milestones are the ones the object
 * cannot see — the entry, the backend mount, authentication, the forward — and
 * they all happen before `onConnect` runs.
 */
export function voiceAssistantEdgeTimingV1(
  url: URL,
): VoiceTimingV1 | undefined {
  if (url.pathname !== VOICE_ASSISTANT_PATH_V1) return undefined;
  return voiceTimingForV1(url, "edge");
}

/**
 * The same, from a request's url string. The substring test comes first
 * because every request to the deployment passes through this and almost none
 * of them is this one; a `new URL` for all of them would not be worth a
 * diagnostic nobody asked for.
 */
export function voiceAssistantEdgeTimingOfV1(
  requestUrl: string,
): VoiceTimingV1 | undefined {
  if (!requestUrl.includes(VOICE_ASSISTANT_PATH_V1)) return undefined;
  try {
    return voiceAssistantEdgeTimingV1(new URL(requestUrl));
  } catch {
    return undefined;
  }
}
