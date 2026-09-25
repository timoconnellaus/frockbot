import {
  type WorkspaceFilesV1,
  type WorkspaceGenerationsV1,
  type WorkspaceSyncEffectsV1,
} from "@frockbot/core/contracts";
import {
  ComputerError,
  type ComputerAssignment,
  type ComputerIdentityV1,
  type ComputerOperationOptions,
  type ComputerTenantV1,
  type WorkspaceLayoutV1,
  computerIdentityKeyV1,
  computerTenantBotIdV1,
} from "./core.js";

export interface ComputerProvisioningProgressV1 {
  version: 1;
  kind: "provision" | "update";
  label: string;
  index: number;
  total: number;
  resumed: boolean;
}

/** One provider-neutral boundary crossed while opening a live viewer. */
export interface ComputerConnectionProgressV1 {
  version: 1;
  kind: "connect" | "update";
  step: string;
  label: string;
  index: number;
  total: number;
  /** A host provisioning phase advancing within the stable outer step. */
  provisioning?: ComputerProvisioningProgressV1;
}

export interface ComputerConnectionOptionsV1 extends ComputerOperationOptions {
  /**
   * Reports boundaries the provider can observe while the caller's durable
   * connect intent remains in flight. The authoritative caller persists each
   * report; this callback is not itself durable state.
   */
  onProgress?(progress: ComputerConnectionProgressV1): void | Promise<void>;
}

/**
 * The Computer's Workspace surface.
 *
 * It *is* `WorkspaceFilesV1` — the narrow file interface the kernel declares —
 * addressed by `WorkspacePathV1`, so a durable root is named by kind and owner
 * and never by an absolute path on the Computer. `layout` is where mount paths
 * live, and the only place they live.
 *
 * Memory roots are read-only here: `write` and `delete` answer `refused`,
 * because "The Memory Package is the single writer of Memory roots ... the
 * Workspace presents Memory roots read-only through the durable-root sync."
 */
export interface ComputerWorkspace extends WorkspaceFilesV1 {
  readonly layout: WorkspaceLayoutV1;
}

export interface ComputerExecRequest {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ComputerExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  outputTruncated: boolean;
}

export interface ComputerExec {
  execute(
    request: ComputerExecRequest,
    options?: ComputerOperationOptions,
  ): Promise<ComputerExecResult>;
}

export type ComputerBrowserAction =
  | { type: "snapshot" }
  | { type: "navigate"; url: string }
  /** Internal lifecycle action; the model-facing browser tool cannot send it. */
  | { type: "close-origins"; origins: readonly string[] }
  | { type: "click"; role: string; name: string; exact?: boolean }
  | { type: "fill"; label: string; text: string; exact?: boolean }
  /**
   * Internal: the model-facing tool names a saved secret by reference, and
   * the Bot's own authority leases its value for this one action. A host
   * types `value` into the field only while the page's origin is `origin`,
   * carries it apart from the action's own description — never in a command
   * line, a log or an error — and answers with no snapshot, because a
   * snapshot of a filled form is the value.
   */
  | {
      type: "fill-secret";
      label: string;
      exact?: boolean;
      origin: string;
      value: string;
    }
  | { type: "press"; key: string }
  | { type: "wait"; milliseconds: number };

export interface ComputerBrowserState {
  url?: string;
  title?: string;
  accessibilitySnapshot: string;
}

export interface ComputerBrowser {
  perform(
    action: ComputerBrowserAction,
    options?: ComputerOperationOptions,
  ): Promise<ComputerBrowserState>;
}

/** What the Computer says about one background process right now. */
export interface ComputerBackgroundStateV1 {
  /** True while the Computer still holds a live process for the pid. */
  alive: boolean;
  /** The exit code the process recorded, when it recorded one. */
  exitCode?: number;
  /** The bounded head-and-tail of its log. */
  logTail: string;
}

export interface ComputerBackgroundLaunchV1 {
  processId: string;
  command: string;
}

export interface ComputerBackgroundLaunchedV1 {
  pid: number;
  logPath: string;
  /** The Computer's provisioning generation the launch happened under. */
  generation: number;
  cwd: string;
}

/**
 * Processes that outlive the Turn that started them.
 *
 * Deliberately narrow: launch, look, read, end. Nothing here keeps a Computer
 * awake — "The Computer wakes only when a Bot uses it" — so a process whose
 * Computer hibernated is answered `unknown` by the caller that holds its
 * record, never reported as running.
 */
export interface ComputerBackgroundProcessesV1 {
  launch(
    request: ComputerBackgroundLaunchV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerBackgroundLaunchedV1>;
  inspect(
    processId: string,
    options?: ComputerOperationOptions & { tailBytes?: number },
  ): Promise<ComputerBackgroundStateV1>;
  /** Ends the process group: TERM, then KILL after a grace. */
  stop(
    processId: string,
    options?: ComputerOperationOptions,
  ): Promise<ComputerBackgroundStateV1>;
  /** The Computer's provisioning generation, as the host last reported it. */
  generation(options?: ComputerOperationOptions): Promise<number>;
}

/** One capture of the Bot's own desktop on its Computer. */
export interface ComputerScreenshotV1 {
  bytes: Uint8Array;
  mediaType: "image/png";
  /** The X display the capture came from. */
  display: string;
  capturedAt: string;
}

/**
 * Captures the Bot's own desktop. Read-only by declaration: it observes the
 * Computer and changes nothing on it, so it records no durable intent — but it
 * is refused while a human holds the takeover lease, because during a takeover
 * the screen is the human's.
 */
export interface ComputerScreenshotCapabilityV1 {
  capture(options?: ComputerOperationOptions): Promise<ComputerScreenshotV1>;
}

/** One thing box-doctor looked at, and what it saw. */
export interface ComputerDoctorCheckV1 {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

/**
 * What the Computer's browser announces itself as (parity row 34b).
 *
 * Recorded rather than governed: GrokBot pins the User-Agent and rotates
 * per-site fingerprint profiles, and the register declines both. What is kept
 * is the measurement, because "does our browser announce itself as a robot"
 * was an assumption nobody had checked. `brands` is
 * `navigator.userAgentData.brands` rendered `<brand>/<version>`, empty on a
 * browser that does not expose it.
 */
export interface ComputerBrowserIdentityV1 {
  userAgent: string;
  webdriver: boolean;
  brands: string[];
}

/**
 * One run of the Computer's self-check (parity row 27).
 *
 * `generation` is the Computer's provisioning generation as the host reported
 * it, so a report read later says which Computer it describes — a report from
 * before a reprovisioning is history, not a current answer.
 *
 * `browserIdentity` is absent whenever nothing was measured — no browser was
 * running for this tenant, or the one that was did not answer — which is a
 * different fact from a browser that presented no tells, and the two are kept
 * apart rather than collapsed into an empty measurement.
 */
export interface ComputerDoctorReportV1 {
  schemaVersion: 2;
  generation: number;
  capturedAt: string;
  checks: ComputerDoctorCheckV1[];
  browserIdentity?: ComputerBrowserIdentityV1;
  summary: string;
}

/**
 * Decodes one report at the seam it crosses: the Computer's stdout.
 *
 * Exact-field at this live stdout seam. This is not a durable stored record: a
 * report that does not decode is a Computer that answered something else, and
 * the caller says so rather than guessing at half a report.
 */
export function decodeComputerDoctorReportV1(
  value: unknown,
): ComputerDoctorReportV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2) return undefined;
  const { generation, capturedAt, checks, browserIdentity, summary } = record;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation)) {
    return undefined;
  }
  if (typeof capturedAt !== "string" || !capturedAt) return undefined;
  if (typeof summary !== "string" || !summary) return undefined;
  if (!Array.isArray(checks)) return undefined;
  const decoded: ComputerDoctorCheckV1[] = [];
  for (const entry of checks) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const check = entry as Record<string, unknown>;
    if (typeof check.name !== "string" || !check.name) return undefined;
    if (check.status !== "pass" && check.status !== "fail") return undefined;
    if (typeof check.detail !== "string") return undefined;
    decoded.push({
      name: check.name,
      status: check.status,
      detail: check.detail,
    });
  }
  if (decoded.length === 0) return undefined;
  const identity = decodeComputerBrowserIdentityV1(browserIdentity);
  if (identity === "invalid") return undefined;
  return {
    schemaVersion: 2,
    generation,
    capturedAt,
    checks: decoded,
    ...(identity ? { browserIdentity: identity } : {}),
    summary,
  };
}

/**
 * Decodes the browser measurement, or says the report is not one.
 *
 * `null` and an absent field are both "nothing was measured" — the script
 * prints `null` there rather than omitting the key, because a fixed shape is
 * one fewer thing for a shell to get wrong. Anything else that is not this
 * exact shape fails the whole report, like every other field here.
 */
function decodeComputerBrowserIdentityV1(
  value: unknown,
): ComputerBrowserIdentityV1 | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return "invalid";
  const record = value as Record<string, unknown>;
  const { userAgent, webdriver, brands } = record;
  if (typeof userAgent !== "string" || !userAgent) return "invalid";
  if (typeof webdriver !== "boolean") return "invalid";
  if (!Array.isArray(brands)) return "invalid";
  const decoded: string[] = [];
  for (const brand of brands) {
    if (typeof brand !== "string") return "invalid";
    decoded.push(brand);
  }
  return { userAgent, webdriver, brands: decoded };
}

/**
 * Runs the Computer's self-check and answers a report.
 *
 * Read-only by declaration: every check reads and none repairs, so it records
 * no durable intent. Unlike a screenshot it is *not* refused during a human
 * takeover — a Computer a human is holding is exactly a Computer somebody may
 * need to ask what is wrong with.
 */
export interface ComputerDoctorCapabilityV1 {
  run(options?: ComputerOperationOptions): Promise<ComputerDoctorReportV1>;
}

/** The most steps one demonstration keeps; the capture stops at this many. */
export const COMPUTER_DEMONSTRATION_MAX_STEPS_V1 = 200;
/**
 * The screenshots one demonstration hands back. Four, so the log and every
 * one of them fit the five files a single message may carry.
 */
export const COMPUTER_DEMONSTRATION_MAX_SCREENSHOTS_V1 = 4;
/** The largest screenshot a demonstration keeps. */
export const COMPUTER_DEMONSTRATION_SCREENSHOT_MAX_BYTES_V1 = 512 * 1024;
/** The longest a demonstration may run before it stops by itself. */
export const COMPUTER_DEMONSTRATION_MAX_SECONDS_V1 = 600;

const DEMONSTRATION_NAME_MAX = 120;
const DEMONSTRATION_SELECTOR_MAX = 300;
const DEMONSTRATION_URL_MAX = 500;
const DEMONSTRATION_ROLE = /^[a-z][a-z-]{0,39}$/;
const DEMONSTRATION_SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);
const DEMONSTRATION_MODIFIERS = new Set(["Control", "Meta", "Alt", "Shift"]);

/**
 * One thing the person did in the Computer's browser while they held control.
 *
 * What is absent is the point. A step names the field typed into — its role,
 * its label and a selector — and never what was typed: no step has a field
 * that could carry a value, a key step is a special key or a shortcut and
 * never a printable character, and a URL keeps its query's names and drops
 * their values. Password fields leave no step at all.
 */
export type ComputerDemonstrationStepV1 =
  | {
      action: "navigate" | "switch-tab";
      /** Seconds since the demonstration started. */
      t: number;
      /** Which tab, numbered in the order the demonstration first saw it. */
      tab: number;
      url: string;
    }
  | {
      action: "click" | "type" | "choose";
      t: number;
      tab: number;
      /** The element's ARIA role, explicit or implied by its tag. */
      role: string;
      /** Its accessible name, or a field's label. Never a field's contents. */
      name?: string;
      selector: string;
    }
  | { action: "key"; t: number; tab: number; key: string };

export type ComputerDemonstrationStopReasonV1 =
  "stopped" | "control-released" | "time-limit" | "step-limit";

/** A picture of the page after one step, with every form field covered. */
export interface ComputerDemonstrationScreenshotV1 {
  afterStep: number;
  bytes: Uint8Array;
  mediaType: "image/jpeg";
}

/** One demonstration, as the Computer hands it back when it stops. */
export interface ComputerDemonstrationCaptureV1 {
  startedAt: string;
  stoppedAt: string;
  stoppedBecause: ComputerDemonstrationStopReasonV1;
  steps: ComputerDemonstrationStepV1[];
  screenshots: ComputerDemonstrationScreenshotV1[];
  /** Steps the Computer reported that were not a step's shape, left out. */
  dropped: number;
}

/**
 * Records what the person does in the browser while they hold control, so a
 * Bot can learn it (parity row 54).
 *
 * Only the lease holder can start one: `start` is refused unless `ownerId`
 * holds the `desktop-gui` lease, because what is recorded is a human session
 * and nobody else's. A capture stops by itself when that lease is released or
 * lapses, at `seconds`, or at `COMPUTER_DEMONSTRATION_MAX_STEPS_V1`. `stop`
 * ends one that is still running and hands back what was captured, or
 * `undefined` when there is nothing — and removes it from the Computer either
 * way, so a capture is read once.
 */
export interface ComputerDemonstrationCapabilityV1 {
  start(
    request: { ownerId: string; seconds: number },
    options?: ComputerOperationOptions,
  ): Promise<void>;
  stop(
    options?: ComputerOperationOptions,
  ): Promise<ComputerDemonstrationCaptureV1 | undefined>;
}

function demonstrationText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > DEMONSTRATION_NAME_MAX
    ? `${text.slice(0, DEMONSTRATION_NAME_MAX - 1)}…`
    : text;
}

/**
 * A URL as a demonstration keeps it: its query's values are dropped and its
 * names kept, and its fragment and any credentials go. A search form submits
 * what was typed into it as a query value, so a URL kept whole would record
 * exactly what a step never may.
 */
export function demonstrationUrlV1(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `about:blank` is a place; `data:` and `blob:` are contents.
    return url.protocol === "about:" ? `about:${url.pathname}` : undefined;
  }
  const names = [...new Set([...url.searchParams.keys()])];
  const query =
    names.length === 0
      ? ""
      : `?${names.map((name) => `${encodeURIComponent(name)}=…`).join("&")}`;
  const kept = `${url.protocol}//${url.host}${url.pathname}${query}`;
  return kept.length > DEMONSTRATION_URL_MAX
    ? `${kept.slice(0, DEMONSTRATION_URL_MAX - 1)}…`
    : kept;
}

/**
 * A key a demonstration may keep: a special key, or a shortcut held with
 * Control or Meta. A printable character on its own is typing, and is never
 * kept, whatever modifier-free spelling it arrives in.
 */
export function demonstrationKeyV1(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) {
    return undefined;
  }
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (parts.some((part) => !DEMONSTRATION_MODIFIERS.has(part))) {
    return undefined;
  }
  if (new Set(parts).size !== parts.length) return undefined;
  if (DEMONSTRATION_SPECIAL_KEYS.has(key)) return value;
  const shortcut = parts.includes("Control") || parts.includes("Meta");
  return shortcut && /^[a-z0-9]$/.test(key) ? value : undefined;
}

function demonstrationNumber(
  value: unknown,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > maximum) return undefined;
  if (integer) return Number.isSafeInteger(value) ? value : undefined;
  return Math.round(value * 10) / 10;
}

function demonstrationKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/**
 * One step, or `undefined` when the value is not exactly a step.
 *
 * Exact-field and rebuilt field by field, so this is where a capture is
 * held to what it may say: a step carrying anything else — a `value`, the
 * text of a field, a printable key — is not a step, and is left out rather
 * than trimmed into one.
 */
export function decodeComputerDemonstrationStepV1(
  value: unknown,
): ComputerDemonstrationStepV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const step = value as Record<string, unknown>;
  const t = demonstrationNumber(
    step.t,
    COMPUTER_DEMONSTRATION_MAX_SECONDS_V1 * 2,
    false,
  );
  const tab = demonstrationNumber(step.tab, 1_000, true);
  if (t === undefined || tab === undefined || tab < 1) return undefined;
  switch (step.action) {
    case "navigate":
    case "switch-tab": {
      if (!demonstrationKeys(step, ["action", "t", "tab", "url"], [])) {
        return undefined;
      }
      const url = demonstrationUrlV1(step.url);
      return url ? { action: step.action, t, tab, url } : undefined;
    }
    case "click":
    case "type":
    case "choose": {
      if (
        !demonstrationKeys(
          step,
          ["action", "t", "tab", "role", "selector"],
          ["name"],
        )
      ) {
        return undefined;
      }
      if (typeof step.role !== "string" || !DEMONSTRATION_ROLE.test(step.role))
        return undefined;
      if (
        typeof step.selector !== "string" ||
        step.selector.length === 0 ||
        step.selector.length > DEMONSTRATION_SELECTOR_MAX
      ) {
        return undefined;
      }
      const name =
        step.name === undefined ? undefined : demonstrationText(step.name);
      return {
        action: step.action,
        t,
        tab,
        role: step.role,
        ...(name === undefined ? {} : { name }),
        selector: step.selector,
      };
    }
    case "key": {
      if (!demonstrationKeys(step, ["action", "t", "tab", "key"], [])) {
        return undefined;
      }
      const key = demonstrationKeyV1(step.key);
      return key ? { action: "key", t, tab, key } : undefined;
    }
    default:
      return undefined;
  }
}

/** The steps a Computer reported, each held to a step's shape. */
export function decodeComputerDemonstrationStepsV1(value: unknown): {
  steps: ComputerDemonstrationStepV1[];
  dropped: number;
} {
  if (!Array.isArray(value)) return { steps: [], dropped: 0 };
  const steps: ComputerDemonstrationStepV1[] = [];
  let dropped = 0;
  for (const entry of value) {
    if (steps.length >= COMPUTER_DEMONSTRATION_MAX_STEPS_V1) {
      dropped += 1;
      continue;
    }
    const step = decodeComputerDemonstrationStepV1(entry);
    if (step) steps.push(step);
    else dropped += 1;
  }
  return { steps, dropped };
}

/** True for the bytes of a JPEG no larger than a demonstration keeps. */
export function isDemonstrationScreenshotV1(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 3 &&
    bytes.byteLength <= COMPUTER_DEMONSTRATION_SCREENSHOT_MAX_BYTES_V1 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

export function isDemonstrationStopReasonV1(
  value: unknown,
): value is ComputerDemonstrationStopReasonV1 {
  return (
    value === "stopped" ||
    value === "control-released" ||
    value === "time-limit" ||
    value === "step-limit"
  );
}

export interface ComputerViewerSession {
  id: string;
  url: string;
  expiresAt?: string;
  /** Provider progress from the wake that minted this viewer, when there was any. */
  message?: string;
}

export interface ComputerViewer {
  open(options?: ComputerOperationOptions): Promise<ComputerViewerSession>;
  renew(
    sessionId: string,
    options?: ComputerOperationOptions,
  ): Promise<ComputerViewerSession>;
  revoke(sessionId: string, options?: ComputerOperationOptions): Promise<void>;
}

/**
 * Wakes and provisions a Computer, attaches the Bot tenant, and mints the
 * viewer session that proves the connection is usable.
 *
 * This is one provider-neutral effect because some providers perform those
 * operations atomically. The caller records one intent before invoking it;
 * provider-specific viewer transport remains behind the Computer adapter.
 */
export interface ComputerPresence {
  connect(
    options?: ComputerConnectionOptionsV1,
  ): Promise<ComputerViewerSession>;
}

export interface ComputerControlLease {
  id: string;
  expiresAt: string;
}

/**
 * What a control lease covers.
 *
 * `bot` is the legacy lease on one tenant's own desktop slot. `desktop-gui`
 * is User-wide: one Computer serves all of a User's Bots and there is one
 * screen on it, so serializing GUI work means holding the *box*, not a tenant
 * directory. Human takeover and a `computerUse` subagent both hold it, which
 * is why neither can drive the shared screen while the other is active.
 */
export type ComputerControlScopeV1 = "bot" | "desktop-gui";

/**
 * Who and what a lease is taken for. Absent is retained for legacy provider
 * callers; a human session and `computerUse` name `desktop-gui` explicitly.
 */
export interface ComputerControlRequestV1 {
  scope?: ComputerControlScopeV1;
  /**
   * The lease owner the host serializes on. Naming it is what lets a refusal
   * say *which* holder has the desktop, and what lets a lease outlive the
   * process that took it — a Durable Object that is evicted mid-task still
   * releases the lease it recorded, because the owner is in the record.
   */
  ownerId?: string;
}

export interface ComputerControl {
  acquire(
    request?: ComputerControlRequestV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerControlLease>;
  renew(
    lease: ComputerControlLease,
    request?: ComputerControlRequestV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerControlLease>;
  release(
    lease: ComputerControlLease,
    request?: ComputerControlRequestV1,
    options?: ComputerOperationOptions,
  ): Promise<void>;
}

/** Why one run of the durable-root sync happened. */
export type ComputerSyncReasonV1 = "open" | "signal" | "turn-end";

/**
 * What one sync run moved, flattened to counts.
 *
 * The provider-neutral answer is deliberately small: a caller outside the
 * Computer Package decides nothing from a sync report except what to record,
 * and the detailed report (which paths, which conflicting generations) belongs
 * to the provider that produced it and to the durable generation records.
 *
 * There is no failure branch. "Connections to the Computer are expected to
 * drop on every pause; every Computer client reconnects and resumes rather
 * than treating a dropped connection as failure" — so an unreachable Computer
 * answers `unavailable` and a Turn continues.
 */
export interface ComputerSyncSummaryV1 {
  status: "ok" | "degraded" | "unavailable" | "refused" | "skipped";
  /** Human-readable reason, empty when the run had nothing to say. */
  detail: string;
  pulled: number;
  pushed: number;
  restored: number;
  removed: number;
  adopted: number;
  /** Reproducible directories and durable entries excluded by policy. */
  ignored: number;
  /** Manifest entries left out after the scan reached its hard bound. */
  omitted: number;
  conflicts: number;
  failures: number;
}

export function computerSyncSummaryV1(
  status: ComputerSyncSummaryV1["status"],
  detail = "",
): ComputerSyncSummaryV1 {
  return {
    status,
    detail: detail.slice(0, 512),
    pulled: 0,
    pushed: 0,
    restored: 0,
    removed: 0,
    adopted: 0,
    ignored: 0,
    omitted: 0,
    conflicts: 0,
    failures: 0,
  };
}

/**
 * The durable-root sync, as the provider-neutral Computer interface exposes
 * it. "Bots invoke Computers only through the
 * provider-neutral Computer interface", so the Package that gives a Bot its
 * Computer tools reaches the sync here and never through a provider type.
 *
 * A `sync` is present only on a Computer that is already open for a Bot.
 * Reconciling is therefore never a reason to wake a Computer: "The Agent loop,
 * Memory, Skills, Package composition, and Routines function correctly while
 * the Computer is hibernated and do not wake it", and the object-storage side
 * stays authoritative while it sleeps.
 */
export interface ComputerSyncV1 {
  /** Reconciles every declared durable root. Never throws. */
  reconcile(
    reason: ComputerSyncReasonV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerSyncSummaryV1>;
  /**
   * The Computer-side watcher's change signal, or `undefined` when it cannot
   * be read. A caller reconciles again when this changes, rather than scanning
   * every root on every tool call.
   */
  signal(options?: ComputerOperationOptions): Promise<string | undefined>;
}

/**
 * What a host supplies so a Computer Package can build the sync: the
 * object-storage side of the durable roots, and the Durable Object records the
 * push depends on. A provider that receives none simply has no `sync` on its
 * handle, and the Computer's durable roots then live on the Computer alone.
 *
 * Every member is authority the host owns. The Computer Package holds none of
 * it: it drives the reconciliation and records nothing itself.
 */
export interface ComputerSyncHostV1 {
  /** The durable roots in object storage, built with the `sync` surface. */
  store: WorkspaceFilesV1;
  /** Where a push records its intent, in the Bot's Durable Object. */
  effects?: WorkspaceSyncEffectsV1;
  /** The owning object's generation ledger, read to recover a removal writer. */
  generations?: WorkspaceGenerationsV1;
  /**
   * The `package-declared` roots the User's enabled Packages declare, which
   * the Computer Package cannot derive on its own.
   *
   * A Computer Package's layout declares root *kinds* and where each is
   * mounted; only the host knows which Packages this User has installed and
   * which roots their manifests declare. Absent, and the sync reconciles the
   * layout's own kinds and no Package root at all — which is what every host
   * did before this field existed.
   */
  packageRoots?: readonly { packageId: string; rootId: string }[];
  // There is deliberately no writer here. "A file that reaches a durable root
  // without passing through the Workspace file surface (a shell write on the
  // Computer) is mirrored to object storage by the sync with an unattributed
  // writer": one Computer serves all of a User's Bots, so no host can say
  // which Bot's process wrote a file, and a sync that named the Turn's Bot
  // would be recording a guess as provenance.
}

/**
 * What one host is, told to the Bot-side code that has to say it out loud.
 *
 * These are not operations — every operation is a member of the session — but
 * facts a tool has to state and cannot derive: where scratch is on this host,
 * what this host refuses, what its desktop looks like, and which origins its
 * viewer is framed from. They are here so that no neutral file has to import
 * a host's own module to learn them.
 *
 * `desktop` is *descriptive*. It says how many slots the host offers and how
 * big each is; it promises nothing about what is shared between them. Fly's
 * one browser per User follows from Chromium's per-`user-data-dir` singleton
 * lock, and a host that gives each Bot its own container has a different and
 * better isolation story — so nothing may read this field as a statement that
 * Bots share anything.
 */
export interface ComputerHostCapabilitiesV1 {
  /**
   * The absolute path of the shared, non-durable scratch directory, when the
   * host has one. Exported into every shell as `$FROCKBOT_SCRATCH`.
   */
  scratchPath?: string;
  /**
   * The host's refusal for a shell command that would drive the GUI, or
   * `undefined` when the command is allowed. Policy and not a boundary: it is
   * a regex over a shell string, paired on the Computer with a PATH shim that
   * prints the same sentence, and both exist to make the sanctioned surface
   * the easy one.
   */
  refuseGuiCommand?(command: string): string | undefined;
  /** The desktop's shape, when this host has one. Descriptive; see above. */
  desktop?: { slots: number; width: number; height: number };
  /**
   * The origins the live viewer is framed from, for the app's `frame-src`.
   * A CSP entry, so a wildcard host pattern is admitted.
   */
  viewerFrameOrigins: readonly string[];
}

/**
 * One open Computer, addressed by the User whose Computer it is and by the Bot
 * tenant that opened it. The host answers with the tenant's resolved directory
 * and desktop.
 */
export interface ComputerHostSessionV1 {
  assignment: ComputerAssignment;
  identity: ComputerIdentityV1;
  tenant: ComputerTenantV1;
  /** What this session's host is; the host's own declaration. */
  capabilities: ComputerHostCapabilitiesV1;
  workspace?: ComputerWorkspace;
  /** The durable-root sync, when the host supplied its object-storage side. */
  sync?: ComputerSyncV1;
  exec?: ComputerExec;
  browser?: ComputerBrowser;
  screenshot?: ComputerScreenshotCapabilityV1;
  processes?: ComputerBackgroundProcessesV1;
  /** The Computer's self-check, when the provider ships one. */
  doctor?: ComputerDoctorCapabilityV1;
  presence?: ComputerPresence;
  viewer?: ComputerViewer;
  control?: ComputerControl;
  /** Recording what the lease holder does in the browser, where offered. */
  demonstration?: ComputerDemonstrationCapabilityV1;
  close(): Promise<void>;
}

/**
 * The Computer, as everything above it sees one. Fly is one implementation of
 * this and lives entirely in `computer/fly`; a k8s host is another, and is a
 * new file rather than a rewrite.
 */
export interface ComputerHostV1 {
  id: string;
  /**
   * What this host is. Declared here and not only on an open session, because
   * every reader needs it before there is a session: the app builds its
   * `frame-src` from `viewerFrameOrigins` while no Bot is running, and the
   * Computer tools describe and refuse a command without waking a Computer to
   * ask. A session carries this same declaration.
   */
  capabilities: ComputerHostCapabilitiesV1;
  /**
   * The durable roots this host guarantees. Absent when a host declares no
   * durable root.
   */
  workspaceLayout?: WorkspaceLayoutV1;
  /**
   * Provisions the User's Computer when needed and attaches one Bot tenant to
   * it. The split arguments put one Computer per User in a signature:
   * `identity` is the provisioning key, `tenant` is the caller, and a host can
   * finally tell "provision the Computer" from "attach this tenant".
   */
  open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    assignment: ComputerAssignment,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostSessionV1>;
  /**
   * Destroys the User's Computer and everything on it: its files and its
   * browser logins. Idempotent — a Computer already gone is torn down — and
   * the next `open` provisions a new, empty one.
   *
   * Only the User asks for this: "Delete my Computer", and deleting the
   * account. Nothing reaps a Computer on a schedule. Optional because a host
   * may have no way to destroy one; those two surfaces then say so.
   */
  teardown?(identity: ComputerIdentityV1): Promise<void>;
}

function guardedOperation<T>(
  assertCurrent: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    assertCurrent();
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

function guardedFiles(
  files: WorkspaceFilesV1,
  assertCurrent: () => void,
): WorkspaceFilesV1 {
  return {
    read: (path) => guardedOperation(assertCurrent, () => files.read(path)),
    list: (request) =>
      guardedOperation(assertCurrent, () => files.list(request)),
    stat: (path) => guardedOperation(assertCurrent, () => files.stat(path)),
    write: (request) =>
      guardedOperation(assertCurrent, () => files.write(request)),
    delete: (request) =>
      guardedOperation(assertCurrent, () => files.delete(request)),
  };
}

function guardedWorkspace(
  workspace: ComputerWorkspace,
  assertCurrent: () => void,
): ComputerWorkspace {
  return {
    ...guardedFiles(workspace, assertCurrent),
    layout: workspace.layout,
  };
}

function guardedHandle(
  handle: ComputerHostSessionV1,
  assertCurrent: () => void,
): ComputerHostSessionV1 {
  const {
    workspace,
    sync,
    exec,
    browser,
    screenshot,
    processes,
    doctor,
    presence,
    viewer,
    control,
    demonstration,
  } = handle;
  return {
    assignment: handle.assignment,
    identity: handle.identity,
    tenant: handle.tenant,
    capabilities: handle.capabilities,
    workspace: workspace
      ? guardedWorkspace(workspace, assertCurrent)
      : undefined,
    sync: sync
      ? {
          reconcile: (reason, options) =>
            guardedOperation(assertCurrent, () =>
              sync.reconcile(reason, options),
            ),
          signal: (options) =>
            guardedOperation(assertCurrent, () => sync.signal(options)),
        }
      : undefined,
    exec: exec
      ? {
          execute: (request, options) =>
            guardedOperation(assertCurrent, () =>
              exec.execute(request, options),
            ),
        }
      : undefined,
    browser: browser
      ? {
          perform: (action, options) =>
            guardedOperation(assertCurrent, () =>
              browser.perform(action, options),
            ),
        }
      : undefined,
    screenshot: screenshot
      ? {
          capture: (options) =>
            guardedOperation(assertCurrent, () => screenshot.capture(options)),
        }
      : undefined,
    processes: processes
      ? {
          launch: (request, options) =>
            guardedOperation(assertCurrent, () =>
              processes.launch(request, options),
            ),
          inspect: (processId, options) =>
            guardedOperation(assertCurrent, () =>
              processes.inspect(processId, options),
            ),
          stop: (processId, options) =>
            guardedOperation(assertCurrent, () =>
              processes.stop(processId, options),
            ),
          generation: (options) =>
            guardedOperation(assertCurrent, () =>
              processes.generation(options),
            ),
        }
      : undefined,
    doctor: doctor
      ? {
          run: (options) =>
            guardedOperation(assertCurrent, () => doctor.run(options)),
        }
      : undefined,
    presence: presence
      ? {
          connect: (options) =>
            guardedOperation(assertCurrent, () => presence.connect(options)),
        }
      : undefined,
    viewer: viewer
      ? {
          open: (options) =>
            guardedOperation(assertCurrent, () => viewer.open(options)),
          renew: (sessionId, options) =>
            guardedOperation(assertCurrent, () =>
              viewer.renew(sessionId, options),
            ),
          revoke: (sessionId, options) =>
            guardedOperation(assertCurrent, () =>
              viewer.revoke(sessionId, options),
            ),
        }
      : undefined,
    control: control
      ? {
          acquire: (request, options) =>
            guardedOperation(assertCurrent, () =>
              control.acquire(request, options),
            ),
          renew: (lease, request, options) =>
            guardedOperation(assertCurrent, () =>
              control.renew(lease, request, options),
            ),
          release: (lease, request, options) =>
            guardedOperation(assertCurrent, () =>
              control.release(lease, request, options),
            ),
        }
      : undefined,
    demonstration: demonstration
      ? {
          start: (request, options) =>
            guardedOperation(assertCurrent, () =>
              demonstration.start(request, options),
            ),
          stop: (options) =>
            guardedOperation(assertCurrent, () => demonstration.stop(options)),
        }
      : undefined,
    close: () => handle.close(),
  };
}

/**
 * The Computer assignments of the resident application, keyed per User.
 *
 * "The User's Durable Object is the authority for everything User-scoped:
 * ... the Computer assignment" — so the assignment map is keyed by
 * `ComputerIdentityV1` alone. Two Bots of one User share one assignment, one
 * generation, and one provider Computer; each is a tenant on it.
 */
export class ComputerRegistry {
  private readonly providers = new Map<string, ComputerHostV1>();
  private readonly assignments = new Map<string, ComputerAssignment>();

  register(provider: ComputerHostV1): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error("Computer provider id must be non-empty");
    if (this.providers.has(id)) {
      throw new Error(`Computer provider "${id}" is already registered`);
    }
    this.providers.set(id, provider);
    return () => {
      if (this.providers.get(id) === provider) this.providers.delete(id);
    };
  }

  /**
   * What one registered host is, for a caller that has no session and must
   * not open one to find out.
   */
  capabilities(hostId: string): ComputerHostCapabilitiesV1 | undefined {
    return this.providers.get(hostId.trim())?.capabilities;
  }

  assign(
    identity: ComputerIdentityV1,
    providerId: string,
    configuration?: unknown,
  ): ComputerAssignment {
    const key = computerIdentityKeyV1(identity);
    const normalizedProviderId = providerId.trim();
    if (!this.providers.has(normalizedProviderId)) {
      throw new ComputerError(
        "provider-unavailable",
        `Computer provider "${normalizedProviderId}" is unavailable`,
      );
    }
    const previous = this.assignments.get(key);
    const assignment = {
      providerId: normalizedProviderId,
      generation: (previous?.generation ?? 0) + 1,
      configuration,
    } satisfies ComputerAssignment;
    this.assignments.set(key, assignment);
    return assignment;
  }

  assignment(identity: ComputerIdentityV1): ComputerAssignment | undefined {
    return this.assignments.get(computerIdentityKeyV1(identity));
  }

  async open(
    identity: ComputerIdentityV1,
    tenant: ComputerTenantV1,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostSessionV1> {
    options?.signal?.throwIfAborted();
    const key = computerIdentityKeyV1(identity);
    computerTenantBotIdV1(tenant);
    const assignment = this.assignments.get(key);
    if (!assignment) {
      throw new ComputerError(
        "not-assigned",
        `User "${identity.userId}" has no Computer assignment`,
      );
    }
    const provider = this.providers.get(assignment.providerId);
    if (!provider) {
      throw new ComputerError(
        "provider-unavailable",
        `Computer provider "${assignment.providerId}" is unavailable`,
        true,
      );
    }
    const handle = await provider.open(identity, tenant, assignment, options);
    return guardedHandle(handle, () => {
      const current = this.assignments.get(key);
      if (
        current?.providerId !== assignment.providerId ||
        current.generation !== assignment.generation
      ) {
        throw new ComputerError(
          "stale-assignment",
          `Computer assignment for User "${identity.userId}" changed`,
        );
      }
    });
  }
}
