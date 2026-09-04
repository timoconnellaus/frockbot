/**
 * The one piece both the **model provider** and the proxy need: reading the
 * server-sent-event frames a Workers AI streaming response is made of, and
 * turning one frame's payload into the provider-neutral streamed shape.
 *
 * Workers AI answers a streaming text-generation request with an SSE body whose
 * `data:` payloads are the model's own JSON, terminated by `[DONE]`. Two shapes
 * are in the wild and this module reads both, because which one a model answers
 * with is the model's business and not the agent's:
 *
 * - the native shape, `{ "response": "…", "tool_calls": [{ "name", "arguments" }] }`
 * - the chat-completions shape, `{ "choices": [{ "delta": { … } }] }`
 */

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** A tool call being built out of frames that each carry a piece of it. */
export interface PartialCall {
  id: string;
  name: string;
  /** The arguments as text, concatenated in arrival order. */
  arguments: string;
}

/** One frame's payload, in either of the two shapes Workers AI answers with. */
export interface AiFrame {
  error?: string | { message?: string };
  /** The native shape: the whole of this frame's generated text. */
  response?: string | null;
  /** The native shape: complete tool calls, arguments already parsed. */
  tool_calls?: Array<{
    id?: string;
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }>;
  /**
   * The chat-completions shape. A streamed frame carries a `delta`; a model that
   * answered all at once carries a `message`, and the two read the same.
   */
  choices?: Array<{
    finish_reason?: string | null;
    delta?: ChatPart;
    message?: ChatPart;
  }>;
}

/** The part of a chat-completions choice that carries the answer. */
interface ChatPart {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** Whichever of the two a frame used. */
const partOf = (frame: AiFrame): ChatPart | undefined =>
  frame.choices?.[0]?.delta ?? frame.choices?.[0]?.message;

/** The error a quiet model ends with. */
const stalled = (stallMs: number): Error =>
  new Error(
    `@frockbot/compose-cloudflare: the model sent nothing for ${stallMs} ms`,
  );

/**
 * Wait for one step of the answer, but not for longer than `stallMs` when that
 * is above zero. A binding whose upstream has gone away otherwise holds the
 * step open forever, and the turn with it.
 */
export const withinStall = async <T>(
  work: Promise<T>,
  stallMs: number,
): Promise<T> => {
  if (stallMs <= 0) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stalled(stallMs)), stallMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Split a server-sent-event body into its `data:` payloads. The protocol frames
 * events with a blank line, so a read that stops mid-event is held back until
 * the rest of it arrives; a stream that ends mid-event drops the fragment
 * rather than parsing half of it.
 *
 * The reader is released when the loop ends, however it ends — returning early
 * because the turn was cancelled runs the `finally` and cancels the body, which
 * is what stops Workers AI generating (C5, E1).
 */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  stallMs = 0,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stop = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await withinStall(reader.read(), stallMs);
      if (done) break;
      // Event boundaries are a blank line, whichever line ending the server
      // uses; a CRLF stream would otherwise never split.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) yield line.slice(5).trim();
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * The frames of one answer, however the binding gave it.
 *
 * Usually that is a `ReadableStream` of server-sent events. Some models answer
 * `stream: true` with the whole thing at once anyway, and that is read as a
 * single frame rather than treated as a failure — the caller sees one long text
 * chunk instead of many, which is a worse experience and a working one.
 */
export async function* aiFrames(
  answer: unknown,
  signal?: AbortSignal,
  stallMs = 0,
): AsyncGenerator<AiFrame> {
  if (answer instanceof ReadableStream) {
    for await (const data of sseEvents(
      answer as ReadableStream<Uint8Array>,
      signal,
      stallMs,
    )) {
      if (data === "" || data === "[DONE]") continue;
      yield JSON.parse(data) as AiFrame;
    }
    return;
  }
  if (typeof answer === "object" && answer !== null) {
    yield answer;
    return;
  }
  throw new Error(
    `@frockbot/compose-cloudflare: the Workers AI binding answered with ${typeof answer}, not a stream`,
  );
}

/** The message an error frame carries, or `undefined` if it is not one. */
export const errorOf = (frame: AiFrame): string | undefined => {
  if (frame.error === undefined) return undefined;
  if (typeof frame.error === "string") return frame.error;
  return frame.error.message ?? "the stream reported an error";
};

/** The text this frame adds, in whichever shape it arrived. */
export const textOf = (frame: AiFrame): string => {
  // Workers AI sends both shapes in one frame for some models: the chat delta
  // and the native `response` carry the same text. Read one, never both.
  const part = partOf(frame);
  if (part !== undefined) {
    return typeof part.content === "string" ? part.content : "";
  }
  return typeof frame.response === "string" ? frame.response : "";
};

/**
 * Fold this frame's tool-call pieces into the calls being built. Chat-completions
 * deltas carry an `index` and arrive in pieces — the name in one frame, the
 * arguments split across the next several — so a call is keyed by its index and
 * its argument text is concatenated. Native frames carry a whole call at once
 * and are keyed past whatever the deltas are using, so the two never collide.
 */
export const foldToolCalls = (
  frame: AiFrame,
  partials: Map<number, PartialCall>,
): void => {
  for (const [at, call] of (partOf(frame)?.tool_calls ?? []).entries()) {
    const index = call.index ?? at;
    const partial = partials.get(index) ?? { id: "", name: "", arguments: "" };
    partials.set(index, {
      id: call.id ?? partial.id,
      name: call.function?.name ?? partial.name,
      arguments: partial.arguments + (call.function?.arguments ?? ""),
    });
  }

  for (const call of frame.tool_calls ?? []) {
    const args = call.arguments ?? call.function?.arguments;
    partials.set(partials.size === 0 ? 0 : Math.max(...partials.keys()) + 1, {
      id: call.id ?? "",
      name: call.name ?? call.function?.name ?? "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
};

/** The calls built so far, in the order the model issued them. */
export const assembleToolCalls = (
  partials: ReadonlyMap<number, PartialCall>,
): Array<ToolCall> =>
  [...partials.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, partial]) => ({
      id: partial.id === "" ? `call-${index + 1}` : partial.id,
      name: partial.name,
      // A model that called a tool with no arguments sends none; anything else
      // is the model's JSON and is parsed here so the tool's validator sees a
      // value rather than a string (D3).
      args: partial.arguments === "" ? {} : JSON.parse(partial.arguments),
    }));
