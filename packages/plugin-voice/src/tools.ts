import type { VoicePendingAnswerV1, VoiceToolNameV1 } from "./shared.js";

export interface VoiceBotSummaryV1 {
  botId: string;
  name: string;
  status: "active" | "archived";
}

export interface VoiceBotActivityV1 {
  botId: string;
  since: string;
  runs: Array<{
    runId: string;
    status: string;
    startedAt: string;
    partialText?: string;
  }>;
  tasks: Array<{ taskId: string; title: string; status: string }>;
  pendingInbox: number;
}

export interface VoiceMemoryHitV1 {
  scope: "user" | "bot";
  botId?: string;
  path: string;
  snippet: string;
  score: number;
}

export interface VoiceToolHostV1 {
  listBots(): Promise<readonly VoiceBotSummaryV1[]>;
  botActivity(botId: string, since?: string): Promise<VoiceBotActivityV1>;
  memorySearch(input: {
    query: string;
    botId?: string;
  }): Promise<readonly VoiceMemoryHitV1[]>;
  pendingAnswers(): Promise<readonly VoicePendingAnswerV1[]>;
}

export interface GeminiFunctionDeclarationV1 {
  name: VoiceToolNameV1;
  description: string;
  parameters: Record<string, unknown>;
}

export interface VoiceToolSpecV1 {
  declaration: GeminiFunctionDeclarationV1;
  label(args: Record<string, unknown>): string;
  execute(
    host: VoiceToolHostV1,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

function noExtraArgs(args: Record<string, unknown>): void {
  if (Object.keys(args).length > 0)
    throw new Error("tool arguments are invalid");
}

function stringArg(
  args: Record<string, unknown>,
  name: string,
  max: number,
  required = true,
): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(`${name} must be a bounded string`);
  }
  return value.trim();
}

function only(args: Record<string, unknown>, names: readonly string[]): void {
  const allowed = new Set(names);
  if (Object.keys(args).some((name) => !allowed.has(name))) {
    throw new Error("tool arguments are invalid");
  }
}

function boundedJson(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= 16_000) return value;
  return { truncated: true, summary: json.slice(0, 15_000) };
}

/** B2 extends this table with `ask_bot`; transport code does not switch on names. */
export const VOICE_TOOL_TABLE_V1: Readonly<
  Record<VoiceToolNameV1, VoiceToolSpecV1>
> = {
  list_bots: {
    declaration: {
      name: "list_bots",
      description: "List this person's Bots and whether each is active.",
      parameters: { type: "OBJECT", properties: {} },
    },
    label: () => "Checked your Bots",
    async execute(host, args) {
      noExtraArgs(args);
      return { bots: (await host.listBots()).slice(0, 50) };
    },
  },
  bot_activity: {
    declaration: {
      name: "bot_activity",
      description:
        "Read one Bot's recent runs, in-progress reply, running tasks, and waiting inbox items.",
      parameters: {
        type: "OBJECT",
        properties: {
          bot: { type: "STRING", description: "The Bot id." },
          since: {
            type: "STRING",
            description: "Optional ISO timestamp for the oldest activity.",
          },
        },
        required: ["bot"],
      },
    },
    label: (args) => `Checked ${String(args.bot ?? "a Bot")}'s activity`,
    async execute(host, args) {
      only(args, ["bot", "since"]);
      const botId = stringArg(args, "bot", 128)!;
      const since = stringArg(args, "since", 64, false);
      if (since && !Number.isFinite(Date.parse(since))) {
        throw new Error("since must be an ISO timestamp");
      }
      return boundedJson(await host.botActivity(botId, since));
    },
  },
  memory_search: {
    declaration: {
      name: "memory_search",
      description:
        "Search durable User memory and Bot memory without waking a Computer.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "What to look for." },
          bot: {
            type: "STRING",
            description: "Optional Bot id. Omit to search all Bot tiers.",
          },
        },
        required: ["query"],
      },
    },
    label: () => "Searched memory",
    async execute(host, args) {
      only(args, ["query", "bot"]);
      return {
        results: (
          await host.memorySearch({
            query: stringArg(args, "query", 512)!,
            ...(stringArg(args, "bot", 128, false)
              ? { botId: stringArg(args, "bot", 128, false)! }
              : {}),
          })
        ).slice(0, 24),
      };
    },
  },
  pending_answers: {
    declaration: {
      name: "pending_answers",
      description: "Read Bot answers waiting to be spoken to this person.",
      parameters: { type: "OBJECT", properties: {} },
    },
    label: () => "Checked answers waiting for you",
    async execute(host, args) {
      noExtraArgs(args);
      return { answers: (await host.pendingAnswers()).slice(0, 32) };
    },
  },
};

export const VOICE_FUNCTION_DECLARATIONS_V1 = Object.values(
  VOICE_TOOL_TABLE_V1,
).map((tool) => tool.declaration);

export async function executeVoiceToolV1(
  host: VoiceToolHostV1,
  input: { name: string; args?: unknown },
): Promise<{ name: VoiceToolNameV1; label: string; result: unknown }> {
  const tool = VOICE_TOOL_TABLE_V1[input.name as VoiceToolNameV1];
  if (!tool) throw new Error("That Voice tool is unavailable.");
  const args = input.args ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments must be an object");
  }
  const record = args as Record<string, unknown>;
  return {
    name: input.name as VoiceToolNameV1,
    label: tool.label(record).slice(0, 160),
    result: await tool.execute(host, record),
  };
}
