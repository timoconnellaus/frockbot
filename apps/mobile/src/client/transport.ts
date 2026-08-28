import type {
  ClientRun,
  ClientTurnEvent,
  ClientTurnResponse,
} from "@frockbot/client-core";
import {
  decodeClientRunLookupV1,
  decodeClientRunListV1,
  decodeClientTurnV1,
  type ClientRunLookup,
} from "@frockbot/plugin-shell/run-protocol";
import type { WebToolActivity } from "@frockbot/plugin-shell/shared";

export type TurnEvent = ClientTurnEvent;
export type TurnResponse = ClientTurnResponse;

export type RunSummary = ClientRun;

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export function decodeTurnResponse(value: unknown): TurnResponse {
  return decodeClientTurnV1(value);
}

export function decodeRunList(value: unknown): RunSummary[] {
  return decodeClientRunListV1(value);
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
    throw new Error(
      `gateway returned a malformed response (${response.status})`,
    );
  }
  if (!response.ok) {
    const error =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown }).error
        : undefined;
    throw new Error(
      typeof error === "string"
        ? error
        : `gateway request failed (${response.status})`,
    );
  }
  return body;
}

export async function requestTurn(
  fetcher: Fetcher,
  botId: string,
  text: string,
  commandId: string,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  const response = await fetcher(turnsPath(botId), {
    method: "POST",
    body: JSON.stringify({ text, commandId }),
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

export async function lookupRun(
  fetcher: Fetcher,
  botId: string,
  commandId: string,
  signal?: AbortSignal,
): Promise<ClientRunLookup> {
  const response = await fetcher(
    `${turnsPath(botId)}/${encodeURIComponent(commandId)}`,
    { method: "GET", signal },
  );
  const lookup = decodeClientRunLookupV1(await decodeBody(response));
  if (lookup.state !== "not-admitted" && lookup.run.runId !== commandId) {
    throw new Error("run lookup response does not match the command id");
  }
  return lookup;
}
