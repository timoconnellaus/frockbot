// The durable record of one background process on a Computer, and its codec.
//
// "A mutation or process launch records intent and an effect identifier in the
// Bot's Durable Object and in the Workspace before it runs, so recovery can
// read its outcome or classify it as unknown without repeating it." This record
// is that intent. It is written before `setsid` runs, and every later answer
// about the process is read out of it plus the Computer, never by launching
// anything a second time.
//
// Versioned, exact-field, and decoded at the seam it crosses, in the shape
// `@frockbot/plugin-routines`'s records use. There are no migrations: a record
// the current codec refuses is a visible failure rather than something to
// reshape.

/** The Bot Durable Object key one process record is stored under. */
export const COMPUTER_PROCESS_PREFIX = "computer-process:";

/** Most background process records one Bot may hold. */
export const COMPUTER_PROCESS_LIMIT_PER_BOT = 100;

export const COMPUTER_PROCESS_COMMAND_MAX = 20_000;
export const COMPUTER_PROCESS_ID_MAX = 128;
export const COMPUTER_PROCESS_PATH_MAX = 1_024;

/**
 * What a process is, as durable state.
 *
 * `unknown` is a first-class status, not an error: the Computer wakes only
 * when a Bot uses it, and "other processes are assumed dead after a cold
 * pause". A process whose Computer was reprovisioned under it, or whose pid is
 * gone with no exit file, is `unknown` — and saying so is the observable
 * failure state the constitution asks for. It is never reported as `running`.
 */
export const COMPUTER_PROCESS_STATUSES = [
  "starting",
  "running",
  "exited",
  "unknown",
] as const;

export type ComputerProcessStatusV1 =
  (typeof COMPUTER_PROCESS_STATUSES)[number];

export interface ComputerProcessRecordV1 {
  schemaVersion: 1;
  processId: string;
  botId: string;
  sessionId: string;
  turnId: string;
  command: string;
  cwd: string;
  startedAt: string;
  status: ComputerProcessStatusV1;
  /**
   * The Computer's provisioning generation at launch. A later generation means
   * a different Computer under the same name, so the process is gone by
   * constitution and `check` answers `unknown`.
   */
  generation: number;
  effectId: string;
  pid?: number;
  exitCode?: number;
  logPath: string;
}

export class ComputerProcessDecodeError extends Error {
  override readonly name = "ComputerProcessDecodeError";
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isComputerProcessIdV1(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

export function computerProcessKeyV1(processId: string): string {
  if (!isComputerProcessIdV1(processId)) {
    throw new ComputerProcessDecodeError("Computer process id is invalid");
  }
  return `${COMPUTER_PROCESS_PREFIX}${processId}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputerProcessDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ComputerProcessDecodeError(
        `${label} has unknown field "${key}"`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ComputerProcessDecodeError(`${label} is missing "${key}"`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") {
    throw new ComputerProcessDecodeError(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new ComputerProcessDecodeError(`${label} must not be empty`);
  }
  if (value.length > maximum) {
    throw new ComputerProcessDecodeError(
      `${label} must be at most ${maximum} characters`,
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ComputerProcessDecodeError(
      `${label} must be an ISO-8601 timestamp`,
    );
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ComputerProcessDecodeError(`${label} must be an integer`);
  }
  return value;
}

export function decodeComputerProcessRecordV1(
  value: unknown,
): ComputerProcessRecordV1 {
  const candidate = record(value, "Computer process record");
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "processId",
      "botId",
      "sessionId",
      "turnId",
      "command",
      "cwd",
      "startedAt",
      "status",
      "generation",
      "effectId",
      "logPath",
    ],
    ["pid", "exitCode"],
    "Computer process record",
  );
  if (candidate.schemaVersion !== 1) {
    throw new ComputerProcessDecodeError(
      "Computer process record schemaVersion is unsupported",
    );
  }
  if (!isComputerProcessIdV1(candidate.processId)) {
    throw new ComputerProcessDecodeError(
      "Computer process record processId is invalid",
    );
  }
  const status = COMPUTER_PROCESS_STATUSES.find(
    (known) => known === candidate.status,
  );
  if (!status) {
    throw new ComputerProcessDecodeError(
      "Computer process record status is invalid",
    );
  }
  const generation = integer(
    candidate.generation,
    "Computer process record generation",
  );
  if (generation < 0) {
    throw new ComputerProcessDecodeError(
      "Computer process record generation must not be negative",
    );
  }
  return {
    schemaVersion: 1,
    processId: candidate.processId,
    botId: text(candidate.botId, 200, "Computer process record botId"),
    sessionId: text(
      candidate.sessionId,
      256,
      "Computer process record sessionId",
    ),
    turnId: text(candidate.turnId, 256, "Computer process record turnId"),
    command: text(
      candidate.command,
      COMPUTER_PROCESS_COMMAND_MAX,
      "Computer process record command",
    ),
    cwd: text(
      candidate.cwd,
      COMPUTER_PROCESS_PATH_MAX,
      "Computer process record cwd",
    ),
    startedAt: timestamp(
      candidate.startedAt,
      "Computer process record startedAt",
    ),
    status,
    generation,
    effectId: text(candidate.effectId, 256, "Computer process record effectId"),
    logPath: text(
      candidate.logPath,
      COMPUTER_PROCESS_PATH_MAX,
      "Computer process record logPath",
    ),
    ...(candidate.pid === undefined
      ? {}
      : { pid: integer(candidate.pid, "Computer process record pid") }),
    ...(candidate.exitCode === undefined
      ? {}
      : {
          exitCode: integer(
            candidate.exitCode,
            "Computer process record exitCode",
          ),
        }),
  };
}

/**
 * The status a process holds, given what the Computer answered and the
 * generation it answered under.
 *
 * The whole reconciliation rule in one place, so no caller can decide it
 * differently: a Computer that has been reprovisioned since the launch cannot
 * be holding the process, whatever its pid table says, and a pid that is gone
 * with no recorded exit is `unknown` rather than finished.
 */
export function computerProcessStatusV1(input: {
  recorded: ComputerProcessRecordV1;
  currentGeneration: number;
  observed: {
    /** True when the Computer still holds a live process for the pid. */
    alive: boolean;
    /** The exit code the Computer recorded, when it recorded one. */
    exitCode?: number;
  };
}): { status: ComputerProcessStatusV1; exitCode?: number } {
  const { recorded, currentGeneration, observed } = input;
  if (recorded.status === "exited") {
    return {
      status: "exited",
      ...(recorded.exitCode === undefined
        ? {}
        : { exitCode: recorded.exitCode }),
    };
  }
  if (currentGeneration !== recorded.generation) {
    // A rebuilt Computer is a different Computer. An exit file written by the
    // process before the rebuild is still evidence; a live pid is not, because
    // the pid belongs to whatever is running there now.
    return observed.exitCode === undefined
      ? { status: "unknown" }
      : { status: "exited", exitCode: observed.exitCode };
  }
  if (observed.exitCode !== undefined) {
    return { status: "exited", exitCode: observed.exitCode };
  }
  return observed.alive ? { status: "running" } : { status: "unknown" };
}
