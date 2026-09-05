// The Package that gives a Bot its Computer tools, and the caller of the
// durable-root sync (ADR 0013).
//
// "Bots invoke Computers only through the provider-neutral Computer
// interface", so the sync is reached here as `handle.sync` and never as a
// provider type: this Package does not know which Computer it is driving, and
// the reconciliation itself lives in the provider Package that does.
//
// WHEN THE SYNC RUNS. Three points, and no others:
//
//   open      before this Turn's first Computer tool call, so the Workspace
//             the Bot is about to look at is the one object storage holds.
//   signal    before a later tool call in the same Turn, when the on-Computer
//             watcher's change signal has moved.
//   turn-end  after a Turn that used the Computer, so a shell write on the
//             Computer becomes a durable generation.
//
// It never runs to *reach* a Computer. Every one of those points is inside a
// Turn that already has the Computer open for this Bot: "The Agent loop,
// Memory, Skills, Package composition, and Routines function correctly while
// the Computer is hibernated and do not wake it. The Computer wakes only when
// a Bot uses it" — and while it sleeps the object-storage side is
// authoritative on its own.
//
// A sync that could not run is an outcome, not an error. "Connections to the
// Computer are expected to drop on every pause; every Computer client
// reconnects and resumes rather than treating a dropped connection as
// failure." Every run appends `computer/sync` to the session event log with
// what it moved, and nothing on this path can fail a Turn.
import {
  type Session,
  type SessionStore,
  type ToolAttachmentV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type WorkspacePathV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import {
  computerBotPathKeyV1,
  ComputerError,
  type ComputerDoctorReportV1,
  type ComputerBackgroundStateV1,
  type ComputerBrowserAction,
  type ComputerHandle,
  computerSyncSummaryV1,
  type ComputerSyncReasonV1,
  type ComputerSyncSummaryV1,
} from "@frockbot/computer-core";
import {
  computerGuiRefusalV1,
  SCRATCH_ROOT,
  shellGuiCommandV1,
} from "@frockbot/computer-host-runtime";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  computerProcessStatusV1,
  COMPUTER_PROCESS_COMMAND_MAX,
  isComputerProcessIdV1,
  type ComputerProcessRecordV1,
  type ComputerProcessStatusV1,
} from "./process-records.js";
import {
  ComputerProcessLimitError,
  ComputerProcessStore,
  type ComputerProcessStorageV1,
} from "./process-store.js";
import {
  COMPUTER_DOCTOR_ROOT_ID,
  COMPUTER_SCREENSHOTS_ROOT_ID,
} from "./roots.js";
import {
  createComputerCaptureCadenceV1,
  fileComputerScreenshotV1,
  type ComputerProjectionFileInvalidationV1,
  type ComputerProjectionFileKindV1,
} from "./capture.js";
import {
  COMPUTER_CONTROL_RECORD_KEY,
  decodeStoredComputerControlV1,
  isStoredComputerControlFreshV1,
} from "./control-record.js";

export {
  COMPUTER_DOCTOR_ROOT_ID,
  COMPUTER_SCREENSHOTS_ROOT_ID,
  COMPUTER_SCREENSHOT_RETENTION,
} from "./roots.js";

export type { ComputerProcessStorageV1 };
export type {
  ComputerProjectionFileInvalidationV1,
  ComputerProjectionFileKindV1,
} from "./capture.js";

/**
 * The Session and Turn a durable Workspace write records as its writer.
 *
 * Supplied by the Bot Durable Object for one admitted Turn. Absent, and
 * `computer_screenshot` is not registered: "every write to a durable root
 * records its writer", and outside a Turn there is no writer to record.
 */
export interface ComputerWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

export interface ComputerAgentPluginConfig {
  userId: string;
  defaultProviderId: string;
  /**
   * Whether this deployment has a Computer at all.
   *
   * False, and the Package mounts no Computer tool and adds no Computer
   * section to the system prompt: a prompt that promises a persistent Linux
   * Computer where there is none costs the User a Turn of model spend per
   * question and ends in the model guessing at a remedy. Absent means
   * configured, so a host that does not know keeps the tools.
   */
  configured?: boolean;
  idempotentEffects?: boolean;
  writer?: ComputerWriterIdentityV1;
  /**
   * The Bot Durable Object storage a background process's record is written
   * to. Absent, and `computer_exec{background:true}` and the three process
   * tools are not offered at all: "record durable execution intent before
   * invoking an external side effect", and with nowhere to record it there is
   * no honest way to launch one.
   */
  processes?: ComputerProcessStorageV1;
  /**
   * Read-only access to this Bot Durable Object's Computer records. The
   * dynamic prompt reads the human lease here rather than asking the
   * Computer, so assembling a model request cannot wake one.
   */
  controlRecords?: {
    get<T>(key: string): Promise<T | undefined>;
    now?(): Date;
  };
  /** Drops resident projection caches after this Turn's Workspace sync. */
  projectionFiles?: ComputerProjectionFileInvalidationV1;
  /**
   * The shortest gap between two mid-Turn progress captures. Tests set it;
   * production takes `COMPUTER_PROGRESS_CAPTURE_INTERVAL_MS`.
   */
  progressCaptureIntervalMs?: number;
}

export const HUMAN_CONTROL_PROMPT_LINE =
  "Your User is currently controlling the Computer; do not use it this Turn.";

/** Bounded copy for the two transport failures an overloaded Sprite emits. */
export const COMPUTER_OVERLOADED_TOOL_MESSAGE_V1 =
  "The Computer is overloaded; a browser tab using too much memory was closed. Try again.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOverloadedTransportFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("websocket keepalive timeout") ||
    message.includes("computer effect was cancelled")
  );
}

/** A local HTTP origin an Applet preview can own; public sites never qualify. */
export function localPreviewOriginV1(value: string): string | undefined {
  try {
    const url = new URL(value);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return local && (url.protocol === "http:" || url.protocol === "https:")
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function localPreviewOriginsV1(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const origin = localPreviewOriginV1(match[0].replace(/[),.;!?]+$/g, ""));
    if (origin) found.add(origin);
  }
  return [...found];
}

function runsAppletPreviewV1(command: string): boolean {
  return /(?:^|[\s;&|])(?:[^\s;&|]*\/)?applet\s+dev(?:\s|$)/.test(command);
}

/** The wake-free, Turn-scoped projection shared by prompt render and its log. */
class ComputerControlPromptProjection {
  #line = "";
  #loadedTurn: number | undefined;

  constructor(
    private readonly records: NonNullable<
      ComputerAgentPluginConfig["controlRecords"]
    >,
  ) {}

  current(): string {
    return this.#line;
  }

  loadedTurn(): number | undefined {
    return this.#loadedTurn;
  }

  async refresh(turn: number, session: Session): Promise<void> {
    const value = await this.records.get<unknown>(COMPUTER_CONTROL_RECORD_KEY);
    const record =
      value === undefined ? undefined : decodeStoredComputerControlV1(value);
    const active =
      record &&
      isStoredComputerControlFreshV1(record, this.records.now?.() ?? new Date())
        ? record
        : undefined;
    this.#line = active ? HUMAN_CONTROL_PROMPT_LINE : "";
    this.#loadedTurn = turn;
    session.append({
      type: "computer/injected",
      turn,
      text: this.#line,
      ...(active
        ? { ownerId: active.ownerId, expiresAt: active.expiresAt }
        : {}),
    });
    await session.flush();
  }
}

/**
 * The width and height a PNG declares in its IHDR chunk.
 *
 * Read here rather than asked of the Computer: `identify` is another package
 * to provision and another exec to guard, and the two numbers are eight bytes
 * at a fixed offset of the file the tool already holds.
 */
export function pngDimensionsV1(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 24) return undefined;
  if (signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

interface ExecInput {
  command: string;
  background: boolean;
  cwd?: string;
}

function record(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : undefined;
}

const MAX_EXEC_COMMAND_LENGTH = 20_000;
/** An absolute path on the Computer, at the Computer host's own path bound. */
const MAX_EXEC_CWD_LENGTH = 4_096;

/** One shell word, whatever the path holds. */
function shellQuoteV1(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Every key `computer_exec` accepts; anything else is refused by name. */
const EXEC_INPUT_KEYS = ["command", "background", "cwd"] as const;

function decodeExec(input: unknown): ExecInput | undefined {
  const value = record(input);
  if (!value) return undefined;
  if (
    Object.keys(value).some(
      (key) => !(EXEC_INPUT_KEYS as readonly string[]).includes(key),
    )
  ) {
    return undefined;
  }
  const command = value.command;
  if (typeof command !== "string" || !command.trim()) return undefined;
  if (command.length > MAX_EXEC_COMMAND_LENGTH) return undefined;
  const background = value.background;
  if (background !== undefined && typeof background !== "boolean") {
    return undefined;
  }
  const cwd = value.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== "string") return undefined;
    if (!cwd.startsWith("/") || cwd.length > MAX_EXEC_CWD_LENGTH) {
      return undefined;
    }
    if (/[\0\n\r]/.test(cwd)) return undefined;
  }
  return {
    command,
    background: background === true,
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

/**
 * Why a `computer_exec` input could not be used, in the words that fix it.
 *
 * An argument the tool does not know used to be dropped on the way in, so a
 * `cwd` the model sent was silently ignored and the command ran somewhere else
 * — four wasted steps on production (2026-09-04) working out why `cat` could
 * not see a file that was plainly there. An unknown key is refused now, and the
 * refusal names it, which is the only reason refusing is better than dropping.
 */
export function execInputRefusalV1(input: unknown): string {
  const value = record(input);
  const unknown = Object.keys(value ?? {}).filter(
    (key) => !(EXEC_INPUT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return `computer_exec input is invalid: ${unknown
      .map((key) => `"${key}"`)
      .join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} field${
      unknown.length === 1 ? "" : "s"
    } of this tool. It takes "command", optional "cwd", and optional "background".`;
  }
  const cwd = value?.cwd;
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/"))) {
    return `computer_exec input is invalid: "cwd" must be an absolute path of at most ${MAX_EXEC_CWD_LENGTH} characters, such as "/home/box/agent-data".`;
  }
  return `computer_exec input is invalid: "command" must be a shell command of at most ${MAX_EXEC_COMMAND_LENGTH} characters.`;
}

/** The durable root a finished process's log tail is mirrored into. */
export const COMPUTER_PROCESSES_ROOT_ID = "processes";
/** Log bytes mirrored into the durable root on a completion. */
export const COMPUTER_PROCESS_MIRROR_BYTES = 64_000;

function decodeProcessId(input: unknown): string | undefined {
  const value = record(input)?.processId;
  return isComputerProcessIdV1(value) ? value : undefined;
}

/**
 * What each `computer_browser` action needs, in the words the refusal uses.
 *
 * Bob on production (2026-09-04) clicked a button with `{name}`, then
 * `{label}`, then `{label, role}` before landing on `{role, name}` — three
 * wasted steps per click, because the loop's generic "Invalid input for tool"
 * names no field. The snapshot lists elements as `button "Add"` and
 * `checkbox "Mark done"`, so a click takes that role and that accessible name;
 * `label` is accepted as a synonym for `name` (and `name` for `label` on
 * `fill`) since the model reaches for both.
 */
export const BROWSER_ACTION_SHAPES_V1: Readonly<Record<string, string>> = {
  snapshot: '{"action":"snapshot"}',
  navigate: '{"action":"navigate","url":"http://127.0.0.1:8944/"}',
  click:
    '{"action":"click","role":"button","name":"Add"} — role and name are both required; take them from the snapshot line (button "Add" → role "button", name "Add"; a checkbox line → role "checkbox")',
  fill: '{"action":"fill","label":"New todo","text":"Buy milk"} — label is the field\'s accessible label from the snapshot',
  press: '{"action":"press","key":"Enter"}',
  wait: '{"action":"wait","milliseconds":500} (0 to 30000)',
};

/** Why a `computer_browser` input could not be used, and what to send. */
export function browserInputRefusalV1(input: unknown): string {
  const value = record(input);
  const action = typeof value?.action === "string" ? value.action : undefined;
  const shape = action ? BROWSER_ACTION_SHAPES_V1[action] : undefined;
  if (!shape) {
    return `computer_browser input is invalid: "action" must be one of ${Object.keys(
      BROWSER_ACTION_SHAPES_V1,
    )
      .map((name) => `"${name}"`)
      .join(", ")}. For example ${BROWSER_ACTION_SHAPES_V1.click}.`;
  }
  return `computer_browser input is invalid for "${action}". Expected ${shape}.`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeBrowser(input: unknown): ComputerBrowserAction | undefined {
  const value = record(input);
  switch (value?.action) {
    case "snapshot":
      return { type: "snapshot" };
    case "navigate":
      return typeof value.url === "string" && value.url
        ? { type: "navigate", url: value.url }
        : undefined;
    case "click": {
      const name = optionalString(value.name) ?? optionalString(value.label);
      return typeof value.role === "string" && name !== undefined
        ? {
            type: "click",
            role: value.role,
            name,
            exact: typeof value.exact === "boolean" ? value.exact : undefined,
          }
        : undefined;
    }
    case "fill": {
      const label = optionalString(value.label) ?? optionalString(value.name);
      return label !== undefined && typeof value.text === "string"
        ? {
            type: "fill",
            label,
            text: value.text,
            exact: typeof value.exact === "boolean" ? value.exact : undefined,
          }
        : undefined;
    }
    case "press":
      return typeof value.key === "string"
        ? { type: "press", key: value.key }
        : undefined;
    case "wait": {
      const milliseconds = value.milliseconds ?? 500;
      return typeof milliseconds === "number" &&
        milliseconds >= 0 &&
        milliseconds <= 30_000
        ? { type: "wait", milliseconds }
        : undefined;
    }
    default:
      return undefined;
  }
}

function failure(error: unknown): { content: string; isError: true } {
  if (isOverloadedTransportFailure(error)) {
    return { content: COMPUTER_OVERLOADED_TOOL_MESSAGE_V1, isError: true };
  }
  if (error instanceof ComputerError) {
    if (error.code === "human-control-active") {
      // The holder is named, so a second Bot of the same User — and the User
      // reading the transcript — can tell which session has the desktop.
      const holder = error.message.trim();
      return {
        content: holder
          ? `${holder}; do not retry this Turn`
          : "The user is controlling this Computer; do not retry this Turn",
        isError: true,
      };
    }
    if (error.code === "updating") {
      const label = error.message.trim();
      return {
        content: `The Computer is updating (${label}); try again shortly`,
        isError: true,
      };
    }
    return { content: error.message, isError: true };
  }
  return {
    content: errorMessage(error),
    isError: true,
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Appends one `computer/sync` outcome to a Session and flushes it.
 *
 * The single place a sync becomes a durable record, so the Turn's own policy
 * and the one sanctioned caller outside it ({@link syncWorkspaceRootNowV1})
 * cannot record the same fact in two shapes. A Session that is gone or
 * disposed records nothing: a sync is never a reason to fail anything.
 */
export async function recordComputerSyncV1(
  sessions: SessionStore,
  sessionId: string,
  turn: number,
  reason: ComputerSyncReasonV1,
  summary: ComputerSyncSummaryV1,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.disposed) return;
  // The per-path answers a publish asked for travel back to that caller, not
  // into the durable log: the `computer/sync` event has an exact field set,
  // and a summary spread with `required` on it made every publish Turn fail
  // with "session event has invalid fields" (v0.3.27, 2026-09-05).
  const { required: _required, ...recorded } = summary;
  session.append({
    type: "computer/sync",
    turn: Math.max(1, turn),
    reason,
    ...recorded,
  });
  // The record is durable before anything reports the sync happened.
  await session.flush();
}

/**
 * Reconciles ONE declared durable root now, outside the Turn's sync policy.
 *
 * THE ONE SANCTIONED EXTRA CALLER. {@link ComputerTurnSync} was deliberately
 * narrowed — "a caller cannot get the policy wrong because there is no way to
 * ask for a sync at another time" — and this function is the single, named
 * exception to that sentence, added for Applet publish (ADR 0022 decision 7):
 * "Publishing reads the built artifact from the durable root through the
 * Workspace file surface." `applet build` writes `<appletId>/dist/` on the
 * Computer with an ordinary shell write, and the publish reads it from the
 * *store*. Without a push between those two the publish would read the
 * previous build, or nothing, and record a generation for bytes that never
 * existed — a wrong artifact rather than a visible failure. The Turn's own
 * `turn-end` push is too late: publish happens inside the Turn.
 *
 * It stays narrow in four ways, and the narrowness is the reason it is
 * allowed. It reconciles one root and not the Workspace. It wakes nothing: it
 * takes an already-open {@link ComputerHandle}, so a hibernated Computer stays
 * hibernated and this can never become a reason one starts. It records its
 * outcome exactly as the Turn's policy does, under its own `publish` reason,
 * so a Session log still says what every sync run moved and why. And it never
 * throws — an unavailable Computer is a summary its caller reads and refuses
 * the publish on, not an exception on the Turn.
 *
 * A provider with no per-root reconciliation answers `refused`, and so does a
 * root this Computer does not sync. Neither is silently upgraded to a full
 * `reconcile`: the caller asked for one root's bytes to be durable and is owed
 * a true answer about that root.
 */
export async function syncWorkspaceRootNowV1(request: {
  computer: ComputerHandle;
  sessions: SessionStore;
  sessionId: string;
  turn: number;
  root: WorkspaceRootV1;
  requiredPaths?: readonly string[];
  signal?: AbortSignal;
}): Promise<ComputerSyncSummaryV1> {
  const { computer, sessions, sessionId, turn, root, requiredPaths, signal } =
    request;
  const sync = computer.sync;
  let summary: ComputerSyncSummaryV1;
  if (!sync?.reconcileRoot) {
    summary = computerSyncSummaryV1(
      "refused",
      "this Computer cannot reconcile a single durable root",
    );
  } else {
    try {
      summary = await sync.reconcileRoot(
        root,
        "publish",
        signal || requiredPaths
          ? {
              ...(signal ? { signal } : {}),
              ...(requiredPaths ? { requiredPaths } : {}),
            }
          : undefined,
      );
    } catch (error) {
      summary = computerSyncSummaryV1(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await recordComputerSyncV1(sessions, sessionId, turn, "publish", summary);
  return summary;
}

/**
 * The Turn's sync state, and the only place this Package decides to sync.
 *
 * Deep and small on purpose: `beforeUse` and `afterTurn` are the whole
 * surface, they never throw, and every path through them either records a
 * `computer/sync` event or has nothing to record. A caller cannot get the
 * policy wrong because there is no way to ask for a sync at another time —
 * with exactly one named exception, {@link syncWorkspaceRootNowV1}, which
 * reconciles a single root for an Applet publish and is documented there.
 */
class ComputerTurnSync {
  #turn = 0;
  #pulled = false;
  #used = false;
  #signal: string | undefined;

  constructor(private readonly sessions: SessionStore) {}

  /** A new Turn forgets the last one's pull, its signal, and its use. */
  beginTurn(turn: number): void {
    if (turn === this.#turn) return;
    this.#turn = turn;
    this.#pulled = false;
    this.#used = false;
    this.#signal = undefined;
  }

  turnUsedTheComputer(turn: number): boolean {
    return this.#used && turn === this.#turn;
  }

  /**
   * Pull before the Turn's first Computer tool call; on later calls, sync
   * again only when the on-Computer watcher says something changed.
   */
  async beforeUse(
    computer: ComputerHandle,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#used = true;
    const sync = computer.sync;
    if (!sync) return;
    try {
      if (!this.#pulled) {
        this.#pulled = true;
        await this.record(
          sessionId,
          "open",
          await sync.reconcile("open", { signal }),
        );
        this.#signal = await sync.signal({ signal });
        return;
      }
      const current = await sync.signal({ signal });
      if (current === undefined || current === this.#signal) return;
      this.#signal = current;
      await this.record(
        sessionId,
        "signal",
        await sync.reconcile("signal", { signal }),
      );
    } catch (error) {
      // The Turn is never blocked by its sync, whatever the provider did.
      await this.record(
        sessionId,
        "open",
        computerSyncSummaryV1(
          "unavailable",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  /** Push after a Turn that used the Computer, and only then. */
  async afterTurn(computer: ComputerHandle, sessionId: string): Promise<void> {
    this.#used = false;
    const sync = computer.sync;
    if (!sync) return;
    await this.record(sessionId, "turn-end", await sync.reconcile("turn-end"));
  }

  /** The Turn could not be given a Computer at all; that is also an outcome. */
  unavailable(sessionId: string, reason: unknown): Promise<void> {
    return this.record(
      sessionId,
      "turn-end",
      computerSyncSummaryV1(
        "unavailable",
        reason instanceof Error ? reason.message : String(reason),
      ),
    );
  }

  private record(
    sessionId: string,
    reason: ComputerSyncReasonV1,
    summary: ComputerSyncSummaryV1,
  ): Promise<void> {
    return recordComputerSyncV1(
      this.sessions,
      sessionId,
      this.#turn,
      reason,
      summary,
    );
  }
}

async function useComputer<T>(
  computer: ComputerHandle,
  run: (computer: ComputerHandle) => Promise<T>,
): Promise<T> {
  try {
    return await run(computer);
  } finally {
    await computer.close();
  }
}

export function createComputerAgentPlugin(
  config: ComputerAgentPluginConfig,
): Plugin.Function {
  const userId = config.userId.trim();
  const defaultProviderId = config.defaultProviderId.trim();
  if (!userId) throw new Error("Computer user id must be non-empty");
  if (!defaultProviderId) {
    throw new Error("Computer default provider id must be non-empty");
  }

  const plugin: Plugin.Function = (ctx) => {
    // A deployment with no Computer offers no Computer tool and no Computer
    // prompt. The alternative — tools that always fail — spends a Turn's model
    // budget discovering what this host already knows, and leaves the model
    // inventing a way for the User to fix it.
    if (config.configured === false) return [];
    // One Computer per User (ADR 0012): the assignment is keyed by the User,
    // and the Bot attaches to it as a tenant.
    const identity = { userId };
    const turnSync = new ComputerTurnSync(ctx.sessions);
    const controlPrompt = config.controlRecords
      ? new ComputerControlPromptProjection(config.controlRecords)
      : undefined;
    // The Turn ordinal a `computer/process` event is recorded under. The
    // Agent loop knows it; a tool context does not, so it is caught where the
    // loop already announces it.
    let currentTurn = 1;
    /** Local preview origins this Bot navigated to during the current Turn. */
    const previewOrigins = new Set<string>();
    // One cadence per mounted plugin, which is one per Turn: a Turn's first
    // Computer action always gets its capture, and the rest are debounced.
    const progressCadence = createComputerCaptureCadenceV1(
      config.progressCaptureIntervalMs === undefined
        ? undefined
        : { intervalMs: config.progressCaptureIntervalMs },
    );
    const projectionWrites = new Set<ComputerProjectionFileKindV1>();
    const noteProjectionWrite = (kind: ComputerProjectionFileKindV1): void => {
      projectionWrites.add(kind);
    };
    const invalidateProjectionWrites = (botId: string): void => {
      for (const kind of projectionWrites) {
        config.projectionFiles?.invalidate(botId, kind);
      }
      projectionWrites.clear();
    };
    const turnOf = (_context: ToolExecutionContext): number => currentTurn;
    const attach = async (botId: string, signal: AbortSignal) => {
      if (!ctx.computers.assignment(identity)) {
        ctx.computers.assign(identity, defaultProviderId);
      }
      return ctx.computers.open(identity, { botId }, { signal });
    };
    /**
     * Opens the Computer for one tool call and reconciles the durable roots
     * before the Bot looks at them. The sync is inside `open` rather than
     * beside each tool so no Computer tool can be added that skips it.
     */
    const open = async (
      botId: string,
      sessionId: string,
      signal: AbortSignal,
    ) => {
      const computer = await attach(botId, signal);
      await turnSync.beforeUse(computer, sessionId, signal);
      await selfCheck(computer, botId, signal);
      return computer;
    };
    const closePreviewTabs = async (
      computer: ComputerHandle,
      origins: readonly string[],
      effectId: string,
      signal?: AbortSignal,
    ): Promise<void> => {
      if (!computer.browser) return;
      const unique = [...new Set(origins)];
      for (let offset = 0; offset < unique.length; offset += 16) {
        await computer.browser.perform(
          { type: "close-origins", origins: unique.slice(offset, offset + 16) },
          {
            ...(signal ? { signal } : {}),
            effectId: `${effectId}:${Math.floor(offset / 16)}`,
          },
        );
      }
    };

    const execTool: ToolDefinition = {
      name: "computer_exec",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      idempotent: config.idempotentEffects === true,
      description: [
        "Run a shell command in the Bot's selected persistent Computer. New calls are blocked while the user has taken control.",
        "Pass cwd as an absolute path to run the command in that directory instead of the home directory.",
        "With background:true the command keeps running after this call returns and after this Turn ends, and you get a processId to check later.",
        "A background process runs only while the Computer is awake. Nothing keeps it awake for you: if the Computer hibernates first, the outcome is reported as unknown, with whatever log was durable at the time.",
        `${SCRATCH_ROOT} (also $FROCKBOT_SCRATCH) is scratch shared with your User's other Bots: it survives hibernation but is not durable and never reaches storage, so keep nothing there you cannot lose.`,
        "The Computer's GUI is never driven from the shell; use computer_browser and computer_screenshot instead of launching or poking at a browser yourself.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", maxLength: MAX_EXEC_COMMAND_LENGTH },
          cwd: {
            type: "string",
            maxLength: MAX_EXEC_CWD_LENGTH,
            description:
              "Absolute path to run the command in. Defaults to the Bot's home directory.",
          },
          background: {
            type: "boolean",
            description:
              "Start the command and return a processId instead of waiting for it.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
      // Deliberately permissive, for the same reason `computer_browser` is: a
      // wrong shape reaches `execute`, which names the field. A `false` here is
      // the loop's generic "Invalid input for tool", which names nothing.
      validate: (input) => !!record(input),
      execute: async (input, context) => {
        const decoded = decodeExec(input);
        if (!decoded) {
          return { content: execInputRefusalV1(input), isError: true };
        }
        // "The GUI is never driven from the shell" (parity row 33), refused at
        // the seam where the model can be told why. This is policy and not a
        // boundary — a regex over a shell string is defeatable, and the
        // Computer is the User's trust boundary anyway — so it is paired with
        // a PATH shim on the Computer that prints the same sentence, and both
        // exist to make the sanctioned surface the easy one.
        const guiCommand = shellGuiCommandV1(decoded.command);
        if (guiCommand) {
          return { content: computerGuiRefusalV1(guiCommand), isError: true };
        }
        if (decoded.background) {
          return processes
            ? // A launch carries a command and not a directory, so the
              // directory becomes part of the command. `cd` failing stops the
              // process before it starts, which is what a wrong path deserves.
              launchBackground(
                decoded.cwd
                  ? `cd ${shellQuoteV1(decoded.cwd)} && ${decoded.command}`
                  : decoded.command,
                context,
              )
            : {
                content:
                  "A background process is recorded before it is launched; this runtime has nowhere durable to record it",
                isError: true,
              };
        }
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              if (!computer.exec) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support command execution",
                );
              }
              const result = await computer.exec.execute(
                {
                  executable: "/bin/bash",
                  args: ["-lc", decoded.command],
                  ...(decoded.cwd ? { cwd: decoded.cwd } : {}),
                  timeoutMs: 120_000,
                  maxOutputBytes: 30_000,
                },
                { signal: context.signal, effectId: context.effectId },
              );
              await fileProgressCapture(computer, context.botId, context);
              return {
                content: [text(result.stdout), text(result.stderr)]
                  .filter(Boolean)
                  .join("\n"),
                isError: result.exitCode !== 0,
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    const writer = config.writer;
    const processes = config.processes
      ? new ComputerProcessStore(config.processes)
      : undefined;

    /** Appends one `computer/process` line to the durable session log. */
    const noteProcess = async (
      sessionId: string,
      turn: number,
      note: {
        processId: string;
        action: "launch" | "check" | "logs" | "stop";
        status: ComputerProcessStatusV1;
        exitCode?: number;
      },
    ): Promise<void> => {
      const session = ctx.sessions.get(sessionId);
      if (!session || session.disposed) return;
      session.append({
        type: "computer/process",
        turn: Math.max(1, turn),
        ...note,
      });
      await session.flush();
    };

    /**
     * Mirrors a finished process's log tail into the Package-declared
     * `processes` root.
     *
     * Without it an image rebuild erases the only evidence a long job ever
     * ran, which is an unobservable failure state. Written through the
     * Workspace, so the Bot is recorded as its writer; best effort, because a
     * process outcome that was read is never withheld because the mirror
     * could not be written.
     */
    const mirrorLog = async (
      computer: ComputerHandle,
      context: ToolExecutionContext,
      record: ComputerProcessRecordV1,
      status: ComputerProcessStatusV1,
      logTail: string,
    ): Promise<void> => {
      if (!writer || !computer.workspace) return;
      if (status !== "exited" && status !== "unknown") return;
      const botKey = computerBotPathKeyV1(context.botId);
      const body = [
        `# ${record.processId}`,
        `command: ${record.command}`,
        `started: ${record.startedAt}`,
        `status: ${status}`,
        ...(record.exitCode === undefined
          ? []
          : [`exit: ${String(record.exitCode)}`]),
        "",
        logTail.slice(-COMPUTER_PROCESS_MIRROR_BYTES),
      ].join("\n");
      const existing = await computer.workspace.stat({
        root: {
          kind: "package-declared",
          userId,
          packageId: "computer",
          rootId: COMPUTER_PROCESSES_ROOT_ID,
        },
        path: `${botKey}/${record.processId}.log`,
      });
      await computer.workspace.write({
        path: {
          root: {
            kind: "package-declared",
            userId,
            packageId: "computer",
            rootId: COMPUTER_PROCESSES_ROOT_ID,
          },
          path: `${botKey}/${record.processId}.log`,
        },
        bytes: new TextEncoder().encode(body),
        writer: {
          kind: "bot",
          botId: context.botId,
          sessionId: writer.sessionId,
          turnId: writer.turnId,
          runId: writer.runId,
        },
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: "text/plain",
      });
    };

    /**
     * Launches a command that outlives the Turn.
     *
     * The record is written *before* the launch, carrying the effect id: an
     * interrupted launch leaves an intent to reconcile rather than a process
     * nothing remembers, and a recovery reads its outcome instead of starting
     * a second one.
     */
    const launchBackground = async (
      command: string,
      context: ToolExecutionContext,
    ) => {
      if (!processes || !writer) {
        return {
          content:
            "A background process is recorded before it is launched; this runtime has nowhere durable to record it",
          isError: true,
        };
      }
      const store = processes;
      // The intent this call wrote, until the launch that follows it settles.
      // Left as `starting` by a launch that threw, it is a record nothing can
      // ever answer for and nothing can forget — a failing Computer would
      // spend the Bot's whole 100-record budget having run nothing at all.
      let unsettled: ComputerProcessRecordV1 | undefined;
      try {
        return await useComputer(
          await open(context.botId, context.sessionId, context.signal),
          async (computer) => {
            if (!computer.processes) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support background processes",
              );
            }
            const processId = `p-${context.effectId.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}`;
            const generation = await computer.processes.generation({
              signal: context.signal,
            });
            const intent: ComputerProcessRecordV1 = {
              schemaVersion: 1,
              processId,
              botId: context.botId,
              sessionId: context.sessionId,
              turnId: writer.turnId,
              command,
              cwd: "",
              startedAt: new Date().toISOString(),
              status: "starting",
              generation,
              effectId: context.effectId,
              logPath: "",
            };
            await store.record({ ...intent, cwd: "/", logPath: "/" });
            unsettled = { ...intent, cwd: "/", logPath: "/" };
            const launched = await computer.processes.launch(
              { processId, command },
              { signal: context.signal, effectId: context.effectId },
            );
            const running: ComputerProcessRecordV1 = {
              ...intent,
              status: "running",
              generation: launched.generation || generation,
              cwd: launched.cwd,
              logPath: launched.logPath,
              pid: launched.pid,
            };
            await store.update(running);
            unsettled = undefined;
            await noteProcess(context.sessionId, turnOf(context), {
              processId,
              action: "launch",
              status: "running",
            });
            return {
              content: JSON.stringify({
                processId,
                pid: launched.pid,
                status: "running",
                command,
                cwd: launched.cwd,
                startedAt: running.startedAt,
                note: "This process runs while the Computer is awake and outlives this Turn. Nothing keeps the Computer awake for it; if it hibernates first, computer_process_check answers unknown.",
              }),
              isError: false,
            };
          },
        );
      } catch (error) {
        if (unsettled) {
          // `unknown`, not deleted: the launch may have started something
          // before it threw, and "recovery can read its outcome or classify it
          // as unknown without repeating it". Terminal, so the record is
          // prunable rather than holding a slot for the life of the Bot.
          try {
            await store.update({ ...unsettled, status: "unknown" });
          } catch {
            // Reconciling the intent is never why a tool call fails; the
            // launch failure below is the answer the model needs.
          }
        }
        if (error instanceof ComputerProcessLimitError) {
          return { content: error.message, isError: true };
        }
        return failure(error);
      }
    };

    /**
     * Reads one process's outcome and records it. The reconciliation rule —
     * a moved generation means the process is gone, never running — lives in
     * `computerProcessStatusV1`, so no caller here can decide it differently.
     */
    const settle = async (
      context: ToolExecutionContext,
      processId: string,
      action: "check" | "logs" | "stop",
      tailBytes?: number,
    ) => {
      if (!processes) {
        return {
          content: "This runtime holds no background process records",
          isError: true,
        };
      }
      const store = processes;
      const held = await store.read(processId);
      if (!held || held.botId !== context.botId) {
        return {
          content: `No background process "${processId}" is recorded for this Bot`,
          isError: true,
        };
      }
      try {
        return await useComputer(
          await open(context.botId, context.sessionId, context.signal),
          async (computer) => {
            if (!computer.processes) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support background processes",
              );
            }
            const currentGeneration = await computer.processes.generation({
              signal: context.signal,
            });
            let observed: ComputerBackgroundStateV1;
            if (action === "stop") {
              observed = await computer.processes.stop(processId, {
                signal: context.signal,
                effectId: context.effectId,
              });
            } else {
              observed = await computer.processes.inspect(processId, {
                signal: context.signal,
                ...(tailBytes === undefined ? {} : { tailBytes }),
              });
            }
            const settled = computerProcessStatusV1({
              recorded: held,
              currentGeneration,
              observed,
            });
            const next: ComputerProcessRecordV1 = {
              ...held,
              status: settled.status,
              ...(settled.exitCode === undefined
                ? {}
                : { exitCode: settled.exitCode }),
            };
            await store.update(next);
            await noteProcess(context.sessionId, turnOf(context), {
              processId,
              action,
              status: settled.status,
              ...(settled.exitCode === undefined
                ? {}
                : { exitCode: settled.exitCode }),
            });
            // The evidence outlives the Computer only if it leaves it.
            try {
              await mirrorLog(
                computer,
                context,
                next,
                settled.status,
                observed.logTail,
              );
            } catch {
              // A mirror that could not be written never withholds an outcome
              // that was read.
            }
            if (
              action === "stop" &&
              runsAppletPreviewV1(held.command) &&
              computer.browser
            ) {
              const origins = localPreviewOriginsV1(observed.logTail);
              if (origins.length > 0) {
                await closePreviewTabs(
                  computer,
                  origins,
                  `${context.effectId}:close-preview-tabs`,
                  context.signal,
                );
                for (const origin of origins) previewOrigins.delete(origin);
              }
            }
            if (action === "logs") {
              return {
                content: observed.logTail || "(no output yet)",
                isError: false,
              };
            }
            return {
              content: JSON.stringify({
                processId,
                status: settled.status,
                ...(settled.exitCode === undefined
                  ? {}
                  : { exitCode: settled.exitCode }),
                command: held.command,
                startedAt: held.startedAt,
                ...(held.pid === undefined ? {} : { pid: held.pid }),
                logTail: observed.logTail.slice(-4_000),
                ...(settled.status === "unknown"
                  ? {
                      note: "The Computer this process was launched on is not the one answering now, or its process is gone with no recorded exit. It is not running; treat its outcome as unknown.",
                    }
                  : {}),
              }),
              isError: false,
            };
          },
        );
      } catch (error) {
        return failure(error);
      }
    };

    let captureSequence = 0;

    /**
     * Files one capture of the desktop the Bot has just acted on, and tells
     * the browser to read again.
     *
     * "Live while working" has two halves, and this is the one that works
     * without a viewer session: the card that cannot open a stream still
     * shows a picture of what the Bot did a second ago rather than what it
     * did at the end of the last Turn. Debounced, best effort, and never the
     * reason a tool call fails — the Bot's answer is the tool's result, and a
     * photograph of the screen is a courtesy to the person watching.
     */
    const fileProgressCapture = async (
      computer: ComputerHandle,
      botId: string,
      context: ToolExecutionContext,
    ): Promise<void> => {
      if (!writer || !computer.workspace || !computer.screenshot) return;
      if (!progressCadence.admit(Date.now())) return;
      const botKey = computerBotPathKeyV1(botId);
      captureSequence += 1;
      try {
        await fileComputerScreenshotV1({
          computer,
          workspace: computer.workspace,
          path: {
            root: {
              kind: "package-declared",
              userId,
              packageId: "computer",
              rootId: COMPUTER_SCREENSHOTS_ROOT_ID,
            },
            path: `${botKey}/${writer.turnId}-${captureSequence}.png`,
          },
          writer: {
            kind: "bot",
            botId,
            sessionId: writer.sessionId,
            turnId: writer.turnId,
            runId: writer.runId,
          },
          botKey,
          effectId: `${context.effectId}:progress-screenshot`,
        });
      } catch {
        // A desktop that refused a capture — human control, a Sprite that
        // paused, a Computer with no screen — changes nothing the Bot did.
        return;
      }
      noteProjectionWrite("screenshots");
      // Flushed now rather than at Turn end: a capture nobody is told about
      // is the delay this exists to remove.
      invalidateProjectionWrites(botId);
    };

    /**
     * Captures the Bot's own desktop into the Package-declared `screenshots`
     * root.
     *
     * The bytes are written through the Workspace rather than left where
     * `scrot` put them, because "every write to a durable root records its
     * writer": a file a shell left on the Computer reaches object storage
     * `unattributed`, which is data and never provenance. The result the model
     * reads is JSON — where the capture is and exactly which bytes it is — and
     * the image itself travels as an attachment, shown by a model-invocation
     * adapter that can show it and named in the text by one that cannot.
     *
     * Declared read-only: it observes the Computer and changes nothing, so it
     * records no durable intent. It is still refused while a human holds the
     * takeover lease, because during a takeover the screen is theirs.
     */
    const screenshotTool: ToolDefinition = {
      name: "computer_screenshot",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      idempotent: true,
      description:
        "Capture a PNG of your own desktop on the Computer and file it in your durable screenshots root. Refused while the user has taken control of the Computer.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validate: (input) =>
        input === undefined ||
        input === null ||
        (typeof input === "object" && Object.keys(input).length === 0),
      execute: async (_input, context) => {
        if (!writer) {
          return {
            content:
              "A screenshot is filed under the Turn that took it; this runtime has no Turn to record as its writer",
            isError: true,
          };
        }
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              const workspace = computer.workspace;
              if (!workspace) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer exposes no Workspace to file a screenshot in",
                );
              }
              const root: WorkspaceRootV1 = {
                kind: "package-declared",
                userId,
                packageId: "computer",
                rootId: COMPUTER_SCREENSHOTS_ROOT_ID,
              };
              const botKey = computerBotPathKeyV1(context.botId);
              captureSequence += 1;
              const path: WorkspacePathV1 = {
                root,
                path: `${botKey}/${writer.turnId}-${captureSequence}.png`,
              };
              const botWriter: WorkspaceWriterV1 = {
                kind: "bot",
                botId: context.botId,
                sessionId: writer.sessionId,
                turnId: writer.turnId,
                runId: writer.runId,
              };
              const filed = await fileComputerScreenshotV1({
                computer,
                workspace,
                path,
                writer: botWriter,
                botKey,
                signal: context.signal,
                effectId: context.effectId,
              });
              noteProjectionWrite("screenshots");
              // The Bot just looked at its own screen; so should the person
              // watching the card. Recording the admission keeps the very
              // next Computer action from filing a near-identical capture.
              progressCadence.admit(Date.now());
              invalidateProjectionWrites(context.botId);
              const dimensions = pngDimensionsV1(filed.captured.bytes);
              const attachment: ToolAttachmentV1 = {
                kind: "image",
                mediaType: filed.captured.mediaType,
                workspacePath: path,
                contentHash: filed.generation.contentHash,
                bytes: filed.generation.size,
              };
              // The bytes are offered to the resident Session so this Turn's
              // next model request can show them. They are never recorded:
              // the event log holds the reference, the Workspace holds the
              // image.
              ctx.sessions
                .get(context.sessionId)
                ?.offerAttachmentBytes(
                  attachment.contentHash,
                  base64Of(filed.captured.bytes),
                );
              return {
                content: JSON.stringify({
                  path: path.path,
                  rootId: COMPUTER_SCREENSHOTS_ROOT_ID,
                  contentHash: attachment.contentHash,
                  bytes: attachment.bytes,
                  ...(dimensions ?? {}),
                  display: filed.captured.display,
                  capturedAt: filed.captured.capturedAt,
                }),
                isError: false,
                attachments: [attachment],
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    /**
     * Files one self-check report in the Package-declared `doctor` root.
     *
     * Through the Workspace, for the same reason a screenshot is: a file left
     * on the Computer by a shell reaches object storage `unattributed`, and a
     * report nobody can attribute is a report nobody can act on. One path per
     * Bot, overwritten: the log on the Computer is the history, and this is
     * the last answer, readable while the Computer sleeps.
     */
    const fileDoctorReport = async (
      computer: ComputerHandle,
      botId: string,
      report: ComputerDoctorReportV1,
    ): Promise<string | undefined> => {
      if (!writer || !computer.workspace) return undefined;
      const root: WorkspaceRootV1 = {
        kind: "package-declared",
        userId,
        packageId: "computer",
        rootId: COMPUTER_DOCTOR_ROOT_ID,
      };
      const path = `${computerBotPathKeyV1(botId)}/latest.json`;
      const existing = await computer.workspace.stat({ root, path });
      const written = await computer.workspace.write({
        path: { root, path },
        bytes: new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`),
        writer: {
          kind: "bot",
          botId,
          sessionId: writer.sessionId,
          turnId: writer.turnId,
          runId: writer.runId,
        },
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: "application/json",
      });
      if (written.status !== "ok") return undefined;
      noteProjectionWrite("doctor");
      return path;
    };

    /**
     * The self-check, run once for the Computer this Package instance opened.
     *
     * "box-doctor runs at startup and on demand" (parity row 27). Startup here
     * is the first time this Bot reaches its Computer after this Package
     * loaded — which is the first Turn after a cold provisioning, and after a
     * Durable Object eviction as well. Repeating it costs one read-only exec
     * and no effect, so a second run is waste and never damage.
     *
     * Nothing here can fail a Turn: a Computer that cannot answer a self-check
     * is a Computer the next tool call will report on anyway.
     */
    let selfChecked = false;
    const selfCheck = async (
      computer: ComputerHandle,
      botId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (selfChecked || !computer.doctor || !writer) return;
      selfChecked = true;
      try {
        const report = await computer.doctor.run({ signal });
        await fileDoctorReport(computer, botId, report);
      } catch {
        // An unreadable self-check is not a reason to refuse the tool call the
        // Bot actually made.
      }
    };

    /**
     * `computer_doctor` — the Computer's self-check, on demand (row 27).
     *
     * Declared read-only: every check reads and none repairs, so it records no
     * durable intent. It is admitted on every turn type, because a Routine
     * that finds a Computer misbehaving must be able to say what is wrong with
     * it, and it is *not* refused under a human takeover — a Computer somebody
     * has taken over is exactly a Computer somebody is debugging.
     */
    const doctorTool: ToolDefinition = {
      name: "computer_doctor",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      description:
        "Run the Computer's self-check and read the report: disk, the shared scratch, the desktop gateway, your display, the browser profile, renderer-watchdog actions, top memory consumers, the durable-root sync and its conflicts, the reference docs, the browser launcher, the clock, and DNS. Read-only; it changes nothing and repairs nothing.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validate: (input) =>
        input === undefined ||
        input === null ||
        (typeof input === "object" && Object.keys(input).length === 0),
      execute: async (_input, context) => {
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              if (!computer.doctor) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support a self-check",
                );
              }
              const report = await computer.doctor.run({
                signal: context.signal,
              });
              let path: string | undefined;
              try {
                path = await fileDoctorReport(computer, context.botId, report);
              } catch {
                // A report that could not be filed is still a report that was
                // read, and withholding it would hide the very failure it
                // describes.
              }
              return {
                content: JSON.stringify({
                  ...report,
                  ...(path ? { rootId: COMPUTER_DOCTOR_ROOT_ID, path } : {}),
                }),
                isError: false,
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    /**
     * The three background-process tools.
     *
     * `check` and `logs` declare their turn types explicitly — every one of
     * them — because a Routine must be able to collect the outcome of a job a
     * chat Turn started, and that has to stay true if this Package ever gains
     * a manifest ceiling that narrows the default. `stop` is left undeclared,
     * exactly like `computer_exec`, so ending a process is admitted wherever
     * starting one is. None of them ends a Turn, and none of them keeps a
     * Computer awake.
     */
    const processCheckTool: ToolDefinition = {
      name: "computer_process_check",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      description:
        "Read the status of a background process started with computer_exec{background:true}. Answers running, exited with its code, or unknown when the Computer that held it is gone.",
      inputSchema: {
        type: "object",
        properties: { processId: { type: "string" } },
        required: ["processId"],
        additionalProperties: false,
      },
      validate: (input) => decodeProcessId(input) !== undefined,
      execute: async (input, context) => {
        const processId = decodeProcessId(input);
        if (!processId)
          return { content: "A processId is required", isError: true };
        return settle(context, processId, "check");
      },
    };

    const processLogsTool: ToolDefinition = {
      name: "computer_process_logs",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      description:
        "Read the bounded log of a background process. The log keeps its first and last 128 KiB; the middle of a very long run is dropped.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string" },
          tailBytes: { type: "number", minimum: 1, maximum: 64_000 },
        },
        required: ["processId"],
        additionalProperties: false,
      },
      validate: (input) => decodeProcessId(input) !== undefined,
      execute: async (input, context) => {
        const processId = decodeProcessId(input);
        if (!processId)
          return { content: "A processId is required", isError: true };
        const tailBytes = record(input)?.tailBytes;
        return settle(
          context,
          processId,
          "logs",
          typeof tailBytes === "number" ? tailBytes : undefined,
        );
      },
    };

    const processStopTool: ToolDefinition = {
      name: "computer_process_stop",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      idempotent: config.idempotentEffects === true,
      description:
        "End a background process. Its process group is signalled TERM and then KILL after a grace period.",
      inputSchema: {
        type: "object",
        properties: { processId: { type: "string" } },
        required: ["processId"],
        additionalProperties: false,
      },
      validate: (input) => decodeProcessId(input) !== undefined,
      execute: async (input, context) => {
        const processId = decodeProcessId(input);
        if (!processId)
          return { content: "A processId is required", isError: true };
        return settle(context, processId, "stop");
      },
    };

    const browserTool: ToolDefinition = {
      name: "computer_browser",
      // Page-level browser control, which `browserUse` exists for.
      admission: {
        turnTypes: ["chat", "automation", "subagent"],
        subagentRoles: ["executor", "browserUse", "computerUse"],
      },
      idempotent: config.idempotentEffects === true,
      description:
        'Control the browser in the Bot\'s selected Computer and return an accessibility snapshot. Shapes: {"action":"snapshot"}; {"action":"navigate","url":...}; {"action":"click","role":"button","name":"Add"} (role AND name, both from the snapshot line, e.g. checkbox "Mark done"); {"action":"fill","label":"New todo","text":...}; {"action":"press","key":"Enter"}; {"action":"wait","milliseconds":500}.',
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["snapshot", "navigate", "click", "fill", "press", "wait"],
          },
          url: { type: "string" },
          role: {
            type: "string",
            description:
              "click: the element's role from the snapshot (button, checkbox, link, textbox…)",
          },
          name: {
            type: "string",
            description:
              "click: the element's accessible name from the snapshot",
          },
          label: {
            type: "string",
            description: "fill: the field's accessible label from the snapshot",
          },
          text: { type: "string" },
          key: { type: "string" },
          exact: { type: "boolean" },
          milliseconds: { type: "number", minimum: 0, maximum: 30_000 },
        },
        required: ["action"],
        additionalProperties: false,
      },
      // Deliberately permissive: a wrong shape reaches `execute`, which says
      // which field is missing and shows the shape. A bare `false` here becomes
      // the loop's generic "Invalid input for tool", which cost Bob three
      // steps per click. Same reasoning as `skill_load`.
      validate: (input) => !!record(input),
      execute: async (input, context) => {
        const action = decodeBrowser(input);
        if (!action)
          return { content: browserInputRefusalV1(input), isError: true };
        try {
          return await useComputer(
            await open(context.botId, context.sessionId, context.signal),
            async (computer) => {
              if (!computer.browser) {
                throw new ComputerError(
                  "capability-unavailable",
                  "The selected Computer does not support browser automation",
                );
              }
              const result = await computer.browser.perform(action, {
                signal: context.signal,
                effectId: context.effectId,
              });
              if (action.type === "navigate") {
                const origin = localPreviewOriginV1(action.url);
                if (origin) previewOrigins.add(origin);
              }
              await fileProgressCapture(computer, context.botId, context);
              return {
                content: result.accessibilitySnapshot,
                isError: false,
              };
            },
          );
        } catch (error) {
          return failure(error);
        }
      },
    };

    return [
      ctx.tools.register(execTool),
      ...(writer ? [ctx.tools.register(screenshotTool)] : []),
      ctx.tools.register(doctorTool),
      ...(processes && writer
        ? [
            ctx.tools.register(processCheckTool),
            ctx.tools.register(processLogsTool),
            ctx.tools.register(processStopTool),
          ]
        : []),
      ctx.tools.register(browserTool),
      // A Turn's first step is where the Turn's sync state begins; a Turn that
      // never touches the Computer never syncs and never wakes one.
      ctx.on("agent/pre-step", async (agent, _inputs, turn, _step, next) => {
        if (turn !== currentTurn) {
          projectionWrites.clear();
          previewOrigins.clear();
          // Every Turn's first Computer action is worth a capture, however
          // soon after the previous Turn's last one it happens.
          progressCadence.reset();
        }
        currentTurn = turn;
        turnSync.beginTurn(turn);
        if (controlPrompt?.loadedTurn() !== turn) {
          await controlPrompt?.refresh(turn, agent.session);
        }
        return next();
      }),
      // "after a Turn that used the Computer": the Computer is already awake
      // for this Bot, so the push costs no wake, and a Sprite that paused
      // mid-Turn answers `unavailable` and the next run finishes the work.
      ctx.on("agent/turn-stopping", async (agent, turn) => {
        if (!turnSync.turnUsedTheComputer(turn)) return;
        let computer;
        try {
          computer = await attach(agent.botId, new AbortController().signal);
        } catch (error) {
          await turnSync.unavailable(agent.session.id, error);
          invalidateProjectionWrites(agent.botId);
          return;
        }
        try {
          if (computer.browser && previewOrigins.size > 0) {
            const origins = [...previewOrigins];
            await closePreviewTabs(
              computer,
              origins,
              `computer:${writer?.runId ?? agent.session.id}:${turn}:close-preview-tabs`,
            );
            previewOrigins.clear();
          }
          if (writer && computer.workspace) {
            const root: WorkspaceRootV1 = {
              kind: "package-declared",
              userId,
              packageId: "computer",
              rootId: COMPUTER_SCREENSHOTS_ROOT_ID,
            };
            const botKey = computerBotPathKeyV1(agent.botId);
            captureSequence += 1;
            try {
              await fileComputerScreenshotV1({
                computer,
                workspace: computer.workspace,
                path: {
                  root,
                  path: `${botKey}/${writer.turnId}-${captureSequence}.png`,
                },
                writer: {
                  kind: "bot",
                  botId: agent.botId,
                  sessionId: writer.sessionId,
                  turnId: writer.turnId,
                  runId: writer.runId,
                },
                botKey,
                effectId: `computer:${writer.runId}:turn-end-screenshot`,
              });
              noteProjectionWrite("screenshots");
            } catch {
              // Opportunistic capture never changes the Turn outcome. The
              // provider's human-control refusal is deliberately preserved.
            }
          }
          await turnSync.afterTurn(computer, agent.session.id);
        } catch (error) {
          await turnSync.unavailable(agent.session.id, error);
        } finally {
          invalidateProjectionWrites(agent.botId);
          await computer.close();
        }
      }),
      ctx.systemPrompt.register({
        id: "persistent-computer",
        order: 80,
        render: () =>
          [
            "## Persistent Computer",
            "You share a persistent Linux Computer with your User's other Bots. You have your own directories and desktop on it; the browser profile is shared.",
            "Use computer_exec to inspect the filesystem before claiming that a path or file exists.",
            "Use computer_screenshot to see your own desktop; each capture is filed in your durable screenshots root.",
            "For a job that outlasts this Turn, use computer_exec with background:true and check it later with computer_process_check. Do not poll it in a loop.",
            "Use computer_doctor when the Computer misbehaves; it reports disk, desktop, renderer-watchdog actions, top memory consumers, sync, and network in one read-only call.",
            ...(controlPrompt?.current() ? [controlPrompt.current()] : []),
            "Never invent a directory listing.",
          ].join("\n"),
      }),
    ];
  };
  plugin.inject = ["computers", "tools", "systemPrompt", "sessions"];
  return plugin;
}

export default createComputerAgentPlugin;
