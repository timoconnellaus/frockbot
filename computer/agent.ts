// The Package that gives a Bot its Computer tools, and the caller of the
// durable-root sync.
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
  decodePluginPageTryRequestV1,
  PLUGIN_PAGE_STAND_IN_HOST_JS_V1,
  PLUGIN_PAGE_TRY_RUNNER_MJS_V1,
  PLUGIN_PAGE_TRY_THEME_TOKENS_V1,
  pluginPageForTryV1,
  type PluginPageTryRequestV1,
  type PluginPageTryResultV1,
  type AgentRuntimeV1,
  type ComputerCaptureTimingV1,
  type ComputerTimingV1,
  type RuntimeFeatureV1,
  type Session,
  type SessionStore,
  type ToolAttachmentV1,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type WorkspaceFilesV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { shellQuote } from "./fly/shell.js";
import {
  BROWSER_TASK_DEFAULT_STEPS_V1,
  BROWSER_TASK_MAX_STEPS_V1,
  runBrowserTaskV1,
  type BrowserTaskActionV1,
  type BrowserTaskAnswerV1,
  type BrowserTaskReportV1,
} from "./browser-task.js";
import {
  computerEgressAccountsV1,
  computerEgressNonceV1,
  computerEgressGenericOriginV1,
  createComputerEgressHandlerV1,
  openComputerEgressV1,
  type ComputerEgressJevV1,
  type ComputerEgressSeamV1,
} from "./egress.js";
import {
  createPluginModuleTryToolV1,
  type ComputerPluginModulesSeamV1,
} from "./module-try.js";
import {
  computerBotPathKeyV1,
  ComputerError,
  computerOperationIdV1,
} from "@frockbot/computer/core";
import {
  type ComputerDoctorReportV1,
  type ComputerBackgroundStateV1,
  type ComputerBrowserAction,
  type ComputerHostSessionV1,
  type ComputerRegistry,
  computerSyncSummaryV1,
  type ComputerSyncReasonV1,
  type ComputerSyncSummaryV1,
} from "@frockbot/computer/core/host";
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
  captureComputerFrameV1,
  elapsedMsV1,
  fileComputerScreenshotV1,
  pruneComputerScreenshotsV1,
  timeComputerStepV1,
  type ComputerProjectionFileInvalidationV1,
  type ComputerProjectionFileKindV1,
} from "./capture.js";
import {
  COMPUTER_CONTROL_RECORD_KEY,
  decodeStoredComputerControlV1,
  isStoredComputerControlFreshV1,
} from "./control-record.js";
import {
  computerFrameFromCaptureV1,
  type ComputerFrameSinkV1,
} from "./frame.js";
import {
  restoreOwedComputerLoginsV1,
  upkeepComputerAfterTurnV1,
  type ComputerTurnUpkeepV1,
} from "./upkeep.js";

export {
  COMPUTER_DOCTOR_ROOT_ID,
  COMPUTER_SCREENSHOTS_ROOT_ID,
  COMPUTER_SCREENSHOT_RETENTION,
} from "./roots.js";

export type { ComputerProcessStorageV1 };
export type { ComputerPluginModulesSeamV1 } from "./module-try.js";
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

/** What a browser page is showing, as a judge reads it. */
export type ComputerPageStateV1 =
  "ready" | "sign_in" | "captcha" | "error" | "loading";

/**
 * Reads what a page is showing from its address, title and accessibility
 * snapshot, already redacted, and, given what the Turn was asked and a long
 * list of the page's controls, which of them to use next. `undefined` when it
 * cannot say.
 */
export type ComputerPageJudgeV1 = (
  page: {
    url?: string;
    title?: string;
    snapshot: string;
    /** What the person asked this Turn. */
    goal?: string;
    /** The page's controls as the snapshot names them, `role "name"`. */
    elements?: readonly string[];
  },
  signal?: AbortSignal,
) => Promise<
  { state?: ComputerPageStateV1; next?: readonly string[] } | undefined
>;

/** Fewer controls than this, and the model reads them without help. */
export const BROWSER_RANK_MIN_ELEMENTS_V1 = 12;

/** The most controls one ranking reads, in page order. */
export const BROWSER_RANK_MAX_ELEMENTS_V1 = 40;

const INTERACTIVE_ROLES_V1 =
  /^\s*-\s*(button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|tab|option|switch|slider|spinbutton)\s+"((?:[^"\\]|\\.)+)"/;

/** The page's controls, `role "name"`, once each, in page order. */
export function browserElementsV1(snapshot: string): string[] {
  const seen = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const match = INTERACTIVE_ROLES_V1.exec(line);
    if (match) seen.add(`${match[1]} "${match[2]}"`);
  }
  return [...seen];
}

const PAGE_STATE_NOTES_V1: Readonly<
  Record<Exclude<ComputerPageStateV1, "ready">, string>
> = {
  sign_in:
    "State: a sign-in wall. The page wants an account before it shows anything. Fill a saved secret if the person gave you one for this site; otherwise ask them.",
  captcha:
    "State: a CAPTCHA or bot check. Do not try to solve or get around it. Tell the person, who can complete it on the Computer.",
  error:
    "State: an error page. The site did not show what was asked for; check the address, or try again later.",
  loading:
    'State: still loading. Wait ({"action":"wait","milliseconds":1000}) and take a snapshot before acting on it.',
};

/**
 * A browser action's result as the model reads it: where the page is, what a
 * judge says it is showing when that is not the page itself, then the
 * snapshot.
 */
/**
 * Most of a snapshot the model reads from one `computer_browser` call. The
 * page's controls are still ranked from the whole snapshot.
 */
export const BROWSER_RESULT_SNAPSHOT_CHARS_V1 = 30_000;

export function browserResultTextV1(input: {
  url?: string;
  title?: string;
  snapshot: string;
  state?: ComputerPageStateV1;
  /** The controls a judge picked for what was asked; the snapshot keeps all. */
  next?: readonly string[];
}): string {
  const where = [input.title?.trim(), input.url?.trim()]
    .filter((part): part is string => !!part)
    .join(" — ");
  const notes = [
    ...(input.state && input.state !== "ready"
      ? [PAGE_STATE_NOTES_V1[input.state]]
      : []),
    ...(input.next && input.next.length > 0
      ? [`Likely next for what was asked: ${input.next.join(", ")}`]
      : []),
  ];
  return [
    ...(where ? [`Page: ${where}`] : []),
    ...notes,
    ...(where || notes.length > 0 ? [""] : []),
    input.snapshot.length > BROWSER_RESULT_SNAPSHOT_CHARS_V1
      ? `${input.snapshot.slice(0, BROWSER_RESULT_SNAPSHOT_CHARS_V1)}\n… the rest of the page was cut; act on what is shown or narrow the page`
      : input.snapshot,
  ].join("\n");
}

export interface ComputerAgentPluginConfig {
  /** The product, which a refused connected-account request names. */
  productName: string;
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
   * Where the one frame the card shows goes: the Bot Durable Object's own
   * storage, which for a subagent's Turn is its Bot's object rather than the
   * task's. Absent, and no frame is kept: `computer_screenshot` still files
   * its durable capture, and nothing else photographs the desktop.
   */
  frames?: ComputerFrameSinkV1;
  /**
   * How `computer_browser` fills a secret the person saved, by reference.
   * Absent, and such a fill is refused: nothing else can reach a value.
   */
  secrets?: ComputerSecretFillSeamV1;
  /**
   * What a Turn keeps for the Computer: the User's sign-ins, put back into a
   * machine that is owed them at the Turn's first Computer call and carried
   * off at the end of a Turn that drove the browser, and a weekly
   * checkpoint. Absent, and a Turn does neither.
   */
  upkeep?: ComputerTurnUpkeepV1;
  /** The Package's clock. Tests set it; production takes `Date.now`. */
  now?: () => number;
  /**
   * The demonstrations the person sent this Bot, in the Bot Durable Object
   * that keeps them. Supplied to the Bot's own conversational Turn only;
   * absent, and `demonstration_delete` is not offered.
   */
  demonstrations?: ComputerDemonstrationDeletionV1;
  /** Where `plugin_page_try` gets the page it tries. */
  pluginPages?: ComputerPluginPagesSeamV1;
  /** Where `plugin_module_try` gets the device module it tries. */
  pluginModules?: ComputerPluginModulesSeamV1;
  /**
   * Says what each page `computer_browser` lands on is showing: a sign-in
   * wall, a CAPTCHA, an error, a page still loading. Absent, or when it
   * cannot say, the result carries the page's address and snapshot alone.
   */
  judgePage?: ComputerPageJudgeV1;
  /**
   * How a foreground `computer_exec` reaches the User's connected accounts
   * from the terminal: the Turn's object name, the endpoint the Computer's
   * proxy posts to, and the signer for its token. Absent, or on a host with no
   * `egressShellPrelude`, a command runs with no proxy and no account.
   */
  egress?: ComputerEgressSeamV1;
  /**
   * Answers the terminal's requests to `jev.internal`, charged to the account.
   * Absent, and a command reaches no Jev.
   */
  jev?: ComputerEgressJevV1;
  /**
   * Answers one Jev request of a `computer_browser_task` step, charged to the
   * account. Absent, and the tool is not offered.
   */
  decideBrowserTask?: ComputerBrowserTaskDeciderV1;
}

/** One Jev request of a browser task: `undefined` when Jev could not answer. */
export type ComputerBrowserTaskDeciderV1 = (
  request: {
    state: Record<string, unknown>;
    questions: Record<string, unknown>;
  },
  effectId: string,
  signal?: AbortSignal,
) => Promise<Readonly<Record<string, BrowserTaskAnswerV1>> | undefined>;

/**
 * A Plugin's page as `plugin_publish` would store it, built from its source
 * now, for `plugin_page_try` (ADR 0036 step 10). The Plugin authoring host
 * supplies it; absent, and the tool is not offered.
 */
export interface ComputerPluginPagesSeamV1 {
  pageToTry(input: {
    pluginId: string;
    surfaceId?: string;
  }): Promise<
    | { pluginId: string; surfaceId: string; html: string; microphone: boolean }
    | { failure: string }
  >;
}

/** Deleting one demonstration the person sent this Bot. */
export interface ComputerDemonstrationDeletionV1 {
  delete(demonstrationId: string): Promise<"deleted" | "missing">;
}

const DEMONSTRATION_ID = /^[0-9a-f]{16}$/;

/**
 * `demonstration_delete`: the Bot's half of "the recording is deleted once
 * its Skill is saved or turned down" (parity row 54). The person can discard
 * one they have not sent, and every recording is deleted a week after it
 * stopped whatever happens; this is how the Bot lets go of one sooner.
 */
export function createDemonstrationDeleteToolV1(
  demonstrations: ComputerDemonstrationDeletionV1,
): ToolDefinition {
  const decode = (input: unknown): string | undefined => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return undefined;
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== "demonstrationId")) {
      return undefined;
    }
    return typeof value.demonstrationId === "string" &&
      DEMONSTRATION_ID.test(value.demonstrationId.trim())
      ? value.demonstrationId.trim()
      : undefined;
  };
  return {
    name: "demonstration_delete",
    namespace: "frockbot",
    // The Bot's own conversation, where the person's decision on the draft
    // arrives. A subagent drafts; it does not decide what happens to the
    // person's recording.
    admission: { turnTypes: ["chat"] },
    idempotent: true,
    description: [
      "Delete a demonstration the person recorded on the Computer and sent you: its log and its screenshots.",
      "Call it once the Skill you drafted from it is saved, or once they turned the draft down.",
      "Name it by the `demonstration` id at the top of its log, the file demonstration-<id>.json.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        demonstrationId: {
          type: "string",
          description:
            "The 16-character id from the log's `demonstration` field.",
        },
      },
      required: ["demonstrationId"],
      additionalProperties: false,
    },
    validate: (input: unknown) => decode(input) !== undefined,
    execute: async (input: unknown) => {
      const demonstrationId = decode(input);
      if (!demonstrationId) {
        return {
          content:
            "demonstration_delete was refused: demonstrationId must be the 16-character id from the log",
          isError: true,
        };
      }
      const outcome = await demonstrations.delete(demonstrationId);
      return {
        content:
          outcome === "deleted"
            ? `Deleted demonstration ${demonstrationId}: its log and screenshots are gone. The conversation still says they were attached.`
            : `There is no demonstration ${demonstrationId} to delete: it was already deleted, or it is not one the person sent you.`,
        isError: false,
      };
    },
  };
}

/**
 * The Bot's authority over its User's saved secrets, as the browser tool
 * reaches it. The policy — which fills need the person's approval, and on
 * which site — is the authority's; this Package only does the typing.
 */
export interface ComputerSecretFillSeamV1 {
  /**
   * Whether this fill may go ahead, and on which origin only. `asked` means
   * the person was asked to approve it and the Turn is over; `content` is
   * what the Bot reads either way.
   */
  authorize(request: {
    secretId: string;
    field: string;
    approvalId?: string;
    /** The page's origin now, read only when the decision needs it. */
    pageOrigin(): Promise<string | undefined>;
    context: ToolExecutionContext;
    runtime: Pick<AgentRuntimeV1, "sessions" | "firstPartyCards">;
  }): Promise<
    | { status: "granted"; origin: string; label: string }
    | { status: "asked"; content: string }
    | { status: "refused"; content: string }
  >;
  /** The value, leased for one action under `effectId`. */
  open(request: { secretId: string; effectId: string }): Promise<string>;
  /** Settles that lease, whatever became of the action. */
  release(request: { secretId: string; effectId: string }): Promise<void>;
}

export const HUMAN_CONTROL_PROMPT_LINE =
  "Your User is currently controlling the Computer; do not use it this Turn.";

/** Bounded copy for the two transport failures an overloaded Computer emits. */
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

/** A local HTTP origin a Bot may have opened; public sites never qualify. */
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
/**
 * Said after output the host cut short, so the model knows it is reading part
 * of the answer and how to get the rest.
 */
export const EXEC_TRUNCATED_NOTE_V1 =
  "[Output truncated at 30 KB. Redirect long output to a file and read it with head, tail or grep.]";
/** How long a foreground `computer_exec` may run. */
const EXEC_TIMEOUT_MS = 120_000;
/** An absolute path on the Computer, at the Computer host's own path bound. */
const MAX_EXEC_CWD_LENGTH = 4_096;

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
  fill: '{"action":"fill","label":"New todo","text":"Buy milk"} — label is the field\'s accessible label from the snapshot; for a password or card number the user saved, {"action":"fill","label":"Password","secret":"secret-…"} with the reference in place of text',
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

/** The origin of a page's address, or nothing for one that is not a web page. */
function webOriginV1(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A fill that names a saved secret instead of text. Decoded apart from the
 * host's own actions, because the value is never the model's to supply: the
 * Bot's authority leases it for the one action this becomes.
 */
interface SecretFillInputV1 {
  type: "fill-by-secret";
  label: string;
  secretId: string;
  approvalId?: string;
  exact?: boolean;
}

function decodeBrowser(
  input: unknown,
): ComputerBrowserAction | SecretFillInputV1 | undefined {
  const value = record(input);
  if (value?.action === "fill" && value.secret !== undefined) {
    const label = optionalString(value.label) ?? optionalString(value.name);
    return label !== undefined &&
      value.text === undefined &&
      typeof value.secret === "string" &&
      value.secret.length > 0 &&
      value.secret.length <= 128 &&
      (value.approval === undefined ||
        (typeof value.approval === "string" &&
          value.approval.length > 0 &&
          value.approval.length <= 128))
      ? {
          type: "fill-by-secret",
          label,
          secretId: value.secret,
          ...(typeof value.approval === "string"
            ? { approvalId: value.approval }
            : {}),
          ...(typeof value.exact === "boolean" ? { exact: value.exact } : {}),
        }
      : undefined;
  }
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
  session.append({
    type: "computer/sync",
    turn: Math.max(1, turn),
    reason,
    ...summary,
  });
  // The record is durable before anything reports the sync happened.
  await session.flush();
}

type ComputerTimedPhaseV1 = "attach" | "sync" | "selfCheck" | "operation";

/**
 * The phases of one Computer tool call or Turn end, as `computer/timing`
 * records them. A phase is recorded once it has run, so a call that failed
 * part-way still says where its time went, and one that never ran is absent.
 */
class ComputerCallTiming {
  readonly #started: number;
  readonly #ms: Omit<ComputerTimingV1, "total"> = {};

  constructor(private readonly now: () => number) {
    this.#started = now();
  }

  /** Whether any phase ran; a call refused before it reached the Computer has none. */
  get ran(): boolean {
    return Object.keys(this.#ms).length > 0;
  }

  /** Times `run` into `name`, adding to what that phase already holds. */
  phase<T>(name: ComputerTimedPhaseV1, run: () => Promise<T>): Promise<T> {
    return timeComputerStepV1(this.now, run, (ms) => {
      this.#ms[name] = (this.#ms[name] ?? 0) + ms;
    });
  }

  /** Times one screenshot filing, which fills in its own steps. */
  capture<T>(run: (steps: ComputerCaptureTimingV1) => Promise<T>): Promise<T> {
    const steps: ComputerCaptureTimingV1 = { total: 0 };
    return timeComputerStepV1(
      this.now,
      () => run(steps),
      (ms) => {
        this.#ms.capture = { ...steps, total: ms };
      },
    );
  }

  finish(): ComputerTimingV1 {
    return { ...this.#ms, total: elapsedMsV1(this.now, this.#started) };
  }
}

/** A browser task's input, or the refusal naming the field that is wrong. */
export function decodeBrowserTaskV1(input: unknown):
  | {
      goal: string;
      values: Record<string, string>;
      url?: string;
      maxSteps?: number;
    }
  | string {
  const value = record(input);
  if (!value || typeof value.goal !== "string" || !value.goal.trim()) {
    return 'computer_browser_task input is invalid: "goal" must be the outcome wanted, as text.';
  }
  if (value.goal.length > 2_000) {
    return 'computer_browser_task input is invalid: "goal" is at most 2000 characters; keep it to one outcome.';
  }
  const values: Record<string, string> = {};
  if (value.values !== undefined) {
    const given = record(value.values);
    if (!given || Object.keys(given).length > 30) {
      return 'computer_browser_task input is invalid: "values" must be an object of at most 30 named strings.';
    }
    for (const [key, text] of Object.entries(given)) {
      if (
        typeof text !== "string" ||
        text.length > 5_000 ||
        !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)
      ) {
        return `computer_browser_task input is invalid: values.${key} must be text of at most 5000 characters, named with letters, digits and underscores.`;
      }
      values[key] = text;
    }
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    return 'computer_browser_task input is invalid: "url" must be an address.';
  }
  if (
    value.maxSteps !== undefined &&
    (typeof value.maxSteps !== "number" ||
      !Number.isInteger(value.maxSteps) ||
      value.maxSteps < 1)
  ) {
    return 'computer_browser_task input is invalid: "maxSteps" must be a whole number of at least 1.';
  }
  return {
    goal: value.goal.trim(),
    values,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.maxSteps === "number" ? { maxSteps: value.maxSteps } : {}),
  };
}

/** The host action one browser-task action is: by role and name, exactly. */
export function browserTaskHostActionV1(
  action: BrowserTaskActionV1,
  value: string | undefined,
): ComputerBrowserAction {
  const { role, name, nth, count } = action.control;
  const which = count > 1 ? { nth } : {};
  switch (action.operation.op) {
    case "click":
      return { type: "click", role, name, exact: true, ...which };
    case "type":
      return {
        type: "fill",
        role,
        label: name,
        text: value ?? "",
        exact: true,
        ...which,
      };
    case "select":
      return {
        type: "select",
        role,
        name,
        option: action.operation.option,
        exact: true,
        ...which,
      };
  }
}

const BROWSER_TASK_PAGE_CHARS_V1 = 4_000;

/** A finished task, as the model reads it. */
export function browserTaskResultTextV1(report: BrowserTaskReportV1): string {
  const lines = [`Outcome: ${report.outcome}. ${report.reason}`];
  if (report.steps.length) {
    lines.push("", "What it did:", ...report.steps.map((step) => `- ${step}`));
  }
  if (report.page) {
    const snapshot = report.page.snapshot;
    lines.push(
      "",
      `Page: ${report.page.title ?? ""}${report.page.url ? ` — ${report.page.url}` : ""}`,
      snapshot.length <= BROWSER_TASK_PAGE_CHARS_V1
        ? snapshot
        : `${snapshot.slice(0, BROWSER_TASK_PAGE_CHARS_V1)}…`,
    );
  }
  return lines.join("\n");
}

/**
 * The Turn's sync state, and the only place this Package decides to sync.
 *
 * Deep and small on purpose: `beforeUse` and `afterTurn` are the whole
 * surface, they never throw, and every path through them either records a
 * `computer/sync` event or has nothing to record. A caller cannot get the
 * policy wrong because there is no way to ask for a sync at another time.
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
    computer: ComputerHostSessionV1,
    sessionId: string,
    signal: AbortSignal,
    timing: ComputerCallTiming,
  ): Promise<void> {
    this.#used = true;
    const sync = computer.sync;
    if (!sync) return;
    await timing.phase("sync", () => this.#beforeUse(sync, sessionId, signal));
  }

  async #beforeUse(
    sync: NonNullable<ComputerHostSessionV1["sync"]>,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
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
  async afterTurn(
    computer: ComputerHostSessionV1,
    sessionId: string,
    timing: ComputerCallTiming,
  ): Promise<void> {
    this.#used = false;
    const sync = computer.sync;
    if (!sync) return;
    await timing.phase("sync", async () =>
      this.record(sessionId, "turn-end", await sync.reconcile("turn-end")),
    );
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
  computer: ComputerHostSessionV1,
  run: (computer: ComputerHostSessionV1) => Promise<T>,
): Promise<T> {
  try {
    return await run(computer);
  } finally {
    await computer.close();
  }
}

export function createComputerAgentFeature(
  config: ComputerAgentPluginConfig,
): RuntimeFeatureV1<AgentRuntimeV1 & { computers: ComputerRegistry }> {
  const userId = config.userId.trim();
  const defaultProviderId = config.defaultProviderId.trim();
  if (!userId) throw new Error("Computer user id must be non-empty");
  if (!defaultProviderId) {
    throw new Error("Computer default provider id must be non-empty");
  }

  return (runtime) => {
    // A deployment with no Computer offers no Computer tool and no Computer
    // prompt. The alternative — tools that always fail — spends a Turn's model
    // budget discovering what this host already knows, and leaves the model
    // inventing a way for the User to fix it.
    if (config.configured === false) return [];
    // One Computer per User: the assignment is keyed by the User,
    // and the Bot attaches to it as a tenant.
    const identity = { userId };
    // What the host this Bot will open is, read once, from the registry
    // rather than from a host's own module: the tools describe the Computer
    // and refuse a command before any Computer has been woken to ask.
    const capabilities = runtime.computers.capabilities(defaultProviderId);
    const scratchName = capabilities?.scratchPath
      ? `${capabilities.scratchPath} (also $FROCKBOT_SCRATCH)`
      : "$FROCKBOT_SCRATCH";
    const turnSync = new ComputerTurnSync(runtime.sessions);
    const controlPrompt = config.controlRecords
      ? new ComputerControlPromptProjection(config.controlRecords)
      : undefined;
    // The Turn ordinal a `computer/process` event is recorded under. The
    // Agent loop knows it; a tool context does not, so it is caught where the
    // loop already announces it.
    let currentTurn = 1;
    /** Local preview origins this Bot navigated to during the current Turn. */
    const previewOrigins = new Set<string>();
    const frames = config.frames;
    /**
     * Whether this Turn filed a `computer_screenshot`: the Turn end prunes
     * the durable captures only then, so a Turn that filed none lists nothing.
     */
    let screenshotFiledThisTurn = false;
    /** Whether this Turn drove the browser: its end keeps the sign-ins then. */
    let browserUsedThisTurn = false;
    /** Whether this Turn already asked if the machine is owed the sign-ins. */
    let owedAskedThisTurn = false;
    const upkeep = config.upkeep;
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
    const now = config.now ?? Date.now;
    /** The timing of each Computer tool call in flight, keyed by its context. */
    const callTimings = new WeakMap<ToolExecutionContext, ComputerCallTiming>();
    const timingOf = (context: ToolExecutionContext): ComputerCallTiming =>
      callTimings.get(context) ?? new ComputerCallTiming(now);
    /**
     * The id this tool call runs under on the Computer. Outside a Turn there
     * is no run, and the Session stands in: its turn counter never restarts.
     */
    const operationIdOf = (context: ToolExecutionContext): Promise<string> =>
      computerOperationIdV1({
        botId: context.botId,
        runId: config.writer?.runId ?? context.sessionId,
        effectId: context.effectId,
      });
    /** Times one Computer call itself, apart from what this Package does around it. */
    const operation = <T>(
      context: ToolExecutionContext,
      run: () => Promise<T>,
    ): Promise<T> => timingOf(context).phase("operation", run);
    /**
     * Appends one `computer/timing` line. The append starts its write and
     * nothing waits for it: a tool call's line is settled by the flush that
     * records the call's result, and a diagnostic is never worth a Turn's
     * latency.
     */
    const noteTiming = (
      sessionId: string,
      turn: number,
      timing: ComputerCallTiming,
      tool?: string,
    ): void => {
      const session = runtime.sessions.get(sessionId);
      if (!session || session.disposed) return;
      session.append({
        type: "computer/timing",
        turn: Math.max(1, turn),
        ...(tool === undefined
          ? { scope: "turn-end" as const }
          : { scope: "tool" as const, tool }),
        ms: timing.finish(),
      });
    };
    /**
     * A Computer tool that records where each of its calls spent its time.
     * Wrapped at registration, so no Computer tool can be added without it.
     */
    const timed = (definition: ToolDefinition): ToolDefinition => ({
      ...definition,
      execute: async (input, context) => {
        // Read now: a call a Stop cut short can end after the next Turn began.
        const turn = turnOf(context);
        const timing = new ComputerCallTiming(now);
        callTimings.set(context, timing);
        try {
          return await definition.execute(input, context);
        } finally {
          callTimings.delete(context);
          if (timing.ran) {
            noteTiming(context.sessionId, turn, timing, definition.name);
          }
        }
      },
    });
    const attach = async (botId: string, signal: AbortSignal) => {
      if (!runtime.computers.assignment(identity)) {
        runtime.computers.assign(identity, defaultProviderId);
      }
      return runtime.computers.open(identity, { botId }, { signal });
    };
    /**
     * Opens the Computer for one tool call and reconciles the durable roots
     * before the Bot looks at them. The sync is inside `open` rather than
     * beside each tool so no Computer tool can be added that skips it.
     */
    const open = async (context: ToolExecutionContext) => {
      const timing = timingOf(context);
      const computer = await timing.phase("attach", () =>
        attach(context.botId, context.signal),
      );
      await turnSync.beforeUse(
        computer,
        context.sessionId,
        context.signal,
        timing,
      );
      const vault = upkeep?.vault;
      if (vault && !owedAskedThisTurn) {
        // A machine an Update or a Reset left behind gets the sign-ins back
        // before this Turn looks at a single page.
        owedAskedThisTurn = true;
        const effectId = await computerOperationIdV1({
          botId: context.botId,
          runId: config.writer?.runId ?? context.sessionId,
          effectId: `turn:${turnOf(context)}:restore-sign-ins`,
        });
        await timing.phase("operation", () =>
          restoreOwedComputerLoginsV1({ computer, vault, effectId }),
        );
      }
      await selfCheck(computer, context.botId, context.signal, timing);
      return computer;
    };
    const closePreviewTabs = async (
      computer: ComputerHostSessionV1,
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

    /**
     * Opens one foreground exec's reach to the User's connected accounts, for
     * as long as the call runs: a token naming this object and the call, and
     * the handler that answers the requests the Computer's proxy forwards
     * under it. Nothing opens when no connected account has a route, so a
     * command that cannot use one runs exactly as it would without.
     */
    /**
     * The person's connected apps, as the terminal reaches them: read when the
     * prompt is assembled, after every app's feature has mounted.
     */
    const connectedAppsPromptLines = (): string[] => {
      if (!config.egress || !capabilities?.egressShellPrelude) return [];
      const accounts = computerEgressAccountsV1(runtime.tools);
      if (accounts.length === 0) return [];
      return [
        `From the terminal, a foreground command reaches these connected apps with no token, at the app's API paths: ${accounts
          .map(
            (account) =>
              `${account.label} at ${computerEgressGenericOriginV1(account.toolkit)}/`,
          )
          .join(
            "; ",
          )}. For example, curl -s ${computerEgressGenericOriginV1(accounts[0]!.toolkit)}/<path of its API>.`,
      ];
    };

    const openEgress = async (
      context: ToolExecutionContext,
    ): Promise<{ prelude: string; close: () => void } | undefined> => {
      const seam = config.egress;
      const prelude = capabilities?.egressShellPrelude;
      if (!seam || !prelude) return undefined;
      const accounts = () => computerEgressAccountsV1(runtime.tools);
      if (accounts().length === 0 && !config.jev) return undefined;
      const nonce = computerEgressNonceV1();
      const expiresAt = now() + EXEC_TIMEOUT_MS + 5_000;
      const token = await seam.sign({
        v: 1,
        o: seam.object,
        n: nonce,
        x: expiresAt,
        u: seam.endpoint,
      });
      const close = openComputerEgressV1(nonce, {
        object: seam.object,
        expiresAt,
        answer: createComputerEgressHandlerV1({
          productName: config.productName,
          accounts,
          context,
          // A write is reviewed where every `mutate` call is: the Turn's own
          // prepare hooks, which supervision leads.
          review: (call, reviewContext) =>
            runtime.hooks.prepareTool(call, reviewContext, async () => ({
              kind: "ready",
              call,
              idempotent: false,
            })),
          ...(config.jev ? { jev: config.jev } : {}),
        }),
      });
      return {
        prelude: prelude(token, { accounts: accounts().length > 0 }),
        close,
      };
    };

    const execTool: ToolDefinition = {
      name: "computer_exec",
      namespace: "frockbot",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor", "computerUse"],
      },
      idempotent: config.idempotentEffects === true,
      // Every command is reviewed before it runs, like any call that can act
      // on the world: a shell reaches the internet and the User's connected
      // accounts, so what it reads and where it sends it are both the
      // person's to have asked for.
      effect: "mutate",
      description: [
        "Run a shell command in the Bot's selected persistent Computer. New calls are blocked while the user has taken control.",
        "This is where most work gets done: use command-line tools such as git, gh, jq and curl, and write a Python script for anything longer than a line or two. Install a missing tool with apt, pip or uv.",
        "Every command is reviewed before it runs, so run what the person's request needs and nothing it does not.",
        "A foreground command reaches the person's connected apps with no token: each is at https://<app>.connected.internal/ followed by the path of that app's own API, and gh reaches GitHub as usual. Every request as the person is reviewed before it is sent. Background commands have no connected accounts.",
        ...(config.jev
          ? [
              'A foreground command can also ask Jev, a fast decision model, by POSTing a TypeSafe System One body ({"state": {...}, "questions": {...}}) to https://jev.internal/v1/system-one; each request is charged to the person\'s account by the input tokens it uses.',
            ]
          : []),
        "Pass cwd as an absolute path to run the command in that directory instead of the home directory.",
        "With background:true the command keeps running after this call returns and after this Turn ends, and you get a processId to check later.",
        "A background process runs only while the Computer is awake. Nothing keeps it awake for you: if the Computer hibernates first, the outcome is reported as unknown, with whatever log was durable at the time.",
        `${scratchName} is scratch shared with your User's other Bots: it survives hibernation but is not durable and never reaches storage, so keep nothing there you cannot lose.`,
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
        // "The GUI is never driven from the shell" (parity row 33), refused
        // before the Computer is woken, in the words of the host that shims
        // the same commands on its own PATH. Policy and not a boundary — a
        // regex over a shell string is defeatable, and the Computer is the
        // User's trust boundary anyway — so both exist only to make the
        // sanctioned surface the easy one.
        const refusal = capabilities?.refuseGuiCommand?.(decoded.command);
        if (refusal) return { content: refusal, isError: true };
        if (decoded.background) {
          return processes
            ? // A launch carries a command and not a directory, so the
              // directory becomes part of the command. `cd` failing stops the
              // process before it starts, which is what a wrong path deserves.
              launchBackground(
                decoded.cwd
                  ? `cd ${shellQuote(decoded.cwd)} && ${decoded.command}`
                  : decoded.command,
                context,
              )
            : {
                content:
                  "A background process is recorded before it is launched; this runtime has nowhere durable to record it",
                isError: true,
              };
        }
        let closeEgress: (() => void) | undefined;
        try {
          const effectId = await operationIdOf(context);
          return await useComputer(await open(context), async (computer) => {
            const exec = computer.exec;
            if (!exec) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support command execution",
              );
            }
            // Minted once the Computer is open: the first open after a release
            // updates its runtime, which can outlast the token's lifetime.
            const egress = await openEgress(context);
            closeEgress = egress?.close;
            const command = egress
              ? `${egress.prelude}\n${decoded.command}`
              : decoded.command;
            const result = await operation(context, () =>
              exec.execute(
                {
                  executable: "/bin/bash",
                  args: ["-lc", command],
                  ...(decoded.cwd ? { cwd: decoded.cwd } : {}),
                  timeoutMs: EXEC_TIMEOUT_MS,
                  maxOutputBytes: 30_000,
                },
                { signal: context.signal, effectId },
              ),
            );
            return {
              content: [
                text(result.stdout),
                text(result.stderr),
                ...(result.outputTruncated ? [EXEC_TRUNCATED_NOTE_V1] : []),
              ]
                .filter(Boolean)
                .join("\n"),
              isError: result.exitCode !== 0,
            };
          });
        } catch (error) {
          return failure(error);
        } finally {
          closeEgress?.();
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
      const session = runtime.sessions.get(sessionId);
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
      computer: ComputerHostSessionV1,
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
        const effectId = await operationIdOf(context);
        return await useComputer(await open(context), async (computer) => {
          if (!computer.processes) {
            throw new ComputerError(
              "capability-unavailable",
              "The selected Computer does not support background processes",
            );
          }
          const processes = computer.processes;
          const processId = `p-${effectId}`;
          const generation = await operation(context, () =>
            processes.generation({ signal: context.signal }),
          );
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
          const launched = await operation(context, () =>
            processes.launch(
              { processId, command },
              { signal: context.signal, effectId },
            ),
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
        });
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
        const effectId = await operationIdOf(context);
        return await useComputer(await open(context), async (computer) => {
          if (!computer.processes) {
            throw new ComputerError(
              "capability-unavailable",
              "The selected Computer does not support background processes",
            );
          }
          const processes = computer.processes;
          const currentGeneration = await operation(context, () =>
            processes.generation({ signal: context.signal }),
          );
          const observed: ComputerBackgroundStateV1 = await operation(
            context,
            () =>
              action === "stop"
                ? processes.stop(processId, {
                    signal: context.signal,
                    effectId,
                  })
                : processes.inspect(processId, {
                    signal: context.signal,
                    ...(tailBytes === undefined ? {} : { tailBytes }),
                  }),
          );
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
        });
      } catch (error) {
        return failure(error);
      }
    };

    let captureSequence = 0;

    /** This User's `screenshots` root, where `computer_screenshot` files. */
    const screenshotsRoot = (): WorkspaceRootV1 => ({
      kind: "package-declared",
      userId,
      packageId: "computer",
      rootId: COMPUTER_SCREENSHOTS_ROOT_ID,
    });

    /**
     * Files one `computer_screenshot` capture of this Bot's own desktop in the
     * `screenshots` root, under this Turn.
     */
    const fileBotScreenshot = (input: {
      computer: ComputerHostSessionV1;
      workspace: WorkspaceFilesV1;
      writer: ComputerWriterIdentityV1;
      botId: string;
      effectId: string;
      steps: ComputerCaptureTimingV1;
      signal?: AbortSignal;
    }) => {
      const botKey = computerBotPathKeyV1(input.botId);
      captureSequence += 1;
      return fileComputerScreenshotV1({
        computer: input.computer,
        workspace: input.workspace,
        path: {
          root: screenshotsRoot(),
          path: `${botKey}/${input.writer.turnId}-${captureSequence}.png`,
        },
        writer: {
          kind: "bot",
          botId: input.botId,
          sessionId: input.writer.sessionId,
          turnId: input.writer.turnId,
          runId: input.writer.runId,
        },
        effectId: input.effectId,
        ...(input.signal ? { signal: input.signal } : {}),
        timing: input.steps,
        now,
      });
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
      namespace: "frockbot",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
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
          const effectId = await operationIdOf(context);
          return await useComputer(await open(context), async (computer) => {
            const workspace = computer.workspace;
            if (!workspace) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer exposes no Workspace to file a screenshot in",
              );
            }
            const filed = await timingOf(context).capture((steps) =>
              fileBotScreenshot({
                computer,
                workspace,
                writer,
                botId: context.botId,
                effectId,
                steps,
                signal: context.signal,
              }),
            );
            const path = filed.path;
            screenshotFiledThisTurn = true;
            // The Bot just looked at its own screen; so does the card.
            const frame = frames
              ? await computerFrameFromCaptureV1(filed.captured)
              : undefined;
            if (frames && frame) {
              try {
                await frames.put(frame);
                noteProjectionWrite("frame");
                invalidateProjectionWrites(context.botId);
              } catch {
                // The card keeps its previous frame; the Bot has its capture.
              }
            }
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
            runtime.sessions
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
          });
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
      computer: ComputerHostSessionV1,
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
      computer: ComputerHostSessionV1,
      botId: string,
      signal: AbortSignal,
      timing: ComputerCallTiming,
    ): Promise<void> => {
      const doctor = computer.doctor;
      if (selfChecked || !doctor || !writer) return;
      selfChecked = true;
      try {
        await timing.phase("selfCheck", async () => {
          const report = await doctor.run({ signal });
          await fileDoctorReport(computer, botId, report);
        });
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
      namespace: "frockbot",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
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
          return await useComputer(await open(context), async (computer) => {
            const doctor = computer.doctor;
            if (!doctor) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support a self-check",
              );
            }
            const report = await operation(context, () =>
              doctor.run({ signal: context.signal }),
            );
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
          });
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
      namespace: "frockbot",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
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
      namespace: "frockbot",
      idempotent: true,
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
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
      namespace: "frockbot",
      // The desktop half of the Computer: the shell, the screen, and the
      // processes a shell left running. Offered to an `executor` subagent,
      // which has the full work toolset, and to a `computerUse` one, whose
      // whole job is the desktop; never to `browserUse`, which drives pages
      // and not the box, and never to the two video roles, which have no
      // Computer at all.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
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

    /**
     * One fill of a secret the person saved, by its reference.
     *
     * The authority decides first — the secret's own site, or a fresh
     * approval of this page and field — and names the one origin the page
     * may be on. Only then is the value leased, for this action and nothing
     * else, typed by the host, and the lease settled whatever happened. What
     * comes back is whether the field was filled: never a snapshot, and never
     * anything carrying the value, which is scrubbed from a failure's words
     * too in case a browser echoed it.
     */
    const fillSecret = async (
      action: SecretFillInputV1,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const secrets = config.secrets;
      if (!secrets) {
        return {
          content:
            "Saved secrets cannot be filled here. Ask the user to type it into the page themselves.",
          isError: true,
        };
      }
      try {
        const effectId = await operationIdOf(context);
        return await useComputer(await open(context), async (computer) => {
          const browser = computer.browser;
          if (!browser) {
            throw new ComputerError(
              "capability-unavailable",
              "The selected Computer does not support browser automation",
            );
          }
          const grant = await secrets.authorize({
            secretId: action.secretId,
            field: action.label,
            ...(action.approvalId === undefined
              ? {}
              : { approvalId: action.approvalId }),
            context,
            runtime,
            pageOrigin: async () => {
              const where = await operation(context, async () =>
                browser.perform(
                  { type: "snapshot" },
                  {
                    signal: context.signal,
                    effectId: await computerOperationIdV1({
                      botId: context.botId,
                      runId: config.writer?.runId ?? context.sessionId,
                      effectId: `${context.effectId}:page-origin`,
                    }),
                  },
                ),
              );
              return webOriginV1(where.url);
            },
          });
          if (grant.status === "refused") {
            return { content: grant.content, isError: true };
          }
          if (grant.status === "asked") {
            return { content: grant.content, isError: false, endsTurn: true };
          }
          const value = await secrets.open({
            secretId: action.secretId,
            effectId,
          });
          try {
            await operation(context, () =>
              browser.perform(
                {
                  type: "fill-secret",
                  label: action.label,
                  ...(action.exact === undefined
                    ? {}
                    : { exact: action.exact }),
                  origin: grant.origin,
                  value,
                },
                { signal: context.signal, effectId },
              ),
            );
            return {
              content: `Filled "${action.label}" with the saved secret "${grant.label}". Its value is not shown to you; take a snapshot to see the page, where the field reads as hidden.`,
              isError: false,
            };
          } catch (error) {
            const told = failure(error);
            return {
              ...told,
              content:
                value.length === 0
                  ? told.content
                  : told.content.split(value).join("[secret]"),
            };
          } finally {
            await secrets
              .release({ secretId: action.secretId, effectId })
              .catch(() => undefined);
          }
        });
      } catch (error) {
        return failure(error);
      }
    };

    /** What the person asked in the Turn this call runs in. */
    const turnGoal = (sessionId: string): string | undefined => {
      const session = runtime.sessions.get(sessionId);
      if (!session) return undefined;
      const journal = session.activeRunJournal;
      const turn = journal.findLast((event) => "turn" in event);
      const current = turn && "turn" in turn ? turn.turn : undefined;
      const said = journal.flatMap((event) =>
        event.type === "user/message" && event.turn === current
          ? [event.text]
          : [],
      );
      return said.length > 0 ? said.join("\n\n").slice(0, 1_000) : undefined;
    };

    const browserTool: ToolDefinition = {
      name: "computer_browser",
      namespace: "frockbot",
      // Page-level browser control, which `browserUse` exists for.
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor", "browserUse", "computerUse"],
      },
      idempotent: config.idempotentEffects === true,
      description:
        'Control the browser in the Bot\'s selected Computer and return an accessibility snapshot. Shapes: {"action":"snapshot"}; {"action":"navigate","url":...}; {"action":"click","role":"button","name":"Add"} (role AND name, both from the snapshot line, e.g. checkbox "Mark done"); {"action":"fill","label":"New todo","text":...}; {"action":"press","key":"Enter"}; {"action":"wait","milliseconds":500}. For a password, card number or other secret the user saved, fill by its reference instead of text: {"action":"fill","label":"Password","secret":"secret-…"}. You are never given the value, and must not read it back from the page; the result says only whether the field was filled. A payment detail, or a secret used on a site other than its own, first asks the user to approve that page and field; once they have, repeat the same fill with "approval" set to the id you were given.',
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
          secret: {
            type: "string",
            description:
              "fill: a saved secret's reference (secret-…), in place of text",
          },
          approval: {
            type: "string",
            description:
              "fill with a secret: the approval id the user approved this fill under",
          },
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
        browserUsedThisTurn = true;
        if (action.type === "fill-by-secret") {
          return fillSecret(action, context);
        }
        try {
          const effectId = await operationIdOf(context);
          return await useComputer(await open(context), async (computer) => {
            const browser = computer.browser;
            if (!browser) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support browser automation",
              );
            }
            const result = await operation(context, () =>
              browser.perform(action, { signal: context.signal, effectId }),
            );
            if (action.type === "navigate") {
              const origin = localPreviewOriginV1(action.url);
              if (origin) previewOrigins.add(origin);
            }
            const page = {
              ...(result.url ? { url: result.url } : {}),
              ...(result.title ? { title: result.title } : {}),
              snapshot: result.accessibilitySnapshot,
            };
            // A long page's controls are ranked against what was asked; a
            // short one's the model reads at a glance.
            const elements = browserElementsV1(result.accessibilitySnapshot);
            const goal = turnGoal(context.sessionId);
            const ranked =
              goal && elements.length > BROWSER_RANK_MIN_ELEMENTS_V1
                ? {
                    goal,
                    elements: elements.slice(0, BROWSER_RANK_MAX_ELEMENTS_V1),
                  }
                : {};
            const judged = await config.judgePage?.(
              { ...page, ...ranked },
              context.signal,
            );
            return {
              content: browserResultTextV1({
                ...page,
                ...(judged?.state ? { state: judged.state } : {}),
                ...(judged?.next ? { next: judged.next } : {}),
              }),
              isError: false,
            };
          });
        } catch (error) {
          return failure(error);
        }
      },
    };

    const browserTaskTool: ToolDefinition = {
      name: "computer_browser_task",
      namespace: "frockbot",
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor", "browserUse", "computerUse"],
      },
      // Its own clicks that commit anything are reviewed as `mutate` calls
      // one by one, before each runs; the task as a whole acts on nothing.
      description: [
        "Do one thing on a web page in the Computer's browser, fast: give the outcome you want as `goal` and every piece of text to type in `values`, and a decision model reads the page and clicks, types, ticks and chooses a step at a time until the goal is done.",
        "Use it for forms, settings, lists and anything that takes several clicks. Use computer_browser to read a page, to act once, or for a password or card number the person saved.",
        'One outcome per call, spelled out: "add 2 large mugs to the cart and place the order", not "buy mugs". It never invents text: anything it must type goes in values, named for what it is.',
        "A click that would buy, send, delete, publish or submit is reviewed before it runs; if it is refused, the result says so and you ask the person.",
        "The result says how it ended — done, blocked, needs_person (a sign-in or a CAPTCHA), needs_approval, step_limit — what it did, and the page it ended on.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The one outcome wanted on the page, spelled out.",
          },
          values: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              'Text to type, each named for what it is: {"email": "sam@example.com"}.',
          },
          url: {
            type: "string",
            description:
              "Open this address first. Absent, it starts on the current page.",
          },
          maxSteps: {
            type: "number",
            description: `At most this many actions (default ${BROWSER_TASK_DEFAULT_STEPS_V1}, at most ${BROWSER_TASK_MAX_STEPS_V1}).`,
          },
        },
        required: ["goal"],
        additionalProperties: false,
      },
      validate: (input) => !!record(input),
      execute: async (input, context) => {
        const task = decodeBrowserTaskV1(input);
        if (typeof task === "string") return { content: task, isError: true };
        const decide = config.decideBrowserTask;
        if (!decide) {
          return {
            content:
              "Browser tasks are not available here; use computer_browser.",
            isError: true,
          };
        }
        browserUsedThisTurn = true;
        try {
          return await useComputer(await open(context), async (computer) => {
            const browser = computer.browser;
            if (!browser) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer does not support browser automation",
              );
            }
            // Every host call and Jev request of the task is its own effect,
            // under the task call's id, so a re-run after an eviction repeats
            // none of them under a new identity.
            let sequence = 0;
            const perform = async (action: ComputerBrowserAction) =>
              operation(context, async () =>
                browser.perform(action, {
                  signal: context.signal,
                  effectId: await computerOperationIdV1({
                    botId: context.botId,
                    runId: config.writer?.runId ?? context.sessionId,
                    effectId: `${context.effectId}:task:${sequence++}`,
                  }),
                }),
              );
            if (task.url) {
              await perform({ type: "navigate", url: task.url });
              const origin = localPreviewOriginV1(task.url);
              if (origin) previewOrigins.add(origin);
            }
            let decisions = 0;
            let reviews = 0;
            const report = await runBrowserTaskV1(task, {
              observe: async () => {
                const state = await perform({ type: "snapshot" });
                return {
                  ...(state.url ? { url: state.url } : {}),
                  ...(state.title ? { title: state.title } : {}),
                  snapshot: state.accessibilitySnapshot,
                };
              },
              act: async (action, value) => {
                await perform(browserTaskHostActionV1(action, value));
                if (action.operation.op === "type" && action.operation.submit) {
                  await perform({ type: "press", key: "Enter" });
                }
              },
              decide: (request) =>
                decide(
                  request,
                  `${context.effectId}:jev:${decisions++}`,
                  context.signal,
                ),
              review: async (action, page) => {
                const effectId = `${context.effectId}:review:${reviews++}`;
                const call: ToolCall = {
                  id: effectId,
                  name: "computer_browser_task",
                  input: {
                    goal: task.goal,
                    click: action.describe,
                    ...(page.url ? { url: page.url } : {}),
                    ...(page.title ? { title: page.title } : {}),
                  },
                };
                const prepared = await runtime.hooks.prepareTool(
                  call,
                  { ...context, effectId, toolCall: call, effect: "mutate" },
                  async () => ({ kind: "ready", call, idempotent: false }),
                );
                return prepared.kind === "denied"
                  ? prepared.result.content || "The review refused it."
                  : undefined;
              },
            });
            return {
              content: browserTaskResultTextV1(report),
              isError: false,
            };
          });
        } catch (error) {
          return failure(error);
        }
      },
    };

    /**
     * The work after a Turn that used the Computer: close the preview tabs it
     * opened, file the frame the card shows while the Bot is idle, and push.
     * The Computer is already awake for this Bot, so the push costs no wake,
     * and a Computer that paused mid-Turn answers `unavailable` and the next
     * run finishes the work.
     */
    const closeTurn = async (
      botId: string,
      sessionId: string,
      turn: number,
      timing: ComputerCallTiming,
    ): Promise<void> => {
      const turnEndIdOf = (step: string): Promise<string> =>
        computerOperationIdV1({
          botId,
          runId: writer?.runId ?? sessionId,
          effectId: `turn-end:${turn}:${step}`,
        });
      let computer: ComputerHostSessionV1;
      try {
        computer = await timing.phase("attach", () =>
          attach(botId, new AbortController().signal),
        );
      } catch (error) {
        await turnSync.unavailable(sessionId, error);
        invalidateProjectionWrites(botId);
        return;
      }
      try {
        if (computer.browser && previewOrigins.size > 0) {
          const origins = [...previewOrigins];
          const effectId = await turnEndIdOf("close-preview-tabs");
          await timing.phase("operation", () =>
            closePreviewTabs(computer, origins, effectId),
          );
          previewOrigins.clear();
        }
        // The card's frame: how this Turn left the desktop, which is how it
        // stays until the next one. One capture and one write, after the
        // reply has gone.
        const workspace = computer.workspace;
        const prune = screenshotFiledThisTurn && writer && workspace;
        screenshotFiledThisTurn = false;
        if ((frames && computer.screenshot) || prune) {
          try {
            await timing.capture(async (steps) => {
              if (frames && computer.screenshot) {
                try {
                  if (
                    await captureComputerFrameV1({
                      computer,
                      frames,
                      effectId: await turnEndIdOf("frame"),
                      timing: steps,
                      now,
                    })
                  ) {
                    noteProjectionWrite("frame");
                  }
                } catch {
                  // Opportunistic capture never changes the Turn outcome.
                  // The provider's human-control refusal is deliberately
                  // preserved.
                }
              }
              if (prune) {
                await pruneComputerScreenshotsV1({
                  workspace,
                  root: screenshotsRoot(),
                  botKey: computerBotPathKeyV1(botId),
                  writer: {
                    kind: "bot",
                    botId,
                    sessionId: writer.sessionId,
                    turnId: writer.turnId,
                    runId: writer.runId,
                  },
                  timing: steps,
                  now,
                });
              }
            });
          } catch {
            // Retention is best effort; the Turn is already over.
          }
        }
        await turnSync.afterTurn(computer, sessionId, timing);
        if (upkeep) {
          const browserUsed = browserUsedThisTurn;
          browserUsedThisTurn = false;
          await timing.phase("operation", () =>
            upkeepComputerAfterTurnV1({
              computer,
              records: upkeep.records,
              ...(upkeep.vault ? { vault: upkeep.vault } : {}),
              browserUsed,
              effectIdOf: turnEndIdOf,
              now: () => new Date(now()),
            }),
          );
        }
      } catch (error) {
        await turnSync.unavailable(sessionId, error);
      } finally {
        invalidateProjectionWrites(botId);
        await computer.close();
      }
    };

    /**
     * `plugin_page_try`: a Plugin's page, tried on this Bot's own Computer in
     * a headless browser beside the platform's stand-in host, before it is
     * published. The runner and the stand-in travel with each try, so they
     * are always this release's; they are not installed on the Computer.
     */
    const pluginPages = config.pluginPages;
    const pageTryTool: ToolDefinition = {
      name: "plugin_page_try",
      namespace: "frockbot",
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
      idempotent: true,
      description:
        'Try one of your Plugin\'s pages on your Computer before you publish it: the page exactly as plugin_publish would store it, in a headless browser, beside a stand-in for the app that greets it with the app\'s theme and your state, answers its tool calls with your toolAnswers, and feeds its microphone whatever tone you say. Steps run in order, each one action: {"click": "<css selector>"}, {"tone": {"frequency": 196, "level": 0.3, "noise": 0.05}}, {"silence": true}, {"hostStop": true} (the person presses the app\'s Stop), {"state": {...}}, {"wait": ms}, {"screenshot": "label"}. You get back the page\'s text, what it reported, any error it threw, which steps failed, and each screenshot. Try every control a person will press, including stopping twice and starting again.',
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "The Plugin's id." },
          surfaceId: {
            type: "string",
            description:
              "Which page, when the Plugin has more than one. Defaults to the first.",
          },
          state: {
            type: "object",
            description:
              "The state the page is handed, as its view would return it.",
          },
          toolAnswers: {
            type: "object",
            description:
              'What each of the Plugin\'s tools answers when the page calls it, by name. Unnamed tools answer "ok".',
          },
          steps: {
            type: "array",
            description: "At most 30 steps, 30 s of waiting and 4 screenshots.",
            items: { type: "object" },
          },
        },
        required: ["pluginId", "steps"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        if (!pluginPages || !writer) {
          return {
            content: "Trying a page needs a Turn with a Computer",
            isError: true,
          };
        }
        const body = record(input) ?? {};
        const pluginId = body.pluginId;
        if (typeof pluginId !== "string" || pluginId.length === 0) {
          return { content: "pluginId is required", isError: true };
        }
        let tried: PluginPageTryRequestV1;
        try {
          tried = decodePluginPageTryRequestV1(body);
        } catch (error) {
          return { content: errorMessage(error), isError: true };
        }
        const page = await pluginPages.pageToTry({
          pluginId,
          ...(typeof body.surfaceId === "string"
            ? { surfaceId: body.surfaceId }
            : {}),
        });
        if ("failure" in page) return { content: page.failure, isError: true };
        const request = {
          width: 390,
          height: 700,
          standIn: PLUGIN_PAGE_STAND_IN_HOST_JS_V1,
          steps: tried.steps,
          config: {
            pluginId: page.pluginId,
            botId: context.botId,
            surfaceId: page.surfaceId,
            microphone: page.microphone,
            themeTokens: PLUGIN_PAGE_TRY_THEME_TOKENS_V1,
            state: tried.state,
            toolAnswers: tried.toolAnswers,
            html: pluginPageForTryV1(page.html),
          },
        };
        try {
          const effectId = await operationIdOf(context);
          return await useComputer(await open(context), async (computer) => {
            const exec = computer.exec;
            const workspace = computer.workspace;
            if (!exec || !workspace) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer cannot run a page",
              );
            }
            const shell = (
              script: string,
              stdin?: Uint8Array,
              env?: Record<string, string>,
            ) =>
              operation(context, () =>
                exec.execute(
                  {
                    executable: "/bin/bash",
                    args: ["-lc", script],
                    ...(stdin ? { stdin } : {}),
                    ...(env ? { env } : {}),
                    timeoutMs: 120_000,
                    maxOutputBytes: 30_000,
                  },
                  { signal: context.signal, effectId },
                ),
              );
            const ran = await shell(
              [
                "set -e",
                'D=$(mktemp -d "${TMPDIR:-/tmp}/page-try.XXXXXX")',
                'printf %s "$FROCKBOT_PAGE_TRY_RUNNER" | base64 -d > "$D/run.mjs"',
                'cat > "$D/request.json"',
                'node "$D/run.mjs" "$D" || { status=$?; rm -rf "$D"; exit $status; }',
                'printf "%s\\n" "$D"',
              ].join("\n"),
              new TextEncoder().encode(JSON.stringify(request)),
              {
                FROCKBOT_PAGE_TRY_RUNNER: base64Of(
                  new TextEncoder().encode(PLUGIN_PAGE_TRY_RUNNER_MJS_V1),
                ),
              },
            );
            const lines = text(ran.stdout).trim().split("\n");
            const directory = lines.at(-1) ?? "";
            if (ran.exitCode !== 0 || !directory.includes("page-try.")) {
              return {
                content: `The page could not be tried: ${
                  text(ran.stderr).trim().slice(-1_500) ||
                  `the runner exited ${ran.exitCode}`
                }`,
                isError: true,
              };
            }
            let result: PluginPageTryResultV1;
            try {
              result = JSON.parse(lines.at(-2) ?? "") as PluginPageTryResultV1;
            } catch {
              return {
                content: "The page ran, but its result could not be read",
                isError: true,
              };
            }
            const attachments: ToolAttachmentV1[] = [];
            const botKey = computerBotPathKeyV1(context.botId);
            const filed: string[] = [];
            for (const shot of result.shots) {
              const read = await shell(`base64 -w0 ${shellQuote(shot.file)}`);
              if (read.exitCode !== 0 || read.outputTruncated) continue;
              let bytes: Uint8Array;
              try {
                bytes = Uint8Array.from(
                  atob(text(read.stdout).trim()),
                  (character) => character.charCodeAt(0),
                );
              } catch {
                continue;
              }
              captureSequence += 1;
              const path = {
                root: screenshotsRoot(),
                path: `${botKey}/${writer.turnId}-page-${captureSequence}.jpg`,
              };
              const written = await workspace.write({
                path,
                bytes,
                writer: {
                  kind: "bot",
                  botId: context.botId,
                  sessionId: writer.sessionId,
                  turnId: writer.turnId,
                  runId: writer.runId,
                },
                expectedGenerationId: null,
                mediaType: "image/jpeg",
              });
              if (written.status !== "ok") continue;
              screenshotFiledThisTurn = true;
              const attachment: ToolAttachmentV1 = {
                kind: "image",
                mediaType: "image/jpeg",
                workspacePath: path,
                contentHash: written.generation.contentHash,
                bytes: written.generation.size,
              };
              runtime.sessions
                .get(context.sessionId)
                ?.offerAttachmentBytes(attachment.contentHash, base64Of(bytes));
              attachments.push(attachment);
              filed.push(shot.label);
            }
            await shell(`rm -rf ${shellQuote(directory)}`).catch(
              () => undefined,
            );
            return {
              content: JSON.stringify({
                page: `${page.pluginId}/${page.surfaceId}`,
                greeted: result.greeted,
                text: result.text,
                reports: result.reports,
                errors: result.errors,
                steps: result.steps,
                screenshots: filed,
                pageSaid: result.said,
              }),
              isError: false,
              ...(attachments.length > 0 ? { attachments } : {}),
            };
          });
        } catch (error) {
          return failure(error);
        }
      },
    };

    const pluginModules = config.pluginModules;
    const moduleTryTool = pluginModules
      ? createPluginModuleTryToolV1(pluginModules, async (context, command) => {
          const effectId = await operationIdOf(context);
          return await useComputer(await open(context), async (computer) => {
            const exec = computer.exec;
            if (!exec) {
              throw new ComputerError(
                "capability-unavailable",
                "The selected Computer cannot run a module",
              );
            }
            return await operation(context, () =>
              exec.execute(
                {
                  executable: "/bin/bash",
                  args: ["-lc", command.script],
                  stdin: command.stdin,
                  env: command.env,
                  timeoutMs: command.timeoutMs,
                  maxOutputBytes: 30_000,
                },
                { signal: context.signal, effectId },
              ),
            );
          });
        })
      : undefined;

    const demonstrations = config.demonstrations;
    return [
      ...(demonstrations
        ? [
            runtime.tools.register(
              createDemonstrationDeleteToolV1(demonstrations),
            ),
          ]
        : []),
      runtime.tools.register(timed(execTool)),
      ...(writer ? [runtime.tools.register(timed(screenshotTool))] : []),
      ...(writer && pluginPages
        ? [runtime.tools.register(timed(pageTryTool))]
        : []),
      ...(moduleTryTool
        ? [
            runtime.tools.register(
              timed({
                ...moduleTryTool,
                execute: (input, context) =>
                  moduleTryTool.execute(input, context).catch(failure),
              }),
            ),
          ]
        : []),
      runtime.tools.register(timed(doctorTool)),
      ...(processes && writer
        ? [
            runtime.tools.register(timed(processCheckTool)),
            runtime.tools.register(timed(processLogsTool)),
            runtime.tools.register(timed(processStopTool)),
          ]
        : []),
      runtime.tools.register(timed(browserTool)),
      ...(config.decideBrowserTask
        ? [runtime.tools.register(timed(browserTaskTool))]
        : []),
      runtime.hooks.add({
        // A Turn's first step is where the Turn's sync state begins; a Turn that
        // never touches the Computer never syncs and never wakes one.
        preStep: async (agent, _inputs, turn, _step, next) => {
          if (turn !== currentTurn) {
            projectionWrites.clear();
            previewOrigins.clear();
            screenshotFiledThisTurn = false;
            browserUsedThisTurn = false;
            owedAskedThisTurn = false;
          }
          currentTurn = turn;
          turnSync.beginTurn(turn);
          if (controlPrompt?.loadedTurn() !== turn) {
            await controlPrompt?.refresh(turn, agent.session);
          }
          return next();
        },
        turnStopping: async (agent, turn) => {
          if (!turnSync.turnUsedTheComputer(turn)) return;
          const timing = new ComputerCallTiming(now);
          try {
            await closeTurn(agent.botId, agent.session.id, turn, timing);
          } finally {
            noteTiming(agent.session.id, turn, timing);
          }
        },
      }),
      runtime.systemPrompt.register({
        id: "persistent-computer",
        order: 80,
        render: () =>
          [
            "## Persistent Computer",
            "You share a persistent Linux Computer with your User's other Bots. You have your own directories and desktop on it; the browser profile is shared.",
            "Use computer_exec to inspect the filesystem before claiming that a path or file exists.",
            "Prefer doing work in the terminal with computer_exec — command-line tools, and Python scripts for longer jobs — over one tool call per step.",
            ...connectedAppsPromptLines(),
            ...(config.decideBrowserTask
              ? [
                  "For anything on a web page that takes several clicks — a form, a setting, a list — use computer_browser_task with the outcome spelled out and the text to type in values. Use computer_browser to read a page or act once.",
                ]
              : []),
            "Use computer_screenshot to see your own desktop; each capture is filed in your durable screenshots root.",
            "For a job that outlasts this Turn, use computer_exec with background:true and check it later with computer_process_check. Do not poll it in a loop.",
            "Use computer_doctor when the Computer misbehaves; it reports disk, desktop, renderer-watchdog actions, top memory consumers, sync, and network in one read-only call.",
            ...(controlPrompt?.current() ? [controlPrompt.current()] : []),
            "Never invent a directory listing.",
          ].join("\n"),
      }),
    ];
  };
}

export default createComputerAgentFeature;
