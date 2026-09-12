// What the voice assistant says to the model, and how it reads the answer.
//
// The assistant is not a Bot: it has no Session log, no Composition and no
// tools of its own beyond the handful that reach the User's Bots. Its whole
// job is to answer short questions from what the account already knows and to
// hand substantial work to the Bot that owns it. So this module is small on
// purpose — a prompt, four tools, a bounded loop over an OpenAI-compatible
// chat stream — and it imports nothing from the agent loop.
//
// Everything is injected: the model stream, the Bot directory, the delegation
// door, memory. It is tested in bun with fakes and hosted by the Durable
// Object adapter.
import type { MemoryTierReadV1 } from "@frockbot/app/memory/store";
import { VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1 } from "./shared.js";

export interface VoiceBotSummaryV1 {
  botId: string;
  name: string;
  description?: string;
  /** Live: what the Bot is doing right now, read from its durable run state. */
  activity?: "idle" | "working";
}

export interface VoiceAssistantMemoryContextV1 {
  /** The User's shared memory, read at call start. */
  user?: MemoryTierReadV1;
  /** Facts injected from the log are bounded to this many days back. */
  logDays: number;
}

export interface VoiceAssistantPromptInputV1 {
  bots: readonly VoiceBotSummaryV1[];
  memory: VoiceAssistantMemoryContextV1;
  /** Answers from Bots that settled while nobody was listening. */
  unspoken: readonly { botName: string; text: string }[];
  now: Date;
}

/** Bounds on what the prompt carries; spoken context should stay short. */
export const VOICE_PROMPT_MAX_PROFILE_FACTS_V1 = 40;
export const VOICE_PROMPT_MAX_LOG_FACTS_V1 = 30;
export const VOICE_PROMPT_MAX_FACT_CHARS_V1 = 240;
export const VOICE_PROMPT_MAX_BOTS_V1 = 32;
export const VOICE_PROMPT_HISTORY_MESSAGES_V1 = 12;
export const VOICE_TURN_MAX_STEPS_V1 = 4;
export const VOICE_TURN_MAX_TOKENS_V1 = 400;
export const VOICE_ANSWER_MAX_CHARS_V1 = 1_200;
/**
 * Said aloud when the model goes to a tool without having said anything: a
 * tool step is a second model round-trip plus the tool itself, which is
 * seconds of silence to the person if nothing fills them. It is spoken, not
 * answered — the ledger's answer is the model's own words only.
 */
export const VOICE_TURN_BRIDGE_V1 = "One moment.";

/**
 * One thing to say. `bridge` is the turn's own filler, `text` is the model's
 * own words: a caller that times the model must not count the bridge as the
 * model having spoken.
 */
export interface VoiceTurnChunkV1 {
  kind: "bridge" | "text";
  text: string;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function escapeTag(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

/** The system prompt, rendered from durable facts and live Bot state. */
export function renderVoiceSystemPromptV1(
  input: VoiceAssistantPromptInputV1,
): string {
  const lines: string[] = [
    "You are FrockBot's voice assistant. You are speaking aloud with the person who owns this account, across every Bot they have.",
    "Rules:",
    "- Answer in one to three short spoken sentences. No markdown, no lists, no code.",
    "- Do only light work yourself: answer from what you know, summarise, check on Bots. Anything substantial — research, writing, running tools, changing settings — you delegate with ask_bot to the Bot whose job it is, then say you have asked them.",
    "- Use list_bots or bot_status before claiming what a Bot is doing. Never guess a Bot's state from memory.",
    "- Only cancel a Bot when the person clearly asks you to stop that Bot by name, and confirm which one.",
    "- If you did not understand, say so briefly instead of guessing.",
    `The date is ${input.now.toISOString().slice(0, 10)}.`,
  ];
  const bots = input.bots.slice(0, VOICE_PROMPT_MAX_BOTS_V1);
  if (bots.length > 0) {
    lines.push("<bots>");
    for (const bot of bots) {
      lines.push(
        `- ${escapeTag(bot.botId)}: ${escapeTag(clip(bot.name, 60))}${
          bot.description ? ` — ${escapeTag(clip(bot.description, 120))}` : ""
        }${bot.activity ? ` (${bot.activity})` : ""}`,
      );
    }
    lines.push("</bots>");
  } else {
    lines.push("The account has no Bots yet.");
  }
  const memory = input.memory.user;
  if (memory) {
    const cutoff = new Date(
      input.now.getTime() - input.memory.logDays * 24 * 60 * 60_000,
    )
      .toISOString()
      .slice(0, 10);
    const profile = memory.profile
      .slice(-VOICE_PROMPT_MAX_PROFILE_FACTS_V1)
      .map(
        (fact) =>
          `- ${escapeTag(clip(fact.text, VOICE_PROMPT_MAX_FACT_CHARS_V1))}`,
      );
    const recent = memory.recent
      .filter((fact) => fact.date >= cutoff)
      .slice(-VOICE_PROMPT_MAX_LOG_FACTS_V1)
      .map(
        (fact) =>
          `- ${fact.date}: ${escapeTag(clip(fact.text, VOICE_PROMPT_MAX_FACT_CHARS_V1))}`,
      );
    if (profile.length > 0 || recent.length > 0) {
      lines.push("<memory>");
      lines.push(
        "What the account remembers about this person and their work:",
      );
      lines.push(...profile);
      if (recent.length > 0) {
        lines.push("Recent:");
        lines.push(...recent);
      }
      lines.push("</memory>");
    }
    if (memory.unavailable) {
      lines.push("(Memory could not be read right now.)");
    }
  }
  if (input.unspoken.length > 0) {
    lines.push("<answers>");
    lines.push(
      "These Bot answers arrived while the person was away. Mention them first, briefly:",
    );
    for (const answer of input.unspoken.slice(0, 5)) {
      lines.push(
        `- ${escapeTag(clip(answer.botName, 60))}: ${escapeTag(clip(answer.text, 400))}`,
      );
    }
    lines.push("</answers>");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools

export const VOICE_TOOLS_V1 = [
  {
    type: "function",
    function: {
      name: "list_bots",
      description:
        "List this person's Bots with what each is doing right now. Read from live state.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bot_status",
      description:
        "What one Bot is doing right now and the last thing it said. Use the bot id from list_bots.",
      parameters: {
        type: "object",
        properties: { bot_id: { type: "string" } },
        required: ["bot_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_bot",
      description:
        "Hand a request to one of the person's Bots as a message in that Bot's own conversation. Returns at once; the Bot works on its own and its answer is read out when it settles. Use for anything more than a quick spoken answer.",
      parameters: {
        type: "object",
        properties: {
          bot_id: { type: "string" },
          message: { type: "string", description: "What to ask, in full." },
        },
        required: ["bot_id", "message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_bot",
      description:
        "Stop the Turn a Bot is running now. Only when the person explicitly asked to stop that Bot.",
      parameters: {
        type: "object",
        properties: { bot_id: { type: "string" } },
        required: ["bot_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_project",
      description:
        "Read the shared memory of one of the person's Projects when the question is about it. Use the project id from a Bot's description or the person's words.",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
  },
] as const;

export type VoiceToolNameV1 =
  (typeof VOICE_TOOLS_V1)[number]["function"]["name"];

export interface VoiceToolCallV1 {
  id: string;
  name: string;
  arguments: string;
}

export interface VoiceModelMessageV1 {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

/** The host the turn loop talks to. Every method is injected. */
export interface VoiceAssistantHostV1 {
  /** One streamed chat completion. Resolves to SSE bytes. */
  chat(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  listBots(): Promise<VoiceBotSummaryV1[]>;
  botStatus(botId: string): Promise<string>;
  askBot(botId: string, message: string): Promise<string>;
  cancelBot(botId: string): Promise<string>;
  recallProject(projectId: string): Promise<string>;
}

export interface VoiceTurnResultV1 {
  answer: string;
  /** How many `ask_bot` calls this turn made. */
  delegations: number;
  outcome: "answered" | "no_output" | "aborted";
}

/**
 * Runs one spoken turn: the model, its tool calls, the model again, bounded.
 *
 * Text is yielded as it streams so the caller can start synthesising at
 * once; a step that ends in tool calls runs the tools before the next step,
 * and if nothing has been said yet in the turn it yields the bridge first so
 * the wait is not silent. Tool results are appended to the messages the caller
 * owns, so the next turn sees them through the SDK's own history only as the
 * final spoken answer — tool chatter never enters the durable history.
 */
export async function* runVoiceTurnV1(
  host: VoiceAssistantHostV1,
  input: {
    system: string;
    history: readonly { role: "user" | "assistant"; content: string }[];
    transcript: string;
    signal: AbortSignal;
  },
  onResult: (result: VoiceTurnResultV1) => void,
): AsyncGenerator<VoiceTurnChunkV1> {
  const messages: VoiceModelMessageV1[] = [
    { role: "system", content: input.system },
    ...input.history
      .slice(-VOICE_PROMPT_HISTORY_MESSAGES_V1)
      .map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: input.transcript },
  ];
  let delegations = 0;
  let spoken = "";
  let bridged = false;
  for (let step = 0; step < VOICE_TURN_MAX_STEPS_V1; step += 1) {
    if (input.signal.aborted) {
      onResult({ answer: spoken, delegations, outcome: "aborted" });
      return;
    }
    const last = step === VOICE_TURN_MAX_STEPS_V1 - 1;
    const stream = await host.chat(
      {
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: VOICE_TURN_MAX_TOKENS_V1,
        temperature: 0.4,
        // The last step must speak: no tools, so the model cannot loop.
        ...(last ? {} : { tools: VOICE_TOOLS_V1, tool_choice: "auto" }),
      },
      input.signal,
    );
    let text = "";
    const calls: VoiceToolCallV1[] = [];
    for await (const event of parseChatCompletionStreamV1(stream)) {
      if (input.signal.aborted) {
        onResult({ answer: spoken, delegations, outcome: "aborted" });
        return;
      }
      if (event.type === "text") {
        text += event.text;
        if (spoken.length + text.length <= VOICE_ANSWER_MAX_CHARS_V1) {
          spoken += event.text;
          yield { kind: "text", text: event.text };
        }
      } else if (event.type === "tool-call") {
        calls.push(event.call);
      }
    }
    if (calls.length === 0) {
      onResult({
        answer: spoken.trim(),
        delegations,
        outcome: spoken.trim() ? "answered" : "no_output",
      });
      return;
    }
    if (!spoken.trim() && !bridged) {
      bridged = true;
      yield { kind: "bridge", text: `${VOICE_TURN_BRIDGE_V1} ` };
    }
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const call of calls) {
      let result: string;
      try {
        const args = parseArguments(call.arguments);
        switch (call.name) {
          case "list_bots": {
            const bots = await host.listBots();
            result =
              bots.length === 0
                ? "No Bots yet."
                : bots
                    .map(
                      (bot) =>
                        `${bot.botId}: ${bot.name}${bot.activity ? ` (${bot.activity})` : ""}${bot.description ? ` — ${clip(bot.description, 120)}` : ""}`,
                    )
                    .join("\n");
            break;
          }
          case "bot_status":
            result = await host.botStatus(stringArgument(args, "bot_id"));
            break;
          case "ask_bot": {
            if (delegations >= VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1) {
              result =
                "Refused: this turn has already asked enough Bots. Tell the person and stop.";
              break;
            }
            delegations += 1;
            result = await host.askBot(
              stringArgument(args, "bot_id"),
              stringArgument(args, "message"),
            );
            break;
          }
          case "cancel_bot":
            result = await host.cancelBot(stringArgument(args, "bot_id"));
            break;
          case "recall_project":
            result = await host.recallProject(
              stringArgument(args, "project_id"),
            );
            break;
          default:
            result = `Unknown tool ${call.name}.`;
        }
      } catch (error) {
        result = `That failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: clip(result, 4_000),
      });
    }
  }
  onResult({
    answer: spoken.trim(),
    delegations,
    outcome: spoken.trim() ? "answered" : "no_output",
  });
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible SSE

export type VoiceChatStreamEventV1 =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: VoiceToolCallV1 }
  | { type: "finish"; reason: string | undefined };

/** Bytes per SSE event before the stream is refused as hostile. */
export const VOICE_CHAT_MAX_EVENT_BYTES_V1 = 1024 * 1024;

/**
 * Reads an OpenAI-compatible `chat/completions` stream: text deltas as they
 * arrive, tool calls accumulated by index and emitted when the stream ends.
 */
export async function* parseChatCompletionStreamV1(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<VoiceChatStreamEventV1> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const calls = new Map<number, VoiceToolCallV1>();
  let finish: string | undefined;
  let done = false;
  const handle = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    const choice = (
      parsed as {
        choices?: { delta?: Record<string, unknown>; finish_reason?: string }[];
      }
    ).choices?.[0];
    if (!choice) return false;
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return false;
    if (typeof delta.content === "string" && delta.content) {
      pendingText.push(delta.content);
    }
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const item of toolCalls) {
        if (!item || typeof item !== "object") continue;
        const part = item as {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const index = typeof part.index === "number" ? part.index : calls.size;
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof part.id === "string" && part.id) call.id = part.id;
        if (typeof part.function?.name === "string" && part.function.name) {
          call.name = part.function.name;
        }
        if (typeof part.function?.arguments === "string") {
          call.arguments += part.function.arguments;
        }
        calls.set(index, call);
      }
    }
    return false;
  };
  const pendingText: string[] = [];
  try {
    while (!done) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > VOICE_CHAT_MAX_EVENT_BYTES_V1) {
        throw new Error("model stream event is too large");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (handle(line)) {
          done = true;
          break;
        }
        while (pendingText.length > 0) {
          yield { type: "text", text: pendingText.shift()! };
        }
      }
    }
    if (!done && buffer.trim()) handle(buffer);
    while (pendingText.length > 0) {
      yield { type: "text", text: pendingText.shift()! };
    }
  } finally {
    reader.releaseLock();
  }
  for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.name) continue;
    yield {
      type: "tool-call",
      call: { ...call, id: call.id || `call-${call.name}` },
    };
  }
  yield { type: "finish", reason: finish };
}
