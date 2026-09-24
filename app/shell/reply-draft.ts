/**
 * The reply a Bot is writing, drawn before it is sent.
 *
 * A Bot's voice is `send_to_user`, and a send exists only once the model has
 * finished the step and the tool has run. What the person can be shown sooner
 * is the call being written: the `text` of a `send_to_user` — alone, or inside
 * a `batch` — read out of its arguments as the model streams them.
 *
 * A draft is a preview and nothing else. It is never journaled and never
 * replayed; the Session reconstructs every model request exactly as it did
 * before drafts existed, and an eviction simply loses the draft. Its only
 * identity is where its sends will land: `ordinal` is the position the first
 * part's message will take among its run's sends, so a client draws each part
 * where that message will be and lets the message replace it.
 */
import {
  BATCH_MAX_CALLS_V1,
  BATCH_TOOL_NAME,
  SEND_TO_USER_LIMITS_V1,
} from "@frockbot/core/contracts";
import type {
  ToolInputDispatchV1,
  ToolInputWatchV1,
} from "@frockbot/core/agent-loop/agent";
import { SEND_TO_USER_TOOL_V1 } from "./agent.js";

/** The state channel's `state/draft` frame, less its envelope. */
export interface ReplyDraftV1 {
  runId: string;
  /** Where the first part's message will land among its run's sends. */
  ordinal: number;
  /**
   * One entry per send the step is writing, in the order they will land. An
   * empty entry is a send with nothing to draw yet — a card, or text not yet
   * begun — which still holds its place.
   */
  parts: string[];
}

/** Most parts one draft carries: one batch's worth of sends. */
export const REPLY_DRAFT_MAX_PARTS_V1 = BATCH_MAX_CALLS_V1;
/** How often a draft is redrawn while the model writes. */
export const REPLY_DRAFT_INTERVAL_MS_V1 = 100;
/**
 * The argument text one dispatch may hold for drafting. Past it the draft
 * stops growing and the message arrives whole, as it always has.
 */
export const REPLY_DRAFT_INPUT_MAX_CHARS_V1 = 262_144;

// ------------------------------------------------------- the partial reader

/** What a prefix holds of one value, and whether the prefix finished it. */
interface ReadValue {
  value: unknown;
  complete: boolean;
}

const HEX = /^[0-9a-fA-F]{4}$/;
const SCALAR =
  /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

class PartialJsonReader {
  #at = 0;
  constructor(private readonly text: string) {}

  value(): ReadValue | undefined {
    this.#skipSpace();
    if (this.#at >= this.text.length) return undefined;
    switch (this.text[this.#at]) {
      case "{":
        return this.#object();
      case "[":
        return this.#array();
      case '"':
        return this.#string();
      default:
        return this.#scalar();
    }
  }

  #skipSpace(): void {
    while (this.#at < this.text.length && /\s/.test(this.text[this.#at]!)) {
      this.#at += 1;
    }
  }

  #object(): ReadValue {
    this.#at += 1;
    const object: Record<string, unknown> = {};
    for (;;) {
      this.#skipSpace();
      const next = this.text[this.#at];
      if (next === undefined) return { value: object, complete: false };
      if (next === "}") {
        this.#at += 1;
        return { value: object, complete: true };
      }
      if (next === ",") {
        this.#at += 1;
        continue;
      }
      if (next !== '"') return { value: object, complete: false };
      const key = this.#string();
      if (!key.complete) return { value: object, complete: false };
      this.#skipSpace();
      if (this.text[this.#at] !== ":")
        return { value: object, complete: false };
      this.#at += 1;
      const value = this.value();
      if (value === undefined) return { value: object, complete: false };
      object[key.value as string] = value.value;
      if (!value.complete) return { value: object, complete: false };
    }
  }

  #array(): ReadValue {
    this.#at += 1;
    const array: unknown[] = [];
    for (;;) {
      this.#skipSpace();
      const next = this.text[this.#at];
      if (next === undefined) return { value: array, complete: false };
      if (next === "]") {
        this.#at += 1;
        return { value: array, complete: true };
      }
      if (next === ",") {
        this.#at += 1;
        continue;
      }
      const value = this.value();
      if (value === undefined) return { value: array, complete: false };
      array.push(value.value);
      if (!value.complete) return { value: array, complete: false };
    }
  }

  /** A string cut short is the words so far, less any escape still arriving. */
  #string(): ReadValue {
    this.#at += 1;
    let out = "";
    const text = this.text;
    while (this.#at < text.length) {
      let end = this.#at;
      while (end < text.length && text[end] !== '"' && text[end] !== "\\") {
        end += 1;
      }
      out += text.slice(this.#at, end);
      this.#at = end;
      if (end >= text.length) break;
      if (text[end] === '"') {
        this.#at += 1;
        return { value: out, complete: true };
      }
      const escape = text[end + 1];
      if (escape === undefined) break;
      if (escape === "u") {
        const hex = text.slice(end + 2, end + 6);
        if (hex.length < 4) break;
        if (!HEX.test(hex)) return { value: out, complete: false };
        const code = Number.parseInt(hex, 16);
        if (isHighSurrogate(code)) {
          // Half a character is not drawn: wait for the half that completes it.
          const low = text.slice(end + 6, end + 12);
          if (low.length < 6) break;
          if (low.startsWith("\\u") && HEX.test(low.slice(2))) {
            out += String.fromCharCode(code, Number.parseInt(low.slice(2), 16));
            this.#at = end + 12;
            continue;
          }
        }
        out += String.fromCharCode(code);
        this.#at = end + 6;
        continue;
      }
      out += SIMPLE_ESCAPES[escape] ?? escape;
      this.#at = end + 2;
    }
    if (out.length > 0 && isHighSurrogate(out.charCodeAt(out.length - 1))) {
      out = out.slice(0, -1);
    }
    return { value: out, complete: false };
  }

  /** A number or literal is read only once something follows it. */
  #scalar(): ReadValue | undefined {
    const match = SCALAR.exec(this.text.slice(this.#at, this.#at + 64));
    if (!match) return undefined;
    const end = this.#at + match[0].length;
    if (end >= this.text.length) return undefined;
    this.#at = end;
    return { value: JSON.parse(match[0]) as unknown, complete: true };
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Reads as much of a JSON value as a prefix of its text holds: every member
 * and element already begun, and the string being written up to its last
 * whole character. Nothing is guessed — a key without its value, or a number
 * that may still grow, is left out until the text says what it is.
 */
export function readPartialJsonV1(text: string): unknown {
  return new PartialJsonReader(text).value()?.value;
}

// ------------------------------------------------------------- the parts

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one `send_to_user` call has written of its text so far. */
function sendText(input: unknown): string {
  if (!isRecord(input) || !isRecord(input.payload)) return "";
  const payload = input.payload;
  // Only a text payload has a `text`. A `type` still being written is let
  // through: the words are drawn the moment it reads `text`.
  if (payload.type !== undefined && payload.type !== "text") return "";
  return typeof payload.text === "string" ? payload.text : "";
}

/**
 * The drafts of one step's calls, in the order their sends will land: one per
 * `send_to_user`, and one per `send_to_user` a `batch` declares. A batch call
 * whose tool is still unnamed ends the reading there, because whether it is a
 * send decides where every part after it lands.
 */
export function replyDraftPartsV1(
  calls: readonly { name: string; input: string }[],
): string[] {
  const parts: string[] = [];
  for (const call of calls) {
    if (call.name === SEND_TO_USER_TOOL_V1) {
      parts.push(sendText(readPartialJsonV1(call.input)));
      continue;
    }
    if (call.name !== BATCH_TOOL_NAME) continue;
    const batch = readPartialJsonV1(call.input);
    const declared = isRecord(batch) ? batch.calls : undefined;
    if (!Array.isArray(declared)) continue;
    for (const [index, sub] of declared.entries()) {
      if (!isRecord(sub)) continue;
      if (sub.tool === SEND_TO_USER_TOOL_V1) {
        parts.push(sendText(sub.arguments));
        continue;
      }
      // Only the last call can still be writing its name.
      const writing = index === declared.length - 1;
      if (
        writing &&
        (typeof sub.tool !== "string" ||
          SEND_TO_USER_TOOL_V1.startsWith(sub.tool))
      ) {
        break;
      }
    }
  }
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.slice(0, REPLY_DRAFT_MAX_PARTS_V1).map(clipV1);
}

/** A send's own bound, never cutting a character in half. */
function clipV1(part: string): string {
  if (part.length <= SEND_TO_USER_LIMITS_V1.text) return part;
  const clipped = part.slice(0, SEND_TO_USER_LIMITS_V1.text);
  return isHighSurrogate(clipped.charCodeAt(clipped.length - 1))
    ? clipped.slice(0, -1)
    : clipped;
}

// ------------------------------------------------------------- the watcher

function sendsIn(journal: readonly { type: string }[]): number {
  let sends = 0;
  for (const event of journal) if (event.type === "send/to-user") sends += 1;
  return sends;
}

/** Whether a call so named could still be writing a reply. */
function mayDraft(name: string): boolean {
  return (
    SEND_TO_USER_TOOL_V1.startsWith(name) || BATCH_TOOL_NAME.startsWith(name)
  );
}

export interface ReplyDraftWatchOptionsV1 {
  runId: string;
  publish(draft: ReplyDraftV1): void;
  intervalMs?: number;
  now?(): number;
  setTimer?(callback: () => void, milliseconds: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * One Turn's tool-input watcher: each dispatch's sends, redrawn at most every
 * `intervalMs` while the model writes, and once more when the dispatch ends
 * so the last words are not held back. A dispatch that opens after one that
 * drew something clears it first, so a send the step never made does not
 * linger past its step.
 */
export function createReplyDraftWatchV1(
  options: ReplyDraftWatchOptionsV1,
): (dispatch: ToolInputDispatchV1) => ToolInputWatchV1 {
  const interval = options.intervalMs ?? REPLY_DRAFT_INTERVAL_MS_V1;
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  let shown: ReplyDraftV1 | undefined;

  const publish = (draft: ReplyDraftV1): void => {
    const before = shown?.parts ?? [];
    if (draft.parts.length === 0 && before.length === 0) return;
    if (
      shown?.ordinal === draft.ordinal &&
      before.length === draft.parts.length &&
      before.every((part, index) => part === draft.parts[index])
    ) {
      return;
    }
    shown = draft;
    options.publish(draft);
  };

  return (dispatch) => {
    // Counted now: the journal is the Session's own and keeps growing.
    const ordinal = sendsIn(dispatch.journal);
    publish({ runId: options.runId, ordinal, parts: [] });
    const calls = new Map<string, { name: string; input: string }>();
    let held = 0;
    let overflowed = false;
    let dirty = false;
    let ended = false;
    let drawnAt = Number.NEGATIVE_INFINITY;
    let timer: unknown;

    const draw = (): void => {
      timer = undefined;
      if (!dirty || overflowed) return;
      dirty = false;
      drawnAt = now();
      publish({
        runId: options.runId,
        ordinal,
        parts: replyDraftPartsV1([...calls.values()]),
      });
    };

    return {
      delta(call, fragment) {
        if (ended || overflowed) return;
        const current = calls.get(call.id) ?? { name: call.name, input: "" };
        current.name = call.name;
        calls.set(call.id, current);
        if (!mayDraft(call.name)) {
          held -= current.input.length;
          current.input = "";
          return;
        }
        current.input += fragment;
        held += fragment.length;
        if (held > REPLY_DRAFT_INPUT_MAX_CHARS_V1) {
          overflowed = true;
          if (timer !== undefined) clearTimer(timer);
          timer = undefined;
          return;
        }
        dirty = true;
        if (timer !== undefined) return;
        const wait = interval - (now() - drawnAt);
        if (wait <= 0) draw();
        else timer = setTimer(draw, wait);
      },
      end() {
        if (ended) return;
        ended = true;
        if (timer !== undefined) clearTimer(timer);
        draw();
      },
    };
  };
}
