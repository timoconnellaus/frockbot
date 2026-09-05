import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { Store } from "@tanstack/store";
import { sessionAppendedEvent, sessionKey } from "./keys";
import type {
  Message,
  SessionEntry,
  SessionEntryInput,
  SessionLog,
  ToolCall,
  ToolOutcome,
} from "./types";

/** How a tool outcome reaches the model: a string as-is, anything else as JSON. */
const outcomeContent = (outcome: ToolOutcome): string => {
  if (!outcome.ok) return outcome.error;
  if (typeof outcome.value === "string") return outcome.value;
  if (outcome.value === undefined) return "";
  return JSON.stringify(outcome.value);
};

/**
 * How a **human step** reads to the model: a note in the person's own voice,
 * because a person's tool call has no assistant message asking for it. A tool
 * result quoting a call the model never made is not something a provider will
 * accept, so the fold turns the pair into one `user` message instead.
 */
const humanNote = (
  name: string,
  call: ToolCall | undefined,
  outcome: ToolOutcome,
): string => {
  const args =
    call === undefined || call.args === undefined
      ? ""
      : ` with ${JSON.stringify(call.args)}`;
  const result = outcome.ok
    ? outcomeContent(outcome)
    : `error: ${outcome.error}`;
  return `The operator ran the tool "${name}"${args} — result: ${result}`;
};

/**
 * Fold a session log into the messages one request sees. Pure and total, so
 * deriving twice from the same log gives the same messages, and a log replayed
 * into a fresh client derives the same messages (B2, B3).
 *
 * `chunk` entries are the streaming trace of the `assistant` entry that follows
 * them and are deliberately not derived; the `assistant` entry carries the
 * complete text. A `human-tool-call` is likewise the trace of the
 * `human-tool-result` that follows it, which carries the whole note.
 */
export function deriveMessages(
  entries: ReadonlyArray<SessionEntry>,
): Array<Message> {
  const messages: Array<Message> = [];
  /** The human calls seen so far, so a result can quote what was asked for. */
  const humanCalls = new Map<string, ToolCall>();
  for (const entry of entries) {
    if (entry.kind === "human-tool-call") {
      humanCalls.set(entry.call.id, entry.call);
      continue;
    }
    if (entry.kind === "human-tool-result") {
      messages.push({
        role: "user",
        content: humanNote(
          entry.name,
          humanCalls.get(entry.callId),
          entry.outcome,
        ),
      });
      continue;
    }
    if (entry.kind === "input") {
      messages.push({ role: "user", content: entry.text });
    } else if (entry.kind === "assistant") {
      messages.push({
        role: "assistant",
        content: entry.text,
        toolCalls: entry.toolCalls,
      });
    } else if (entry.kind === "tool-result") {
      messages.push({
        role: "tool",
        callId: entry.callId,
        name: entry.name,
        content: outcomeContent(entry.outcome),
        isError: !entry.outcome.ok,
      });
    }
  }
  return messages;
}

/** Entries a session may be forked or replayed from: the step and turn boundaries. */
const isBoundary = (entry: SessionEntry): boolean =>
  entry.kind === "step-closed" || entry.kind === "turn-closed";

const sessionOptions = optionsSchema<
  { entries?: ReadonlyArray<SessionEntry> } | undefined,
  { entries: Array<SessionEntry> }
>((value) => ({ entries: [...(value?.entries ?? [])] }));

/** Optional persistence owned by the example hosting the session plugin. */
export interface SessionPersistence {
  load: () => Promise<ReadonlyArray<SessionEntry> | undefined>;
  save: (entries: ReadonlyArray<SessionEntry>) => void;
}

/**
 * The session log: the source of truth for one conversation. Provides
 * {@link sessionKey}, emits {@link sessionAppendedEvent} for every append, and
 * can be seeded with entries to replay or fork a conversation (B3).
 *
 * @example
 * ```ts
 * { id: 'session', plugin: sessionPlugin, options: { entries: forked } }
 * ```
 */
export const createSessionPlugin = (persistence?: SessionPersistence) =>
  createPlugin({
    name: "session",
    provides: [sessionKey],
    validator: sessionOptions,
    async setup(instance, options) {
      const restored = await persistence?.load();
      const initial = restored ? [...restored] : options.entries;
      const entries = new Store<Array<SessionEntry>>(initial);
      let sequence = initial.reduce((highest, entry) => {
        const parsed = Number.parseInt(entry.id.replace(/^e/, ""), 10);
        return Number.isNaN(parsed) ? highest : Math.max(highest, parsed);
      }, initial.length);

      const log: SessionLog = {
        entries,
        append: (input: SessionEntryInput) => {
          sequence += 1;
          const entry: SessionEntry = {
            ...input,
            id: `e${sequence}`,
            at: Date.now(),
          };
          entries.setState((previous) => [...previous, entry]);
          persistence?.save(entries.state);
          instance.emit(sessionAppendedEvent, entry);
          return entry;
        },
        snapshot: () => [...entries.state],
        messages: () => deriveMessages(entries.state),
        fork: (entryId: string) => {
          const at = entries.state.findIndex((entry) => entry.id === entryId);
          if (at === -1) {
            throw new Error(
              `agent example: no session entry "${entryId}" to fork at`,
            );
          }
          const entry = entries.state[at]!;
          if (!isBoundary(entry)) {
            throw new Error(
              `agent example: session entry "${entryId}" is a "${entry.kind}", not a step or turn boundary`,
            );
          }
          return entries.state.slice(0, at + 1).map((each) => ({ ...each }));
        },
      };

      instance.provide(sessionKey, log);
    },
  });

/** In-memory session plugin used by the browser-only example and tests. */
export const sessionPlugin = createSessionPlugin();
