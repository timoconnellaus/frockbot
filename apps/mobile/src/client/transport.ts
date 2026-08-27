import type { WebToolActivity } from "@frockbot/plugin-shell/shared";

export interface TurnEvent {
  type: string;
  call?: { id: string; name: string };
  callId?: string;
  content?: string;
  isError?: boolean;
}

export interface TurnResponse {
  runId: string;
  text: string;
  events: TurnEvent[];
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = source[key];
  if (typeof value !== "string") {
    throw new Error(`${label} field "${key}" must be a string`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} field "${key}" must be a string`);
  }
  return value;
}

function decodeTurnEvent(value: unknown): TurnEvent {
  const source = record(value, "turn event");
  const event: TurnEvent = {
    type: requiredString(source, "type", "turn event"),
  };
  if (source.call !== undefined) {
    const call = record(source.call, "tool call");
    event.call = {
      id: requiredString(call, "id", "tool call"),
      name: requiredString(call, "name", "tool call"),
    };
  }
  event.callId = optionalString(source, "callId", "turn event");
  event.content = optionalString(source, "content", "turn event");
  if (source.isError !== undefined) {
    if (typeof source.isError !== "boolean") {
      throw new Error('turn event field "isError" must be a boolean');
    }
    event.isError = source.isError;
  }
  return event;
}

export function decodeTurnResponse(value: unknown): TurnResponse {
  const source = record(value, "turn response");
  const events = source.events;
  if (!Array.isArray(events)) {
    throw new Error('turn response field "events" must be an array');
  }
  return {
    runId: requiredString(source, "runId", "turn response"),
    text: requiredString(source, "text", "turn response"),
    events: events.map(decodeTurnEvent),
  };
}

export function decodeRunList(value: unknown): RunSummary[] {
  const source = record(value, "run list");
  const runs = source.runs;
  if (!Array.isArray(runs)) {
    throw new Error('run list field "runs" must be an array');
  }
  return runs.map((run) => {
    const entry = record(run, "run");
    return {
      runId: requiredString(entry, "runId", "run"),
      sessionId: requiredString(entry, "sessionId", "run"),
      acceptedAt: requiredString(entry, "acceptedAt", "run"),
      input: requiredString(entry, "input", "run"),
    };
  });
}

export function toolsFrom(events: readonly TurnEvent[]): WebToolActivity[] {
  const tools = new Map<string, WebToolActivity>();
  for (const event of events) {
    if (event.type === "tool/call" && event.call) {
      tools.set(event.call.id, {
        id: event.call.id,
        name: event.call.name,
        status: "running",
      });
    }
    if (event.type === "tool/result" && event.callId) {
      const tool = tools.get(event.callId);
      if (tool) {
        tool.status = event.isError ? "failed" : "completed";
        tool.text = event.content;
      }
    }
  }
  return [...tools.values()];
}

function turnsPath(botId: string): string {
  return `/api/bots/${encodeURIComponent(botId)}/turns`;
}

async function decodeBody(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`gateway returned a malformed response (${response.status})`);
  }
  if (!response.ok) {
    const error =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown }).error
        : undefined;
    throw new Error(
      typeof error === "string" ? error : `gateway request failed (${response.status})`,
    );
  }
  return body;
}

export async function requestTurn(
  fetcher: Fetcher,
  botId: string,
  text: string,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const response = await fetcher(turnsPath(botId), {
    method: "POST",
    body: JSON.stringify({ text }),
    signal,
  });
  return decodeTurnResponse(await decodeBody(response));
}

export async function listRuns(
  fetcher: Fetcher,
  botId: string,
  signal?: AbortSignal,
): Promise<RunSummary[]> {
  const response = await fetcher(turnsPath(botId), { method: "GET", signal });
  return decodeRunList(await decodeBody(response));
}
