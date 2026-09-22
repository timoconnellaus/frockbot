import type {
  SearchIndexResultsV1,
  SearchRowKindV1,
} from "@frockbot/app/search/shared";
import type { ClientRunV1 } from "@frockbot/app/shell/run-protocol";
import type { SendToUserPayloadV1 } from "@frockbot/core/contracts";

export const VOICE_HISTORY_DEFAULT_LIMIT_V1 = 6;
export const VOICE_HISTORY_MAX_LIMIT_V1 = 8;
export const VOICE_HISTORY_TEXT_CHARS_V1 = 320;
export const VOICE_HISTORY_RESULT_CHARS_V1 = 3_900;

export interface VoiceBotHistorySourceV1 {
  botId: string;
  botName: string;
  runs: readonly ClientRunV1[];
  hasMore?: boolean;
}

export interface VoiceBotSearchSourceV1 extends VoiceBotHistorySourceV1 {
  results: SearchIndexResultsV1;
}

interface VoiceHistoryMessageV1 {
  role: "user" | "assistant" | "voice" | "bot";
  at: string;
  runId: string;
  messageId?: string;
  text: string;
  fromBotId?: string;
  to?: "user" | "voice" | "bot";
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function requester(
  run: ClientRunV1,
): Pick<VoiceHistoryMessageV1, "role" | "fromBotId"> {
  if (run.via?.kind === "voice") return { role: "voice" };
  if (run.via?.kind === "bot") {
    return { role: "bot", fromBotId: run.via.botId };
  }
  return { role: "user" };
}

function visibleDeliveryText(payload: SendToUserPayloadV1): string {
  switch (payload.type) {
    case "text":
      return payload.text;
    case "attachment":
      return `Shared attachment: ${payload.name ?? payload.mediaType ?? "file"}`;
    case "widget":
      return `Asked: ${payload.widget.prompt} Options: ${payload.widget.options.join("; ")}`;
    case "secret-request":
      return `Requested a secret: ${payload.prompt}`;
    case "agent-card":
      return `${payload.title}${payload.body ? `: ${payload.body}` : ""}`;
    case "approval":
      return `Approval requested: ${payload.action}${payload.rationale ? ` — ${payload.rationale}` : ""}`;
    case "card":
      // A voice caller hears what happened, not the surface: the components
      // are for a screen, and reading them aloud would be noise.
      return `Showed a card: ${payload.surfaceId}`;
  }
}

function visibleMessages(run: ClientRunV1): VoiceHistoryMessageV1[] {
  const source = { runId: run.runId, at: run.admittedAt };
  const messages: VoiceHistoryMessageV1[] = [];
  let replyCount = 0;
  if (run.input.trim()) {
    messages.push({
      ...source,
      ...requester(run),
      messageId: `${run.runId}:${run.via?.kind === "voice" ? "voice" : "user"}`,
      text: clip(run.input, VOICE_HISTORY_TEXT_CHARS_V1),
    });
  }
  for (const event of run.events) {
    if (event.type === "send/to-user") {
      messages.push({
        ...source,
        role: "assistant",
        to: "user",
        messageId: `${run.runId}:send:${event.ordinal}`,
        text: clip(
          visibleDeliveryText(event.payload),
          VOICE_HISTORY_TEXT_CHARS_V1,
        ),
      });
    } else if (event.type === "reply/to-caller") {
      messages.push({
        ...source,
        role: "assistant",
        to: event.caller,
        messageId: `${run.runId}:reply:${replyCount++}`,
        text: clip(event.text, VOICE_HISTORY_TEXT_CHARS_V1),
      });
    }
  }
  return messages;
}

function limitCount(limit: number): number {
  return Math.max(1, Math.min(VOICE_HISTORY_MAX_LIMIT_V1, Math.floor(limit)));
}

/** Admission time is the timestamp the public run projection actually has. */
function renderResult(
  source: VoiceBotHistorySourceV1,
  messages: VoiceHistoryMessageV1[],
  extra: Record<string, unknown>,
  oldestFirst: boolean,
): string {
  const body = {
    botId: source.botId,
    botName: clip(source.botName, 60),
    timestamp: "turn admission",
    ...extra,
    truncated: extra.truncated === true,
    messages,
  };
  let result = JSON.stringify(body);
  while (result.length > VOICE_HISTORY_RESULT_CHARS_V1 && messages.length) {
    if (oldestFirst) messages.shift();
    else messages.pop();
    body.truncated = true;
    result = JSON.stringify(body);
  }
  return result;
}

/** Only explicit conversation deliveries are readable; model scratch is not. */
export function renderVoiceBotHistoryV1(
  source: VoiceBotHistorySourceV1,
  limit = VOICE_HISTORY_DEFAULT_LIMIT_V1,
): string {
  const runs = [...source.runs].sort((left, right) =>
    left.admittedAt.localeCompare(right.admittedAt),
  );
  const messages = runs.flatMap(visibleMessages);
  const count = limitCount(limit);
  return renderResult(
    source,
    messages.slice(-count),
    { truncated: source.hasMore === true || messages.length > count },
    true,
  );
}

export function renderVoiceBotSearchV1(
  source: VoiceBotSearchSourceV1,
  limit = VOICE_HISTORY_DEFAULT_LIMIT_V1,
): string {
  const runs = new Map(source.runs.map((run) => [run.runId, run]));
  const allowedKinds: readonly SearchRowKindV1[] = ["user", "assistant"];
  const messages: VoiceHistoryMessageV1[] = [];
  for (const hit of source.results.hits) {
    if (hit.botId !== source.botId || !allowedKinds.includes(hit.kind))
      continue;
    const run = runs.get(hit.runId);
    if (!run) continue;
    if (
      hit.kind === "assistant" &&
      !run.events.some(
        (event) =>
          event.type === "reply/to-caller" ||
          (event.type === "send/to-user" && event.payload.type === "text"),
      )
    )
      continue;
    messages.push({
      ...(hit.kind === "user"
        ? requester(run)
        : { role: "assistant" as const }),
      at: hit.at,
      runId: hit.runId,
      text: clip(hit.snippet, VOICE_HISTORY_TEXT_CHARS_V1),
    });
  }
  const count = limitCount(limit);
  return renderResult(
    source,
    messages.slice(0, count),
    {
      query: source.results.query,
      indexState: source.results.indexState,
      truncated:
        source.results.truncated ||
        source.results.hits.length > messages.length ||
        Boolean(source.results.nextCursor) ||
        messages.length > count,
      source: "indexed conversation; use status for current progress",
    },
    false,
  );
}

export function renderVoiceBotStatusV1(
  source: VoiceBotHistorySourceV1,
): string {
  const runs = [...source.runs].sort((left, right) =>
    right.admittedAt.localeCompare(left.admittedAt),
  );
  const running = runs.filter((run) => run.status === "running");
  const active = running.find((run) => !run.queued);
  const latest = runs[0];
  const request = active ?? latest;
  const lastMessage = runs
    .flatMap((run) => visibleMessages(run).reverse())
    .find((message) => message.role === "assistant");
  return JSON.stringify({
    botId: source.botId,
    botName: clip(source.botName, 60),
    activity: active ? "working" : running.length ? "queued" : "idle",
    queued: running.filter((run) => run.queued).length,
    ...(request
      ? {
          request: {
            runId: request.runId,
            at: request.admittedAt,
            status: request.queued ? "queued" : request.status,
            text: clip(request.input, VOICE_HISTORY_TEXT_CHARS_V1),
            ...requester(request),
          },
        }
      : {}),
    ...(lastMessage ? { lastMessage } : {}),
  });
}
