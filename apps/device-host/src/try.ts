// `plugin_module_try`'s runner, on the Bot's Computer (ADR 0037).
//
// The Worker cannot start a process, so the try is orchestrated here, beside
// the module: this starts it under the same supervisor and runtime the Mac's
// host uses, invokes one call or waits for one event, and hands back what
// happened. The host's side of the module's requests is a stand-in: an emit is
// recorded and sent nowhere, `lastKey` and the store answer from what the Bot
// seeded, and Apple Events refuse, because only the Mac holds the consent.

import type { ChildProcess } from "node:child_process";

import type {
  PluginModuleTryRequestV1,
  PluginModuleTryResultV1,
} from "@frockbot/core/contracts";

import { ModuleSupervisorV1 } from "./supervisor.ts";

/** One line of one command's output, which the Computer caps at 30 000. */
const RESULT_MAX_BYTES = 24_000;
const MAX_EVENTS = 20;
const MAX_LOGS = 40;
const LOG_TEXT_MAX = 500;
const VALUE_TEXT_MAX = 12_000;
const PAYLOAD_TEXT_MAX = 2_000;

/**
 * The accesses Deno refused, from any text the module or Deno wrote. Deno
 * says each one the same way — `Requires read access to "/etc/hosts", run
 * again with the --allow-read flag` — whether the module caught the error,
 * threw it from a call, or died of it.
 */
export function moduleDenialsV1(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /Requires ([a-z]+) access to ("[^"]*"|[^\s,]+)/g,
    )) {
      found.add(`${match[1]} ${match[2]}`);
    }
  }
  return [...found];
}

/** A value as JSON, or its first characters when it is too long to return. */
function bounded(
  value: unknown,
  max: number,
): { value: unknown; cut: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return { value: String(value).slice(0, max), cut: true };
  }
  return text.length <= max
    ? { value, cut: false }
    : { value: `${text.slice(0, max)}…`, cut: true };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs one try and answers what happened. Never throws. */
export async function runModuleTryV1(
  request: PluginModuleTryRequestV1,
  seams: { spawn(): ChildProcess },
): Promise<PluginModuleTryResultV1> {
  const events: PluginModuleTryResultV1["events"] = [];
  const logs: PluginModuleTryResultV1["logs"] = [];
  const store = new Map(Object.entries(request.store));
  const action = request.action;
  let exited: string | undefined;
  let heard!: () => void;
  const eventHeard = new Promise<void>((resolve) => {
    heard = resolve;
  });
  let ended!: () => void;
  const processEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const supervisor = new ModuleSupervisorV1(request.module, {
    spawn: seams.spawn,
    emit: async (event, payload, key) => {
      events.push({ event, key, payload });
      if ("event" in action && event === action.event) heard();
    },
    lastKey: async (event) => request.lastKeys[event],
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    appleEvents: async (bundleId) => {
      throw new Error(
        `Apple Events run only on the person's Mac, so ${bundleId} was not scripted here. Give the module a stand-in for what the script would answer, or try this part there.`,
      );
    },
    report: (report) => {
      if (report.kind === "log") {
        logs.push({ level: report.level, text: report.text });
      } else if (report.state === "crashed") {
        exited = report.detail ?? "the module exited";
        ended();
      }
    },
    // A try runs the module once: a crash is its answer, not a restart.
    delay: () => new Promise(() => {}),
  });
  supervisor.start();
  const deadline = sleep(request.startMs + request.waitMs).then(() => "late");
  const result: PluginModuleTryResultV1 = { events, logs, denials: [] };
  try {
    if ("call" in action) {
      const outcome = await Promise.race([
        supervisor.call(action.call, action.input, request.waitMs),
        deadline.then(() => ({
          ok: false as const,
          error: `the module did not start and answer within ${request.startMs + request.waitMs}ms`,
        })),
      ]);
      result.call = outcome;
    } else {
      await Promise.race([eventHeard, processEnded, deadline]);
      result.heard = events.some((emitted) => emitted.event === action.event);
    }
  } finally {
    supervisor.stop();
  }
  if (exited !== undefined) result.exited = exited;
  result.denials = moduleDenialsV1([
    ...(result.call && !result.call.ok ? [result.call.error] : []),
    ...logs.map((line) => line.text),
    ...(exited === undefined ? [] : [exited]),
  ]);
  return fitModuleTryResultV1(result);
}

/**
 * The result, small enough for one line of one command's output. The call's
 * answer and the denials are what the Bot came for, so logs go first, then
 * events, and what was cut is said.
 */
export function fitModuleTryResultV1(
  result: PluginModuleTryResultV1,
  maxBytes = RESULT_MAX_BYTES,
): PluginModuleTryResultV1 {
  const trimmed: string[] = [];
  const fitted: PluginModuleTryResultV1 = { ...result };
  if (fitted.call?.ok) {
    const value = bounded(fitted.call.value, VALUE_TEXT_MAX);
    if (value.cut) trimmed.push("the call's value, as JSON");
    fitted.call = { ok: true, value: value.value };
  }
  if (fitted.events.length > MAX_EVENTS) {
    trimmed.push(`${fitted.events.length - MAX_EVENTS} later event(s)`);
  }
  fitted.events = fitted.events.slice(0, MAX_EVENTS).map((event) => {
    const payload = bounded(event.payload, PAYLOAD_TEXT_MAX);
    if (payload.cut)
      trimmed.push(`the payload of "${event.event}" ${event.key}`);
    return { ...event, payload: payload.value };
  });
  if (fitted.logs.length > MAX_LOGS) {
    trimmed.push(`${fitted.logs.length - MAX_LOGS} earlier log line(s)`);
  }
  fitted.logs = fitted.logs
    .slice(-MAX_LOGS)
    .map((line) => ({ ...line, text: line.text.slice(0, LOG_TEXT_MAX) }));
  const size = () =>
    new TextEncoder().encode(JSON.stringify({ ...fitted, trimmed })).byteLength;
  let logsCut = 0;
  while (size() > maxBytes && fitted.logs.length > 0) {
    fitted.logs = fitted.logs.slice(1);
    logsCut += 1;
  }
  if (logsCut > 0) trimmed.push(`${logsCut} more earlier log line(s)`);
  let eventsCut = 0;
  while (size() > maxBytes && fitted.events.length > 0) {
    fitted.events = fitted.events.slice(0, -1);
    eventsCut += 1;
  }
  if (eventsCut > 0) trimmed.push(`${eventsCut} more later event(s)`);
  if (fitted.exited !== undefined && size() > maxBytes) {
    fitted.exited = fitted.exited.slice(0, 2_000);
  }
  return trimmed.length === 0 ? fitted : { ...fitted, trimmed };
}
