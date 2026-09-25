// The frames between the module host and one module's process: one JSON
// object per line over the process's stdin and stdout.
//
// The module's side is untrusted, so the host decodes every frame it reads and
// treats a malformed one as the module failing, never as an instruction.

export const MODULE_LOG_TEXT_MAX_V1 = 2_000;
export const MODULE_FRAME_BYTES_MAX_V1 = 1_024 * 1_024;

/** What the host asks the module's process. */
export type HostFrameV1 =
  | { type: "start" }
  | { type: "call"; id: number; call: string; input: unknown }
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

/** What a module may ask of the host, through its context. */
export const MODULE_REQUEST_OPS_V1 = [
  "emit",
  "lastKey",
  "store.get",
  "store.set",
  "store.delete",
  "appleEvents.run",
] as const;

export type ModuleRequestOpV1 = (typeof MODULE_REQUEST_OPS_V1)[number];

/** What the module's process says. */
export type ModuleFrameV1 =
  | { type: "ready"; calls: string[]; start: boolean }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "request"; id: number; op: ModuleRequestOpV1; args: unknown[] }
  | { type: "log"; level: "log" | "error"; text: string };

function fail(message: string): never {
  throw new Error(`module frame: ${message}`);
}

function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("bad id");
  return value as number;
}

/** One line from the module's stdout, decoded strictly. */
export function decodeModuleFrameV1(line: string): ModuleFrameV1 {
  if (line.length > MODULE_FRAME_BYTES_MAX_V1) fail("too large");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail("not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("not an object");
  }
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      if (
        !Array.isArray(frame.calls) ||
        !frame.calls.every((call) => typeof call === "string") ||
        typeof frame.start !== "boolean"
      ) {
        fail("bad ready");
      }
      return {
        type: "ready",
        calls: frame.calls as string[],
        start: frame.start,
      };
    case "result":
      if (frame.ok === true) {
        return {
          type: "result",
          id: id(frame.id),
          ok: true,
          value: frame.value,
        };
      }
      if (frame.ok === false && typeof frame.error === "string") {
        return {
          type: "result",
          id: id(frame.id),
          ok: false,
          error: frame.error.slice(0, MODULE_LOG_TEXT_MAX_V1),
        };
      }
      return fail("bad result");
    case "request": {
      const op = MODULE_REQUEST_OPS_V1.find((known) => known === frame.op);
      if (!op || !Array.isArray(frame.args)) fail("bad request");
      return { type: "request", id: id(frame.id), op, args: frame.args };
    }
    case "log":
      if (
        (frame.level !== "log" && frame.level !== "error") ||
        typeof frame.text !== "string"
      ) {
        fail("bad log");
      }
      return {
        type: "log",
        level: frame.level,
        text: frame.text.slice(0, MODULE_LOG_TEXT_MAX_V1),
      };
    default:
      return fail("unknown type");
  }
}
