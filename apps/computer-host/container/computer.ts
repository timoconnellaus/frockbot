/**
 * The shared Computer host, as it runs inside the Cloudflare Container.
 *
 * ADR 0004: "The container resolves credentials server-side, holds no
 * canonical Bot state, and treats process loss or restart as normal." That is
 * the whole design of this module. It owns exactly two pieces of in-memory
 * state — the effects currently in flight, so a cancel can reach them, and a
 * cache of what it has already learned about a Computer — and both are
 * derivable again from the Sprite. Nothing here is authority.
 *
 * Two rules are load-bearing and are why this file exists at all:
 *
 * 1. **Nothing large travels on a command's argv or environment.** The Sprites
 *    SDK puts both the argv and the env of a `spawn` into the WebSocket URL's
 *    query string (`@fly/sprites@0.1.0` `dist/exec.js`, `buildWebSocketURL`),
 *    and Fly answers a ~2.5 KB query with HTTP 431 — the failure measured
 *    against a real Sprite and recorded in ADR 0004. So every command is
 *    `bash -s` with a two-element argv, the script arrives on **stdin**, and a
 *    requested `cwd` and `env` are compiled into that script as `cd` and
 *    `export` lines rather than handed to the SDK.
 * 2. **File bytes never go through a shell.** They use the Sprites filesystem
 *    API, which is a plain HTTP body and has no such limit.
 */

import {
  BOTS_ROOT,
  BROWSER_LIVE_MARKER,
  BROWSER_SERVICE,
  computerSpriteNameV1,
  computerSpriteNameSourceV1,
  COMPUTER_CDP_PORT,
  COMPUTER_DISPLAY,
  CONTROL_SCRIPT,
  DATA_ROOT,
  DESKTOP_GUI_LEASE_KEY,
  DESKTOP_LIVE_MARKER,
  DESKTOP_SERVICE,
  DESKTOP_SLOT_PREFIX,
  DESKTOP_SLOTS,
  DESKTOP_TENANT_SERVICE_PREFIX,
  ENSURE_AGENT_SCRIPT,
  ENSURE_WINDOW_SCRIPT,
  FOCUS_WINDOW_SCRIPT,
  HOME_ROOT,
  LEASE_MAX_AGE_SECONDS,
  NO_SLOTS_MARKER,
  PROVISION_DIGEST,
  PROVISION_MARKERS,
  PROVISION_PHASES,
  PROVISION_RUNNER_PREFIX,
  PROVISION_STARTING_PHASE,
  provisionLaunchScript,
  provisionLogTailScript,
  provisionPollScript,
  RUNTIME_ROOT,
  runtimeDocumentDigestV1,
  SCREEN_SERVICE,
  shellQuote,
  TARGET_ID_FILE,
  UPDATE_PHASES,
  UPDATE_STARTING_PHASE,
  updateLaunchScript,
  VIEW_TENANT_SERVICE_PREFIX,
  viewServiceNameV1,
  VNC_PORT_BASE,
  VIEWER_PAGE,
  WATCHDOG_SCRIPT,
  WATCHDOG_SERVICE,
  WINDOW_LIVE_MARKER,
  WORKSPACE_SYNC_SERVICE,
  WORKSPACES_ROOT,
} from "@frockbot/computer-host-runtime";
import {
  COMPUTER_HOST_STREAM_MEDIA_TYPE,
  computerHostProblemV1,
  encodeComputerHostExecFrameV1,
  encodeComputerHostOpenFrameV1,
  problem,
  type ComputerHostControlResultV1,
  type ComputerHostErrorCodeV1,
  type ComputerHostExecOperationV1,
  type ComputerHostExecResultV1,
  type ComputerHostFileEntryV1,
  type ComputerHostFileKindV1,
  type ComputerHostOpenOperationV1,
  type ComputerHostOpenResultV1,
  type ComputerHostProvisioningV1,
  type ComputerHostRequestV1,
} from "@frockbot/computer-host-protocol";

// --- the narrow view this module takes of the Sprites SDK ------------------

export interface SpriteStreamHandle {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end", listener: () => void): unknown;
}

export interface SpriteCommandHandle {
  readonly stdin: {
    write(chunk: string | Buffer): unknown;
    end(chunk?: string | Buffer): unknown;
  };
  readonly stdout: SpriteStreamHandle;
  readonly stderr: SpriteStreamHandle;
  once(
    event: "spawn" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  /**
   * A listener that stays attached. `error` needs one, because the SDK can
   * emit it more than once for one command and an EventEmitter with no
   * `error` listener throws out of the event loop.
   */
  on(event: "error", listener: (...args: unknown[]) => void): unknown;
  wait(): Promise<number>;
  kill(signal?: string): void;
}

export interface SpriteStatsHandle {
  size: number;
  mode: number;
  mtime: Date;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SpriteDirentHandle {
  name: string;
  parentPath: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface SpriteFilesystemHandle {
  readFile(path: string, encoding: null): Promise<Buffer>;
  writeFile(
    path: string,
    data: Buffer | string,
    options?: { mode?: number },
  ): Promise<void>;
  readdir(
    path: string,
    options: { withFileTypes: true; recursive?: boolean },
  ): Promise<SpriteDirentHandle[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  stat(path: string): Promise<SpriteStatsHandle>;
}

export interface SpriteServiceStreamHandle extends AsyncIterable<unknown> {}

export interface SpriteHandle {
  readonly name: string;
  readonly url?: string;
  /**
   * How the platform gates the Sprite's public hostname.
   *
   * The viewer is an anonymous `<iframe>` on that hostname, so anything but
   * `public` redirects the frame to the Sprites sign-in page — which the app's
   * `frame-src https://*.sprites.app` refuses to load. Reading the setting is
   * what lets the host re-assert it without paying a write on every open.
   */
  readonly urlSettings?: { auth?: string };
  spawn(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): SpriteCommandHandle;
  filesystem(workingDir?: string): SpriteFilesystemHandle;
  createService(
    name: string,
    config: { cmd: string; args?: string[]; httpPort?: number },
    duration?: string,
  ): Promise<SpriteServiceStreamHandle>;
  startService(
    name: string,
    duration?: string,
  ): Promise<SpriteServiceStreamHandle>;
  /**
   * Restarts a declared service, which is the *only* way to make one pick up a
   * rewritten launcher.
   *
   * `createService` is a create-or-update keyed by the definition: declaring a
   * service again with a byte-identical `{cmd, args, httpPort}` is a no-op, so
   * the running process keeps every path it was started with. That is how a
   * Computer went on serving noVNC's own page from `/usr/share/novnc` for days
   * after the runtime update had rewritten `start-gateway.sh` to serve
   * FrockBot's viewer.
   */
  restartService(
    name: string,
    duration?: string,
  ): Promise<SpriteServiceStreamHandle>;
  stopService(
    name: string,
    timeout?: string,
  ): Promise<SpriteServiceStreamHandle>;
  deleteService(name: string): Promise<void>;
  listServices(): Promise<{ name: string }[]>;
  updateURLSettings(settings: { auth: string }): Promise<void>;
}

export interface SpritesClientHandle {
  getSprite(name: string): Promise<SpriteHandle>;
  createSprite(name: string): Promise<SpriteHandle>;
  deleteSprite(name: string): Promise<void>;
  listAllSprites(prefix?: string): Promise<{ name: string }[]>;
}

// --- declared policy -------------------------------------------------------

/** Bounded load shedding. Exceeding either answers 429, never a queue. */
export const COMPUTER_HOST_CONCURRENCY = {
  /** In-flight effects one container will hold at once. */
  perContainer: 32,
  /** In-flight effects one User's Computer will hold at once. */
  perUser: 4,
} as const;

/** Machine-only prefixes in the one viewer-material exec response. */
export const VIEWER_TOKEN_PREFIX = "__FROCKBOT_VIEWER_TOKEN__";
export const VIEWER_PASSWORD_PREFIX = "__FROCKBOT_VIEWER_PASSWORD__";
const VIEWER_MISSING_MARKER = "__FROCKBOT_VIEWER_MISSING__";

export const COMPUTER_HOST_PHASE_TIMEOUTS = {
  /** The whole provisioning run, however many phases and restarts it takes. */
  provision: 10 * 60_000,
  /** One short exec that launches or polls the detached provisioner. */
  provisionStep: 60_000,
  /** Gap between two polls. Far inside the SDK's 45-second pong window. */
  provisionPoll: 3_000,
  service: 120_000,
  ensureAgent: 60_000,
  control: 15_000,
  file: 60_000,
  /** Grace between SIGTERM and SIGKILL, for a timeout or a cancel. */
  termination: 5_000,
  /** How long the last bytes of output may lag the exit code. */
  drain: 1_000,
} as const;

/** A second caller waits this long for an in-place update before retrying. */
export const COMPUTER_UPDATE_WAIT_MS =
  COMPUTER_HOST_PHASE_TIMEOUTS.provisionStep;

/**
 * Where the host records that it has provisioned a Computer.
 *
 * This is the file that makes container restart a non-event. The container
 * holds no canonical state, so on a cold start it does not know whether a
 * User's Sprite has ever been provisioned — it reads this, and a Sprite that
 * has one is adopted rather than reprovisioned. It is derived state living
 * beside the runtime it describes, not authority: losing it costs one extra
 * provisioning run and nothing else.
 */
export const COMPUTER_HOST_STATE_PATH = `${RUNTIME_ROOT}/host-state.json`;

const ADOPTION_STATE_PREFIX = "frockbot-adoption-state:";
const ADOPTION_DIGEST_PREFIX = "frockbot-adoption-digest:";
const ADOPTION_HUMAN_PREFIX = "frockbot-adoption-human:";

/**
 * One adoption read: host record, installed digest, and every human lease.
 * The lease scan uses the same mtime rule as the runtime reclaim path, so an
 * update cannot disagree with the Computer about whether a human is present.
 */
const adoptionInspectionScript = `set -eu
printf '${ADOPTION_STATE_PREFIX}'
base64 -w0 ${COMPUTER_HOST_STATE_PATH} 2>/dev/null || true
printf '\n${ADOPTION_DIGEST_PREFIX}'
cat ${PROVISION_DIGEST} 2>/dev/null || true
printf '\n${ADOPTION_HUMAN_PREFIX}'
NOW=$(date +%s)
FRESH=0
for LEASE in ${BOTS_ROOT}/*/human-control; do
  [ -f "$LEASE" ] || continue
  LEASED=$(stat -c %Y "$LEASE")
  if [ $((NOW - LEASED)) -le ${LEASE_MAX_AGE_SECONDS} ]; then FRESH=1; break; fi
done
printf '%s\n' "$FRESH"
`;

const CONTROL_LEASE_SECONDS = 90;

/**
 * How many consecutive polls may find nothing holding the run lock before the
 * host concludes the provisioner is gone.
 *
 * More than one, because a launch is asynchronous and a phase's last child can
 * outlive the shell that spawned it; the lock is genuinely free for a moment
 * either side of a phase.
 */
const PROVISION_STOPPED_POLLS = 3;

/**
 * How many times one `open` will restart a provisioner that has gone away.
 *
 * Generous, because a restart is cheap and safe: every phase is marker-guarded,
 * so a relaunch resumes the install rather than repeating it, and the ten
 * minute deadline is what actually bounds the run. Measured against a real
 * Sprite, the desktop install is heavy enough that the machine drops
 * connections and loses its provisioner more than once or twice.
 */
const PROVISION_RELAUNCHES = 8;

/**
 * How long a Computer may fail to answer a poll before the run gives up.
 *
 * "Connections to the Computer are expected to drop on every pause; every
 * Computer client reconnects and resumes rather than treating a dropped
 * connection as failure." A count of failures would be exactly that mistake —
 * a Sprite under an `apt-get` refuses several in a row — so the question is
 * how long it has been silent, not how many times.
 */
const PROVISION_UNREACHABLE_MS = 120_000;

export class ComputerHostError extends Error {
  // Plain fields rather than parameter properties: Node strips types in the
  // container and transforms nothing.
  readonly code: ComputerHostErrorCodeV1;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: ComputerHostErrorCodeV1,
    message: string,
    status: number,
    retryable = false,
  ) {
    super(message);
    this.name = "ComputerHostError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

function decodeComputerHostStateV1(input: unknown): ComputerHostStateV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Computer host state is not an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "generation,version" && keys !== "generation,update,version") {
    throw new Error("Computer host state has unknown fields");
  }
  if (value.version !== 1 || !Number.isSafeInteger(value.generation)) {
    throw new Error("Computer host state is invalid");
  }
  if (value.update === undefined) {
    return { version: 1, generation: value.generation as number };
  }
  if (
    typeof value.update !== "object" ||
    value.update === null ||
    Array.isArray(value.update)
  ) {
    throw new Error("Computer host update state is invalid");
  }
  const update = value.update as Record<string, unknown>;
  if (Object.keys(update).sort().join(",") !== "digest,recordedAt,status") {
    throw new Error("Computer host update state has unknown fields");
  }
  if (
    (update.status !== "pending" && update.status !== "started") ||
    typeof update.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(update.digest) ||
    typeof update.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(update.recordedAt))
  ) {
    throw new Error("Computer host update state is invalid");
  }
  return {
    version: 1,
    generation: value.generation as number,
    update: {
      status: update.status,
      digest: update.digest,
      recordedAt: update.recordedAt,
    },
  };
}

/**
 * Compiles one exec request into a single bash document.
 *
 * `cwd` and `env` become `cd` and `export` lines rather than SDK options
 * because the SDK puts both into the WebSocket URL, where they meet the same
 * 431 that killed argv delivery. Everything the command needs is therefore in
 * the one place with no size limit: its stdin.
 */
export function computerHostExecScriptV1(
  operation: ComputerHostExecOperationV1,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(operation.env ?? {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  if (operation.cwd) lines.push(`cd ${shellQuote(operation.cwd)}`);
  lines.push(operation.script);
  return `${lines.join("\n")}\n`;
}

/**
 * One provisioning report, as the launcher and the poll script print it.
 *
 * `running` is the lock, not the state file: a state line says which phase a
 * run reached, and only the lock says whether anything is still working on it.
 * A report with neither — a Sprite where provisioning has never been asked for
 * — reads as the starting phase, which is what it is.
 */
export interface ProvisionObservation extends ComputerHostProvisioningV1 {
  /** Whether a provisioner still holds the run lock. */
  running: boolean;
  /** Target digest carried only in the provisioner's internal state line. */
  documentDigest?: string;
}

/** Decodes a provisioning report. Anything unreadable reads as "starting". */
export function readProvisionObservation(
  text: string,
  fallbackKind: ComputerHostProvisioningV1["kind"] = "provision",
): ProvisionObservation {
  const running = text.includes(`${PROVISION_RUNNER_PREFIX}running`);
  const starting =
    fallbackKind === "update"
      ? UPDATE_STARTING_PHASE
      : PROVISION_STARTING_PHASE;
  const phases = fallbackKind === "update" ? UPDATE_PHASES : PROVISION_PHASES;
  const base: ProvisionObservation = {
    kind: fallbackKind,
    phase: starting.name,
    label: starting.label,
    index: 0,
    total: phases.length,
    status: "running",
    resumed: false,
    running,
  };
  const line = text
    .split("\n")
    .reverse()
    .find((candidate) => candidate.trimStart().startsWith("{"));
  if (!line) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return base;
  }
  if (typeof parsed !== "object" || parsed === null) return base;
  const value = parsed as Record<string, unknown>;
  const status =
    value.status === "complete" || value.status === "failed"
      ? value.status
      : "running";
  return {
    kind:
      value.kind === "provision" || value.kind === "update"
        ? value.kind
        : base.kind,
    phase: typeof value.phase === "string" ? value.phase : base.phase,
    label: typeof value.label === "string" ? value.label : base.label,
    index: Number.isSafeInteger(value.index)
      ? (value.index as number)
      : base.index,
    total: Number.isSafeInteger(value.total)
      ? (value.total as number)
      : base.total,
    status,
    resumed: false,
    running,
    ...(typeof value.documentDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.documentDigest)
      ? { documentDigest: value.documentDigest }
      : {}),
  };
}

/** Collects a command's output, stopping at the caller's declared ceiling. */
class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** The bytes actually retained from this chunk, for a streaming caller. */
  push(chunk: Buffer): Buffer {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return Buffer.alloc(0);
    }
    const kept =
      chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    if (kept.byteLength < chunk.byteLength) this.truncated = true;
    this.chunks.push(kept);
    this.size += kept.byteLength;
    return kept;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bufferOf(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function withTimeout<T>(
  operation: Promise<T>,
  phase: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ComputerHostError(
            "timeout",
            `Computer ${phase} timed out after ${timeoutMs}ms`,
            504,
            true,
          ),
        ),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settleService(
  stream: SpriteServiceStreamHandle,
  label: string,
): Promise<void> {
  for await (const event of stream) {
    if (typeof event !== "object" || event === null) continue;
    const value = event as {
      type?: unknown;
      data?: unknown;
      exitCode?: unknown;
    };
    if (value.type === "error") {
      throw new ComputerHostError(
        "provider-failure",
        `${label} failed: ${String(value.data ?? "unknown error")}`,
        502,
        true,
      );
    }
    if (
      value.type === "exit" &&
      typeof value.exitCode === "number" &&
      value.exitCode !== 0
    ) {
      throw new ComputerHostError(
        "provider-failure",
        `${label} exited with ${value.exitCode}`,
        502,
        true,
      );
    }
  }
}

export interface ComputerHostExecOutcome {
  exitCode: number | null;
  signal?: string;
  stdout: Buffer;
  stderr: Buffer;
  outputTruncated: boolean;
}

interface ExecStreamSink {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
}

/**
 * One admitted effect, from admission until it truly ends.
 *
 * `cancel` starts as a latch rather than a kill, because a cancel can arrive
 * before the command has been spawned — a streaming exec answers its caller
 * with a `Response` the moment the stream opens, so the window between
 * admission and the running command is reachable. `pending` is that latch:
 * `spawn` reads it and terminates immediately rather than starting work
 * somebody has already withdrawn.
 */
interface InFlightEffect {
  userId: string;
  cancel: (reason: "cancelled" | "timeout") => void;
  pending?: "cancelled" | "timeout";
}

interface ComputerRecord {
  spriteName: string;
  generation: number;
  provisioning?: ComputerHostProvisioningV1;
  inspection?: AdoptionInspection;
}

interface ComputerHostStateV1 {
  version: 1;
  generation: number;
  update?: {
    // `pending` is no longer written: an update under a human-control lease
    // now installs its files and records `started`, deferring only the
    // gateway re-declaration. It stays decodable because Computers provisioned
    // before that change still carry it, and their next open reconciles it.
    status: "pending" | "started";
    digest: string;
    recordedAt: string;
  };
}

interface AdoptionInspection {
  state?: ComputerHostStateV1;
  digest?: string;
  humanControlFresh: boolean;
}

interface ActiveUpdate {
  progress: ComputerHostProvisioningV1;
  promise: Promise<ComputerRecord>;
}

export interface ComputerHostOptions {
  client: SpritesClientHandle;
  /** Base name every Computer's Sprite derives from. */
  baseSpriteName: string;
  /** sha-256 of a string as lowercase hex. Node and workerd differ; this does not. */
  digest: (value: string) => string;
  now?: () => number;
  concurrency?: { perContainer: number; perUser: number };
  /** How often the host asks a detached provisioner how it is going. */
  provisionPollMs?: number;
  /** Bounded wait for a caller that did not start the active update. */
  updateWaitMs?: number;
  /**
   * Told every time a provisioning run reaches a new phase.
   *
   * A streamed `open` carries the same phases to its caller. This observer is
   * still useful independently: the process log tells an operator whether an
   * install is slow or broken even when no caller remains attached.
   */
  onProvisionProgress?: (
    spriteName: string,
    progress: ComputerHostProvisioningV1,
  ) => void;
  /**
   * Told when a provisioning run rides out a drop or restarts a provisioner.
   *
   * These are expected events, not failures — a Computer under an `apt-get`
   * refuses connections — but they are the difference between "slow" and
   * "wrong" when a cold open takes minutes.
   */
  onProvisionRetry?: (spriteName: string, reason: string) => void;
}

/**
 * The whole protocol, over one Sprites client.
 *
 * Every method takes a decoded `ComputerHostRequestV1` and answers a
 * `Response`, so the Node HTTP server around it holds no protocol knowledge
 * and the tests drive the real thing with a fake client.
 */
export class ComputerHost {
  private readonly client: SpritesClientHandle;
  private readonly baseSpriteName: string;
  private readonly digest: (value: string) => string;
  private readonly now: () => number;
  private readonly concurrency: { perContainer: number; perUser: number };
  private readonly provisionPollMs: number;
  private readonly updateWaitMs: number;
  private readonly onProvisionProgress?: (
    spriteName: string,
    progress: ComputerHostProvisioningV1,
  ) => void;
  private readonly onProvisionRetry?: (
    spriteName: string,
    reason: string,
  ) => void;
  private readonly inFlight = new Map<string, InFlightEffect>();
  /** Re-derivable cache of what this container has learned about a Computer. */
  private readonly computers = new Map<string, ComputerRecord>();
  private readonly openings = new Map<string, Promise<ComputerRecord>>();
  /** One update per User; every other operation waits only its declared bound. */
  private readonly updates = new Map<string, ActiveUpdate>();
  /**
   * Sprites whose superseded per-slot desktop services this container has
   * already retired (ADR 0031). The migration is idempotent, so this is a cost
   * saving rather than a correctness one: one `listServices` per Sprite per
   * container instead of one per open.
   */
  private readonly retired = new Set<string>();
  /**
   * The Sprite handle for a name, looked up once.
   *
   * Every operation used to open with its own `GET /v1/sprites/<name>`, and a
   * single Turn makes a dozen operations — measured at 14 lookups costing
   * ~1.35s of a 11.7s tool call, for an answer that cannot have changed. A
   * handle is a name bound to a client: the SDK builds every exec URL from
   * `client.baseURL` and `sprite.name`, so the second lookup returns what the
   * first did.
   *
   * The handle also carries the Sprite's public URL. A malformed legacy
   * handle without one is the viewer's only fallback lookup; the normal path
   * does not fetch the same Sprite again.
   */
  private readonly spriteHandles = new Map<string, Promise<SpriteHandle>>();

  constructor(options: ComputerHostOptions) {
    this.client = options.client;
    this.baseSpriteName = options.baseSpriteName;
    this.digest = options.digest;
    this.now = options.now ?? (() => Date.now());
    this.concurrency = options.concurrency ?? COMPUTER_HOST_CONCURRENCY;
    this.provisionPollMs =
      options.provisionPollMs ?? COMPUTER_HOST_PHASE_TIMEOUTS.provisionPoll;
    this.updateWaitMs = options.updateWaitMs ?? COMPUTER_UPDATE_WAIT_MS;
    if (options.onProvisionProgress) {
      this.onProvisionProgress = options.onProvisionProgress;
    }
    if (options.onProvisionRetry) {
      this.onProvisionRetry = options.onProvisionRetry;
    }
  }

  /** The Sprite backing this User's Computer. One per User (ADR 0012). */
  spriteNameFor(userId: string): string {
    return computerSpriteNameV1(
      userId,
      this.digest(computerSpriteNameSourceV1(userId)),
      this.baseSpriteName,
    );
  }

  /** In-flight effects, for the container's own health reporting. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async handle(
    request: ComputerHostRequestV1,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (request.operation.kind === "cancel") {
      const held = this.inFlight.get(request.effectId);
      held?.cancel("cancelled");
      return Response.json({
        version: 1,
        effectId: request.effectId,
        cancelled: Boolean(held),
      });
    }
    const admitted = this.admit(request);
    if (!admitted.ok) return admitted.response;
    // A streaming operation has not finished when it answers: its `Response`
    // is an open stream. It therefore takes ownership of the release, or a
    // cancel arriving mid-stream would find nothing to cancel.
    const streaming =
      (request.operation.kind === "exec" && request.operation.stream) ||
      (request.operation.kind === "open" && request.operation.stream === true);
    try {
      const response = await this.dispatch(request, signal, admitted.release);
      if (!streaming) admitted.release();
      return response;
    } catch (error) {
      admitted.release();
      return this.refuse(error);
    }
  }

  /**
   * Bounded load shedding, before anything reaches the Sprite. "an operation
   * exceeding a durable per-User quota is refused and records a visible
   * failure" — the durable half is the Bot Durable Object's; this is the
   * container's own ceiling, and it answers 429 rather than queueing, so the
   * caller's retry is its own decision.
   */
  private admit(
    request: ComputerHostRequestV1,
  ): { ok: true; release: () => void } | { ok: false; response: Response } {
    if (this.inFlight.size >= this.concurrency.perContainer) {
      return {
        ok: false,
        response: problem(
          429,
          "limit-exceeded",
          `Computer host is holding ${this.inFlight.size} effects`,
          true,
        ),
      };
    }
    const { userId } = request.identity;
    let held = 0;
    for (const effect of this.inFlight.values()) {
      if (effect.userId === userId) held += 1;
    }
    if (held >= this.concurrency.perUser) {
      return {
        ok: false,
        response: problem(
          429,
          "limit-exceeded",
          `This Computer is already running ${held} effects`,
          true,
        ),
      };
    }
    const effect: InFlightEffect = {
      userId,
      cancel: (reason) => {
        effect.pending = reason;
      },
    };
    this.inFlight.set(request.effectId, effect);
    return {
      ok: true,
      release: () => {
        this.inFlight.delete(request.effectId);
      },
    };
  }

  private refuse(error: unknown): Response {
    if (error instanceof ComputerHostError) {
      return problem(error.status, error.code, error.message, error.retryable);
    }
    if (isNotFound(error)) {
      return problem(404, "not-found", errorText(error));
    }
    return problem(502, "provider-failure", errorText(error), true);
  }

  private dispatch(
    request: ComputerHostRequestV1,
    signal: AbortSignal | undefined,
    release: () => void,
  ): Promise<Response> {
    switch (request.operation.kind) {
      case "open":
        return this.open(request, request.operation, release);
      case "exec":
        return this.exec(request, request.operation, signal, release);
      case "file/read":
      case "file/write":
      case "file/list":
      case "file/stat":
      case "file/delete":
        return this.file(request);
      case "control":
        return this.control(request);
      case "viewer":
        return this.viewer(request);
      case "service":
        return this.service(request);
      case "cancel":
        throw new ComputerHostError(
          "invalid-request",
          "cancel is handled before admission",
          400,
        );
    }
  }

  // --- opening -------------------------------------------------------------

  /**
   * Provisions the User's Computer when needed and attaches one Bot tenant.
   *
   * A container restart loses `this.computers`, so this reads the Computer's
   * own state file first: a Sprite that has been provisioned is adopted, and
   * only a Sprite with no state file is provisioned again. That is
   * reconstruction, not retry — no effect is repeated.
   */
  private async open(
    request: ComputerHostRequestV1,
    operation: ComputerHostOpenOperationV1,
    release: () => void,
  ): Promise<Response> {
    if (!operation.stream) {
      return Response.json(await this.openResult(request));
    }

    const encoder = new TextEncoder();
    const host = this;
    let writable = true;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (
          frame: Parameters<typeof encodeComputerHostOpenFrameV1>[0],
        ): void => {
          if (!writable) return;
          try {
            controller.enqueue(
              encoder.encode(encodeComputerHostOpenFrameV1(frame)),
            );
          } catch {
            // The caller detached. Progress is an observer, not authority;
            // provisioning continues to its terminal state.
            writable = false;
          }
        };
        try {
          const result = await host.openResult(request, (progress) => {
            write({ type: "progress", progress });
          });
          write({ type: "result", result });
        } catch (error) {
          const failure =
            error instanceof ComputerHostError
              ? computerHostProblemV1(
                  error.code,
                  error.message,
                  error.retryable,
                )
              : computerHostProblemV1(
                  "provider-failure",
                  errorText(error),
                  true,
                );
          write({
            type: "error",
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          });
        } finally {
          release();
          if (writable) controller.close();
        }
      },
      cancel() {
        writable = false;
      },
    });
    return new Response(body, {
      headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE },
    });
  }

  private async openResult(
    request: ComputerHostRequestV1,
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
  ): Promise<ComputerHostOpenResultV1> {
    const record = await this.computer(
      request.identity.userId,
      true,
      onProgress,
    );
    const sprite = await this.spriteFor(record.spriteName);
    const botKey = computerBotKeyV1(request.tenant.botId, this.digest);
    const profile = Buffer.from(
      JSON.stringify(
        {
          id: request.tenant.botId,
          name: request.tenant.botId,
          description: "FrockBot Bot",
          computer: { botKey, sharedHome: HOME_ROOT },
        },
        null,
        2,
      ),
    ).toString("base64");

    // Attaching and asking whether the tenant already has a live screen are one
    // call: the second answer is one `/dev/tcp` probe against the port the
    // first just wrote, and a second round trip to the Sprite per Turn buys
    // nothing. `exec` is gone because the shell has to outlive the script.
    const ensured = await this.run(
      sprite,
      [
        `set -eu`,
        `${ENSURE_AGENT_SCRIPT} ${shellQuote(botKey)} ${shellQuote(profile)}`,
        `SLOT=$(cat ${shellQuote(`${BOTS_ROOT}/${botKey}/slot`)} 2>/dev/null || true)`,
        `printf '${DESKTOP_SLOT_PREFIX}%s\\n' "$SLOT"`,
        `if [ -n "$SLOT" ] && (exec 3<>/dev/tcp/127.0.0.1/$((${VNC_PORT_BASE} + SLOT))) 2>/dev/null; then`,
        `  echo ${DESKTOP_LIVE_MARKER}`,
        `fi`,
        // One browser on the Computer, so one port to probe (ADR 0031). Its
        // liveness is a different fact from the tenant's viewer being up:
        // either can be missing on its own, and declaring a running service
        // again would restart it.
        `if (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_CDP_PORT}) 2>/dev/null; then`,
        `  echo ${BROWSER_LIVE_MARKER}`,
        `fi`,
        `if [ -s ${shellQuote(`${BOTS_ROOT}/${botKey}/${TARGET_ID_FILE}`)} ]; then`,
        `  echo ${WINDOW_LIVE_MARKER}`,
        `fi`,
        "",
      ].join("\n"),
      "ensure agent",
      COMPUTER_HOST_PHASE_TIMEOUTS.ensureAgent,
    );
    const ensuredText = `${ensured.stdout.toString("utf8")}${ensured.stderr.toString("utf8")}`;
    if (ensuredText.includes(NO_SLOTS_MARKER)) {
      throw new ComputerHostError(
        "conflict",
        `Every desktop on this Computer is in use; Bot "${request.tenant.botId}" has no display until one is idle`,
        409,
        true,
      );
    }
    if (ensured.exitCode !== 0) {
      throw new ComputerHostError(
        "provider-failure",
        `Computer could not attach the tenant: ${ensuredText.slice(0, 512)}`,
        502,
        true,
      );
    }

    // A display is optional. Slots are allocated on demand and there are
    // `DESKTOP_SLOTS` of them, so a tenant that has not been given one — or a
    // Computer whose desktop stack is not up — is answered without a display
    // rather than refused: the exec and file surfaces do not need a screen.
    const rawSlot = ensuredText
      .split("\n")
      .find((line) => line.startsWith(DESKTOP_SLOT_PREFIX))
      ?.slice(DESKTOP_SLOT_PREFIX.length);
    const parsed =
      rawSlot && /^\d+$/.test(rawSlot) ? Number(rawSlot) : undefined;
    const slot =
      parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : undefined;
    const display = await this.desktop(sprite, botKey, slot, {
      view: ensuredText.includes(DESKTOP_LIVE_MARKER),
      browser: ensuredText.includes(BROWSER_LIVE_MARKER),
      window: ensuredText.includes(WINDOW_LIVE_MARKER),
    });
    const result: ComputerHostOpenResultV1 = {
      version: 1,
      effectId: request.effectId,
      spriteName: record.spriteName,
      directory: `${DATA_ROOT}/agents/${botKey}`,
      ...(display ? { display } : {}),
      generation: record.generation,
      ...(record.provisioning ? { provisioning: record.provisioning } : {}),
    };
    return result;
  }

  /**
   * Brings up the Computer's shared screen, its one browser, and this tenant's
   * window and viewer, and answers with the display they are on (ADR 0031).
   *
   * The gateway is not the desktop. `start-gateway.sh` serves noVNC and routes
   * a viewer token to a loopback VNC port, but the process that *owns* that
   * port is per tenant, so it can only be started once a tenant has a slot.
   *
   * What is per tenant, and what is not, is the whole of ADR 0031. There is one
   * Xvfb and one Chromium for the Computer, because the browser profile is the
   * User's and Chromium's singleton lock is per profile: the previous layout
   * gave every slot its own Xvfb and its own browser launch, and every launch
   * after the first lost that lock, printed "Opening in existing browser
   * session", and left its Bot a black screen with a dead CDP port. Per tenant
   * there remains exactly one thing the platform supervises — an `x11vnc`
   * clipped to that tenant's slot — plus one window, which is not a service but
   * a CDP target this ensures.
   *
   * Each piece is declared only when its own probe says it is absent, because
   * `createService` is a create-*or-update*: declaring a running screen again
   * would take every Bot's window down with it.
   *
   * A display stays optional (`open` answers without one rather than refusing:
   * the exec and file surfaces do not need a screen), and "optional" means a
   * screen that failed to start is reported as absent rather than as a display
   * no viewer can reach.
   */
  private async desktop(
    sprite: SpriteHandle,
    botKey: string,
    slot: number | undefined,
    live: { view: boolean; browser: boolean; window: boolean },
  ): Promise<string | undefined> {
    if (slot === undefined) return undefined;
    if (slot >= DESKTOP_SLOTS) {
      // A slot outside the screen is a window nobody can see and a clip
      // rectangle x11vnc refuses. It can only come from a Computer that
      // allocated slots under the superseded hundred-display layout.
      return undefined;
    }
    await this.retireLegacyDesktops(sprite);
    try {
      if (!live.browser) {
        await this.declareService(sprite, SCREEN_SERVICE, {
          cmd: `${RUNTIME_ROOT}/start-screen.sh`,
        });
        await this.declareService(sprite, BROWSER_SERVICE, {
          cmd: `${RUNTIME_ROOT}/start-browser.sh`,
        });
      }
      if (!live.view) {
        await this.declareService(sprite, viewServiceNameV1(botKey), {
          cmd: `${RUNTIME_ROOT}/start-view.sh`,
          args: [botKey],
        });
      }
      if (!live.browser || !live.window) {
        // One window per Bot, pinned over its own slot. Cheap and idempotent,
        // and skipped entirely on the ordinary open where the browser is up
        // and this tenant already has a window recorded.
        const ensured = await this.run(
          sprite,
          `exec ${ENSURE_WINDOW_SCRIPT} ${shellQuote(botKey)}\n`,
          "ensure window",
          COMPUTER_HOST_PHASE_TIMEOUTS.control,
        );
        if (ensured.exitCode !== 0) return undefined;
      }
    } catch {
      // Reported as no display. The tenant keeps its slot and its files, the
      // next open tries again, and box-doctor is where a human reads why.
      return undefined;
    }
    return COMPUTER_DISPLAY;
  }

  /** One declared service, settled, under the service phase's bound. */
  private async declareService(
    sprite: SpriteHandle,
    name: string,
    config: { cmd: string; args?: string[]; httpPort?: number },
  ): Promise<void> {
    await withTimeout(
      settleService(await sprite.createService(name, config, "30s"), name),
      "service",
      COMPUTER_HOST_PHASE_TIMEOUTS.service,
    );
  }

  /**
   * Stops and forgets the superseded per-slot desktop services (ADR 0031).
   *
   * An existing Computer carries one `frockbot-desktop-<botKey>` per tenant
   * that ever opened a screen. Each is an Xvfb, a window manager, an `x11vnc`,
   * and a browser launch — and one of those browsers is holding the shared
   * profile's singleton lock right now. Leaving them running would mean the new
   * browser service could never take the profile, so they are stopped and
   * deleted before anything new is declared.
   *
   * Defensive and idempotent on purpose: it runs once per Sprite per container,
   * a Computer with no legacy services does nothing, and every per-service
   * failure is swallowed — a service that is already gone, or a platform that
   * will not list services at all, must not cost a Bot its Computer. It removes
   * *services*, never files: `${HOME_ROOT}/chrome-profile` is the User's login
   * state and is not this migration's to touch.
   */
  private async retireLegacyDesktops(sprite: SpriteHandle): Promise<void> {
    if (this.retired.has(sprite.name)) return;
    this.retired.add(sprite.name);
    let names: string[];
    try {
      names = (await sprite.listServices())
        .map((service) => service.name)
        .filter((name) => name.startsWith(DESKTOP_TENANT_SERVICE_PREFIX));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        await withTimeout(
          settleService(await sprite.stopService(name, "10s"), name),
          "legacy desktop stop",
          COMPUTER_HOST_PHASE_TIMEOUTS.service,
        );
      } catch {
        // Already stopped, or refused. The delete below is what matters.
      }
      try {
        await sprite.deleteService(name);
      } catch {
        // A service that cannot be deleted is one the reattach path will
        // refuse anyway: the `service` op no longer declares this prefix.
      }
    }
  }

  /** The User's Computer, provisioning it exactly once per container. */
  private computer(
    userId: string,
    inspectRuntime = false,
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
  ): Promise<ComputerRecord> {
    const updating = this.updates.get(userId);
    if (updating) {
      onProgress?.(updating.progress);
      return this.waitForUpdate(updating);
    }
    const cached = this.computers.get(userId);
    if (cached) {
      return inspectRuntime
        ? this.ensureRuntimeCurrent(userId, cached, undefined, onProgress)
        : Promise.resolve(cached);
    }
    let pending = this.openings.get(userId);
    if (!pending) {
      pending = this.provision(userId, onProgress)
        .then((record) => {
          // The progress belongs to the run, not to the Computer: the call
          // that provisioned it reports the phases, and every later `open`
          // reports an adoption with nothing to say about provisioning.
          const {
            provisioning: _provisioning,
            inspection: _inspection,
            ...adopted
          } = record;
          this.computers.set(userId, adopted);
          return record;
        })
        .finally(() => {
          this.openings.delete(userId);
        });
      this.openings.set(userId, pending);
    }
    return inspectRuntime
      ? pending.then((record) =>
          this.ensureRuntimeCurrent(
            userId,
            record,
            record.inspection,
            onProgress,
          ),
        )
      : pending;
  }

  private async provision(
    userId: string,
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
  ): Promise<ComputerRecord> {
    const spriteName = this.spriteNameFor(userId);
    const sprite = await this.findOrCreate(spriteName);
    const inspection = await this.inspectAdoption(sprite);
    if (inspection.state) {
      await this.ensureViewerReachable(sprite);
      return {
        spriteName,
        generation: inspection.state.generation,
        inspection,
      };
    }

    const provisioning = await this.driveProvisioning(
      sprite,
      "provision",
      onProgress,
    );
    // Nothing is running yet on a Computer being provisioned, so the
    // declaration *is* the start; there is no older process to replace.
    await this.declareGateway(sprite, false);
    await this.declareWatchdog(sprite, false);
    await withTimeout(
      settleService(
        await sprite.createService(WORKSPACE_SYNC_SERVICE, {
          cmd: `${RUNTIME_ROOT}/watch-workspace.sh`,
        }),
        "Workspace sync watcher",
      ),
      "workspace sync watcher",
      COMPUTER_HOST_PHASE_TIMEOUTS.service,
    );
    await sprite.updateURLSettings({ auth: "public" });

    // No state file means no prior provisioning of this Sprite.
    const generation = 1;
    await sprite
      .filesystem("/")
      .writeFile(
        COMPUTER_HOST_STATE_PATH,
        `${JSON.stringify({ version: 1, generation } satisfies ComputerHostStateV1)}\n`,
        { mode: 0o600 },
      );
    return { spriteName, generation, provisioning };
  }

  /** Compares the installed runtime on every open and updates it when stale. */
  private async ensureRuntimeCurrent(
    userId: string,
    record: ComputerRecord,
    inspected?: AdoptionInspection,
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
  ): Promise<ComputerRecord> {
    const active = this.updates.get(userId);
    if (active) {
      onProgress?.(active.progress);
      return this.waitForUpdate(active);
    }
    const sprite = await this.spriteFor(record.spriteName);
    const inspection = inspected ?? (await this.inspectAdoption(sprite));
    // Two opens may finish their read-only inspection together. The first
    // continuation records and owns the update; the second joins it instead
    // of starting another runner or waiting the full provisioning deadline.
    const concurrent = this.updates.get(userId);
    if (concurrent) {
      onProgress?.(concurrent.progress);
      return this.waitForUpdate(concurrent);
    }
    const digest = runtimeDocumentDigestV1();
    if (inspection.digest === digest) {
      if (inspection.state?.update) {
        // The runtime document may have reached disk before this container
        // observed the named gateway restart. This is that last update effect,
        // replayed before the durable intent is cleared (P3/P4) — and it has to
        // be a restart, because the service definition has not changed and
        // re-declaring an unchanged definition changes nothing.
        if (inspection.state.update.status === "started") {
          const watchdogRefreshed = await this.declareWatchdog(sprite, true);
          if (!watchdogRefreshed) return record;
          if (inspection.humanControlFresh) return record;
          await this.declareGateway(sprite, true);
          const browserRefreshed = await this.restartServiceSoft(
            sprite,
            BROWSER_SERVICE,
            "browser",
          );
          if (!browserRefreshed) return record;
        }
        await this.writeHostState(sprite, {
          version: 1,
          generation: record.generation,
        });
      }
      return record;
    }

    const progress: ComputerHostProvisioningV1 = {
      kind: "update",
      phase: UPDATE_STARTING_PHASE.name,
      label: UPDATE_STARTING_PHASE.label,
      index: 0,
      total: UPDATE_PHASES.length,
      status: "running",
      resumed: false,
    };
    let held!: ActiveUpdate;
    const promise = this.applyRuntimeUpdate(
      sprite,
      record,
      progress,
      onProgress,
      inspection.humanControlFresh,
    ).finally(() => {
      if (this.updates.get(userId) === held) this.updates.delete(userId);
    });
    held = { progress, promise };
    this.updates.set(userId, held);
    return inspection.state?.update?.status === "started"
      ? this.waitForUpdate(held)
      : promise;
  }

  private async applyRuntimeUpdate(
    sprite: SpriteHandle,
    record: ComputerRecord,
    progress: ComputerHostProvisioningV1,
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
    deferServiceRestarts = false,
  ): Promise<ComputerRecord> {
    const digest = runtimeDocumentDigestV1();
    // Durable intent precedes the launcher. Recovery sees `started`, compares
    // the still-old digest, and rejoins the same marker/lock-driven runner.
    await this.writeHostState(sprite, {
      version: 1,
      generation: record.generation,
      update: {
        status: "started",
        digest,
        recordedAt: new Date(this.now()).toISOString(),
      },
    });
    const updated = await this.driveProvisioning(
      sprite,
      "update",
      (observed) => {
        Object.assign(progress, observed);
        onProgress?.(observed);
      },
    );
    // The watchdog is safe to replace under a viewer: it owns no window and
    // immediately resumes the same read-only scan. Do this even while the
    // other service restarts are deferred, so the guard exists as soon as its
    // script does.
    const watchdogRefreshed = await this.declareWatchdog(sprite, true);
    if (!watchdogRefreshed) return { ...record, provisioning: updated };
    // A human is driving this desktop. `UPDATE_PHASES` disturbed nothing —
    // they are idempotent file installs, and a running websockify serves the
    // viewer page it just rewrote from the same `--web` directory on the next
    // request. Re-declaring the gateway is the one step that would drop the
    // live viewer out from under them, so leave `started` on the state file:
    // the digest now matches, and the reconciliation above re-declares it on
    // the first open after the lease goes stale. Deferring the whole update
    // instead is what left a Computer serving no viewer page at all.
    if (deferServiceRestarts) return { ...record, provisioning: updated };
    // A running websockify keeps the `--web` directory from its original
    // process, so the newly installed viewer page is only served once that
    // process is replaced (P3).
    await this.declareGateway(sprite, true);
    // The launcher's path is stable, so only a service restart makes an
    // already-running Chromium pick up the newly installed renderer bounds.
    const browserRefreshed = await this.restartServiceSoft(
      sprite,
      BROWSER_SERVICE,
      "browser",
    );
    if (!browserRefreshed) return { ...record, provisioning: updated };
    await this.writeHostState(sprite, {
      version: 1,
      generation: record.generation,
    });
    return { ...record, provisioning: updated };
  }

  /**
   * Declares the viewer gateway, and — after a runtime update — restarts it.
   *
   * `createService` is a create-or-update keyed by the definition it is given.
   * The gateway's definition never changes: `{cmd: start-gateway.sh, httpPort}`
   * is the same string before and after a runtime update, because what the
   * update rewrites is the *contents* of that launcher. Declaring it again is
   * therefore a no-op, and the running `websockify` keeps the `--web` directory
   * it was started with for the life of the Computer.
   *
   * That is not a hypothetical. A Computer went on serving noVNC's stock page
   * out of `/usr/share/novnc` for days after the runtime had been rewritten to
   * serve FrockBot's own viewer from `${VIEWER_ROOT}` — the viewer 404 ADR 0031
   * records — because every reconciliation re-declared a definition the
   * platform correctly recognised as unchanged. Picking up a rewritten launcher
   * takes a restart, so this asks for one.
   *
   * A restart is refused softly: a gateway that would not come back is a
   * Computer with no viewer, which is worth reporting through box-doctor and is
   * not worth failing an open over.
   */
  /**
   * Re-asserts that the Sprite's public hostname is anonymously reachable, on a
   * Computer this host *adopts* rather than provisions.
   *
   * Provisioning turns the URL public exactly once. Adoption used to assert
   * nothing: a Computer that already carried a state file was handed back
   * untouched, so a Sprite provisioned before that call existed — or one whose
   * settings were later flipped back — kept a gated hostname for good. The
   * viewer is an anonymous `<iframe>`, so a gated hostname answers it with a
   * redirect to the Sprites sign-in page that the app's
   * `frame-src https://*.sprites.app` then refuses: a viewer that fails outside
   * the box, with a gateway inside it that is perfectly healthy. Nothing done
   * to a process inside the box can fix how the platform gates the route.
   *
   * The write is skipped when the handle already reports `public`, so an
   * adoption of a healthy Computer costs nothing, and a failure is soft: a
   * hostname that could not be opened up is worth reporting through box-doctor,
   * not worth failing an open over.
   */
  private async ensureViewerReachable(sprite: SpriteHandle): Promise<void> {
    if (sprite.urlSettings?.auth === "public") return;
    try {
      await sprite.updateURLSettings({ auth: "public" });
    } catch {
      // box-doctor is where a Computer whose viewer is still gated shows up.
    }
  }

  private async declareGateway(
    sprite: SpriteHandle,
    restart: boolean,
  ): Promise<void> {
    await withTimeout(
      settleService(
        await sprite.createService(
          DESKTOP_SERVICE,
          { cmd: `${RUNTIME_ROOT}/start-gateway.sh`, httpPort: 6080 },
          "30s",
        ),
        "Desktop gateway",
      ),
      "desktop gateway",
      COMPUTER_HOST_PHASE_TIMEOUTS.service,
    );
    if (!restart) return;
    try {
      await withTimeout(
        settleService(
          await sprite.restartService(DESKTOP_SERVICE, "30s"),
          "Desktop gateway",
        ),
        "desktop gateway restart",
        COMPUTER_HOST_PHASE_TIMEOUTS.service,
      );
    } catch {
      // The declaration above stands. box-doctor's `desktop-gateway` check is
      // where a gateway that is not listening becomes visible.
    }
  }

  /** Declares the independently supervised renderer-memory guard. */
  private async declareWatchdog(
    sprite: SpriteHandle,
    restart: boolean,
  ): Promise<boolean> {
    await this.declareService(sprite, WATCHDOG_SERVICE, {
      cmd: WATCHDOG_SCRIPT,
    });
    return restart
      ? this.restartServiceSoft(sprite, WATCHDOG_SERVICE, "watchdog")
      : true;
  }

  /**
   * A failed service refresh is observable through box-doctor, not an open
   * refusal. The boolean keeps the durable update intent pending for retry.
   * An absent service is already reconciled: its next declaration starts the
   * current launcher, so there is no old process left to replace.
   */
  private async restartServiceSoft(
    sprite: SpriteHandle,
    name: string,
    label: string,
  ): Promise<boolean> {
    try {
      await withTimeout(
        settleService(await sprite.restartService(name, "30s"), label),
        `${label} restart`,
        COMPUTER_HOST_PHASE_TIMEOUTS.service,
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      // The service declaration remains supervised. Its doctor check carries
      // the actionable failure without taking exec and file access down too.
      return false;
    }
  }

  private async waitForUpdate(active: ActiveUpdate): Promise<ComputerRecord> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ComputerHostError(
              "computer-updating",
              active.progress.label,
              409,
              true,
            ),
          ),
        this.updateWaitMs,
      );
    });
    try {
      return await Promise.race([active.promise, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private writeHostState(
    sprite: SpriteHandle,
    state: ComputerHostStateV1,
  ): Promise<void> {
    return sprite
      .filesystem("/")
      .writeFile(COMPUTER_HOST_STATE_PATH, `${JSON.stringify(state)}\n`, {
        mode: 0o600,
      });
  }

  /**
   * Provisions a Computer without ever holding a long, silent connection.
   *
   * `@fly/sprites@0.1.0` declares a WebSocket dead after `WS_PONG_WAIT`
   * (45,000 ms) with no **inbound** message, and its `WS_PING_INTERVAL`
   * (15,000 ms) timer only measures that gap — it sends nothing, and the code
   * says why: "The server-side handles keepalive; we just track activity."
   * `apt-get` installing a desktop stack is quiet for minutes, so the single
   * long exec this replaces could not survive its own success (ADR 0004).
   *
   * So no exec here is long. One launches the provisioner detached under
   * `setsid nohup` and returns at once; the rest are polls a few seconds
   * apart, each of which answers immediately. The connection the SDK can kill
   * is never the connection the work depends on, and a container that
   * restarts mid-install rejoins the same run rather than starting another.
   */
  private async driveProvisioning(
    sprite: SpriteHandle,
    kind: ComputerHostProvisioningV1["kind"] = "provision",
    onProgress?: (progress: ComputerHostProvisioningV1) => void,
  ): Promise<ComputerHostProvisioningV1> {
    const deadline = this.now() + COMPUTER_HOST_PHASE_TIMEOUTS.provision;
    const documentDigest = runtimeDocumentDigestV1();
    const launch =
      kind === "update" ? updateLaunchScript : provisionLaunchScript;
    let progress = await this.provisionStep(sprite, launch, kind);
    // A Sprite that already carries phase markers is being *completed*: the
    // provisioner skips what is done, so this run is a resume, not a repeat.
    const resumed =
      kind === "provision" && (await this.hasProvisionMarkers(sprite));
    let announced = "";
    const announce = (observed: ProvisionObservation): void => {
      if (observed.phase === announced) return;
      announced = observed.phase;
      const {
        running: _running,
        documentDigest: _documentDigest,
        ...reported
      } = observed;
      const current = { ...reported, resumed };
      this.onProvisionProgress?.(sprite.name, current);
      onProgress?.(current);
    };
    announce(progress);
    // The launcher backgrounds the runner and exits, so the very first polls
    // can legitimately see a lock nobody holds yet. Only a run that is still
    // unstarted several polls later is actually gone.
    let stopped = 0;
    let relaunches = 0;
    let unreachableSince = 0;
    let interval = this.provisionPollMs;

    for (;;) {
      if (
        progress.status === "complete" &&
        !progress.running &&
        progress.documentDigest === documentDigest
      ) {
        // `running` is the host's own liveness question and never travels: the
        // protocol result carries the phase and nothing about the lock.
        const {
          running: _running,
          documentDigest: _documentDigest,
          ...reported
        } = progress;
        return { ...reported, resumed };
      }
      if (progress.status === "failed") {
        throw await this.provisioningFailure(sprite, progress);
      }
      if (this.now() >= deadline) {
        const operation = kind === "update" ? "update" : "provisioning";
        throw new ComputerHostError(
          "timeout",
          `Computer ${operation} exceeded ${COMPUTER_HOST_PHASE_TIMEOUTS.provision}ms during ${progress.label} (${progress.index}/${progress.total})`,
          504,
          true,
        );
      }

      stopped = progress.running ? 0 : stopped + 1;
      let script = provisionPollScript;
      if (stopped >= PROVISION_STOPPED_POLLS) {
        // Nothing holds the run lock and nothing has finished: the provisioner
        // is gone — its container migrated, its Sprite paused, or it was
        // killed mid-phase. Its phase markers are still there, so starting it
        // again completes the install rather than repeating it. The resume
        // happens inside this `open` rather than costing the Bot Durable
        // Object a retry.
        if (relaunches >= PROVISION_RELAUNCHES) {
          throw await this.provisioningFailure(sprite, {
            ...progress,
            status: "failed",
          });
        }
        relaunches += 1;
        stopped = 0;
        script = launch;
        this.onProvisionRetry?.(
          sprite.name,
          `no provisioner is running during ${progress.label}; restarting it from its markers (${relaunches}/${PROVISION_RELAUNCHES})`,
        );
      }

      await delay(interval);
      // Polls start close together, because the first phases are quick, and
      // spread out as the install settles into `apt-get`. Every one of them is
      // a fresh, short-lived connection, and a ten-minute install should not
      // need two hundred of them.
      interval = Math.min(interval * 2, this.provisionPollMs * 5);

      const observed = await this.provisionStep(sprite, script, kind).catch(
        (error: unknown) => {
          if (!(error instanceof ComputerHostError)) throw error;
          this.onProvisionRetry?.(
            sprite.name,
            `the Computer did not answer during ${progress.label}: ${error.message}`,
          );
          return undefined;
        },
      );
      if (observed) {
        progress = observed;
        announce(progress);
        unreachableSince = 0;
        continue;
      }
      // A failed poll says nothing about the install, which is running
      // detached; only a Computer that stays silent ends the run.
      if (unreachableSince === 0) unreachableSince = this.now();
      if (this.now() - unreachableSince > PROVISION_UNREACHABLE_MS) {
        throw new ComputerHostError(
          "provider-unavailable",
          `Computer stopped answering while ${progress.label} (${progress.index}/${progress.total})`,
          503,
          true,
        );
      }
    }
  }

  /** One short provisioning exec, decoded into the phase it reported. */
  private async provisionStep(
    sprite: SpriteHandle,
    script: string,
    kind: ComputerHostProvisioningV1["kind"],
  ): Promise<ProvisionObservation> {
    const outcome = await this.run(
      sprite,
      script,
      "provisioning",
      COMPUTER_HOST_PHASE_TIMEOUTS.provisionStep,
    );
    const text = `${outcome.stdout.toString("utf8")}${outcome.stderr.toString("utf8")}`;
    if (outcome.exitCode !== 0) {
      throw new ComputerHostError(
        "provider-failure",
        `Computer provisioning could not be started: ${text.slice(0, 512)}`,
        502,
        true,
      );
    }
    return readProvisionObservation(text, kind);
  }

  /**
   * Whether an earlier run left a completed phase behind.
   *
   * Only the declared phase names count. A directory listing can carry entries
   * that are not markers, and a Computer reported as resumed when it was not
   * would be a claim about what this run did rather than an observation.
   */
  private async hasProvisionMarkers(sprite: SpriteHandle): Promise<boolean> {
    const names = new Set(PROVISION_PHASES.map((phase) => phase.name));
    try {
      const entries = await sprite.filesystem("/").readdir(PROVISION_MARKERS, {
        withFileTypes: true,
      });
      return entries.some((entry) => names.has(entry.name));
    } catch {
      return false;
    }
  }

  private async provisioningFailure(
    sprite: SpriteHandle,
    progress: ProvisionObservation,
  ): Promise<ComputerHostError> {
    let tail = "";
    try {
      const log = await this.run(
        sprite,
        provisionLogTailScript,
        "provisioning log",
        COMPUTER_HOST_PHASE_TIMEOUTS.provisionStep,
      );
      tail = log.stdout.toString("utf8").trim();
    } catch {
      /* the log is a courtesy; the phase is the diagnosis */
    }
    return new ComputerHostError(
      "provider-failure",
      `Computer ${progress.kind === "update" ? "update" : "provisioning"} failed during ${progress.label} (${progress.index}/${progress.total})${tail ? `: ${tail.slice(-512)}` : ""}`,
      502,
      true,
    );
  }

  private async inspectAdoption(
    sprite: SpriteHandle,
  ): Promise<AdoptionInspection> {
    const outcome = await this.run(
      sprite,
      adoptionInspectionScript,
      "adoption inspection",
      COMPUTER_HOST_PHASE_TIMEOUTS.provisionStep,
    );
    if (outcome.exitCode !== 0) {
      throw new ComputerHostError(
        "provider-failure",
        `Computer adoption could not be inspected: ${outcome.stderr.toString("utf8").slice(0, 512)}`,
        502,
        true,
      );
    }
    const lines = outcome.stdout.toString("utf8").split("\n");
    const field = (prefix: string): string | undefined =>
      lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
    const encodedState = field(ADOPTION_STATE_PREFIX);
    let state: ComputerHostStateV1 | undefined;
    if (encodedState) {
      try {
        state = decodeComputerHostStateV1(
          JSON.parse(Buffer.from(encodedState, "base64").toString("utf8")),
        );
      } catch {
        state = undefined;
      }
    }
    const digest = field(ADOPTION_DIGEST_PREFIX)?.trim();
    return {
      ...(state ? { state } : {}),
      ...(digest ? { digest } : {}),
      humanControlFresh: field(ADOPTION_HUMAN_PREFIX)?.trim() === "1",
    };
  }

  /**
   * The Sprite behind a name, fetched at most once per container.
   *
   * A failed lookup is not kept: the next caller asks again, so a Sprite that
   * was missing or unreachable is not remembered as such.
   */
  private spriteFor(spriteName: string): Promise<SpriteHandle> {
    let held = this.spriteHandles.get(spriteName);
    if (!held) {
      held = this.client.getSprite(spriteName).catch((error: unknown) => {
        this.spriteHandles.delete(spriteName);
        throw error;
      });
      this.spriteHandles.set(spriteName, held);
    }
    return held;
  }

  private async findOrCreate(name: string): Promise<SpriteHandle> {
    try {
      return await this.spriteFor(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      const created = await this.client.createSprite(name);
      // Seeded rather than re-fetched: provisioning has the handle already,
      // and the operations that follow it in the same Turn would otherwise
      // each pay a lookup for it.
      this.spriteHandles.set(name, Promise.resolve(created));
      return created;
    } catch (error) {
      try {
        return await this.spriteFor(name);
      } catch {
        throw error;
      }
    }
  }

  // --- exec ----------------------------------------------------------------

  private async exec(
    request: ComputerHostRequestV1,
    operation: ComputerHostExecOperationV1,
    signal: AbortSignal | undefined,
    release: () => void,
  ): Promise<Response> {
    const record = await this.computer(request.identity.userId);
    const sprite = await this.spriteFor(record.spriteName);
    const script = computerHostExecScriptV1(operation);

    if (!operation.stream) {
      const outcome = await this.spawn(sprite, script, {
        effectId: request.effectId,
        userId: request.identity.userId,
        stdinBase64: operation.stdinBase64,
        timeoutMs: operation.timeoutMs,
        maxOutputBytes: operation.maxOutputBytes,
        signal,
      });
      const result: ComputerHostExecResultV1 = {
        version: 1,
        effectId: request.effectId,
        exitCode: outcome.exitCode,
        ...(outcome.signal ? { signal: outcome.signal } : {}),
        stdoutBase64: outcome.stdout.toString("base64"),
        stderrBase64: outcome.stderr.toString("base64"),
        outputTruncated: outcome.outputTruncated,
      };
      return Response.json(result);
    }

    const encoder = new TextEncoder();
    const host = this;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (
          frame: Parameters<typeof encodeComputerHostExecFrameV1>[0],
        ) => {
          controller.enqueue(
            encoder.encode(encodeComputerHostExecFrameV1(frame)),
          );
        };
        try {
          const outcome = await host.spawn(sprite, script, {
            effectId: request.effectId,
            userId: request.identity.userId,
            stdinBase64: operation.stdinBase64,
            timeoutMs: operation.timeoutMs,
            maxOutputBytes: operation.maxOutputBytes,
            signal,
            sink: {
              stdout: (chunk) => {
                if (chunk.byteLength) {
                  write({
                    type: "stdout",
                    dataBase64: chunk.toString("base64"),
                  });
                }
              },
              stderr: (chunk) => {
                if (chunk.byteLength) {
                  write({
                    type: "stderr",
                    dataBase64: chunk.toString("base64"),
                  });
                }
              },
            },
          });
          write({
            type: "exit",
            exitCode: outcome.exitCode,
            ...(outcome.signal ? { signal: outcome.signal } : {}),
            outputTruncated: outcome.outputTruncated,
          });
        } catch (error) {
          const failure =
            error instanceof ComputerHostError
              ? computerHostProblemV1(
                  error.code,
                  error.message,
                  error.retryable,
                )
              : computerHostProblemV1(
                  "provider-failure",
                  errorText(error),
                  true,
                );
          write({
            type: "error",
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          });
        } finally {
          release();
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE },
    });
  }

  /**
   * Runs one bash document on the Sprite and settles it.
   *
   * The command's argv is `["-s"]` and nothing else: everything the command
   * needs is written to its stdin. Cancellation and timeout share one path —
   * SIGTERM, then SIGKILL after the declared grace — because a caller that
   * disconnected and a caller that ran too long both want the same thing on
   * the Sprite, and one path cannot drift from the other.
   */
  private spawn(
    sprite: SpriteHandle,
    script: string,
    options: {
      effectId: string;
      userId: string;
      stdinBase64?: string;
      timeoutMs: number;
      maxOutputBytes: number;
      signal?: AbortSignal;
      sink?: ExecStreamSink;
    },
  ): Promise<ComputerHostExecOutcome> {
    const command = sprite.spawn("bash", ["-s"]);
    const stdout = new BoundedOutput(options.maxOutputBytes);
    const stderr = new BoundedOutput(options.maxOutputBytes);
    // Retained first, then handed on. `sink?.stdout(stdout.push(...))` would
    // short-circuit the whole chain when there is no sink, and the buffered
    // caller would get an empty answer.
    command.stdout.on("data", (chunk) => {
      const kept = stdout.push(bufferOf(chunk));
      if (options.sink) options.sink.stdout(kept);
    });
    command.stderr.on("data", (chunk) => {
      const kept = stderr.push(bufferOf(chunk));
      if (options.sink) options.sink.stderr(kept);
    });
    // The exit code and the last bytes of output are separate events, and the
    // exit can win. Draining is therefore part of settling, not an
    // optimisation: without it the tail of a command's output is silently
    // lost whenever the two land in the same turn of the loop.
    const drained = Promise.all([
      new Promise<void>((resolve) => command.stdout.once("end", resolve)),
      new Promise<void>((resolve) => command.stderr.once("end", resolve)),
    ]);

    let terminated: "cancelled" | "timeout" | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: "cancelled" | "timeout") => {
      if (terminated) return;
      terminated = reason;
      try {
        command.kill("SIGTERM");
      } catch {
        /* the command may already be gone; SIGKILL still follows */
      }
      killTimer = setTimeout(() => {
        try {
          command.kill("SIGKILL");
        } catch {
          /* nothing left to kill */
        }
      }, COMPUTER_HOST_PHASE_TIMEOUTS.termination);
    };

    // The admitted entry, when there is one. A maintenance command the host
    // runs for itself was never admitted, so it registers and removes its own.
    const admitted = this.inFlight.get(options.effectId);
    const owned = !admitted;
    if (admitted) {
      const pending = admitted.pending;
      admitted.cancel = terminate;
      if (pending) terminate(pending);
    } else {
      this.inFlight.set(options.effectId, {
        userId: options.userId,
        cancel: terminate,
      });
    }
    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(
      () => terminate("timeout"),
      options.timeoutMs,
    );

    // `on`, never `once`, and never removed: the SDK can emit `error` more
    // than once for a single command — a WebSocket that fails to open reports
    // it from the socket's own handler and again as it closes — and an
    // EventEmitter with no `error` listener throws out of the event loop.
    // Measured: it killed the container, and with it every other User's work
    // in flight. The reject after the first is a no-op, so the extra
    // emissions are absorbed rather than fatal.
    let failCommand: (error: unknown) => void = () => {};
    const failed = new Promise<never>((_resolve, reject) => {
      failCommand = reject;
    });
    command.on("error", (...args: unknown[]) =>
      failCommand(
        new ComputerHostError(
          "provider-unavailable",
          `Computer command failed: ${errorText(args[0])}`,
          503,
          true,
        ),
      ),
    );

    const settle = async (): Promise<ComputerHostExecOutcome> => {
      await Promise.race([
        new Promise<void>((resolve) => command.once("spawn", () => resolve())),
        failed,
      ]);
      command.stdin.write(script);
      if (options.stdinBase64) {
        command.stdin.write(Buffer.from(options.stdinBase64, "base64"));
      }
      command.stdin.end();
      const exitCode = await Promise.race([command.wait(), failed]);
      await Promise.race([drained, delay(COMPUTER_HOST_PHASE_TIMEOUTS.drain)]);
      return {
        exitCode: terminated ? null : exitCode,
        ...(terminated ? { signal: "SIGTERM" } : {}),
        stdout: stdout.bytes(),
        stderr: stderr.bytes(),
        outputTruncated: stdout.truncated || stderr.truncated,
      };
    };

    return settle()
      .then((outcome) => {
        if (terminated === "timeout") {
          throw new ComputerHostError(
            "timeout",
            `Computer command exceeded ${options.timeoutMs}ms`,
            504,
            true,
          );
        }
        if (terminated === "cancelled") {
          throw new ComputerHostError(
            "aborted",
            "Computer command was cancelled",
            499,
          );
        }
        return outcome;
      })
      .finally(() => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (owned) this.inFlight.delete(options.effectId);
      });
  }

  /** One short bash document, buffered, for the host's own maintenance calls. */
  private run(
    sprite: SpriteHandle,
    script: string,
    phase: string,
    timeoutMs: number,
  ): Promise<ComputerHostExecOutcome> {
    return withTimeout(
      this.spawn(sprite, script, {
        effectId: `host-${phase}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: "",
        timeoutMs,
        maxOutputBytes: 64 * 1_024,
      }),
      phase,
      timeoutMs + COMPUTER_HOST_PHASE_TIMEOUTS.termination,
    );
  }

  // --- files ---------------------------------------------------------------

  private async file(request: ComputerHostRequestV1): Promise<Response> {
    const operation = request.operation;
    if (!operation.kind.startsWith("file/")) {
      throw new ComputerHostError(
        "invalid-request",
        "not a file operation",
        400,
      );
    }
    const record = await this.computer(request.identity.userId);
    const sprite = await this.spriteFor(record.spriteName);
    const files = sprite.filesystem("/");

    switch (operation.kind) {
      case "file/read": {
        const [bytes, entry] = await withTimeout(
          Promise.all([
            files.readFile(operation.path, null),
            this.entry(files, operation.path),
          ]),
          "file read",
          COMPUTER_HOST_PHASE_TIMEOUTS.file,
        );
        return Response.json({
          version: 1,
          effectId: request.effectId,
          entry,
          bytesBase64: bytes.toString("base64"),
        });
      }
      case "file/write": {
        const bytes = Buffer.from(operation.bytesBase64, "base64");
        await withTimeout(
          (async () => {
            const parent = operation.path.slice(
              0,
              operation.path.lastIndexOf("/"),
            );
            if (parent) await files.mkdir(parent, { recursive: true });
            await files.writeFile(
              operation.path,
              bytes,
              operation.mode === undefined
                ? undefined
                : { mode: operation.mode },
            );
          })(),
          "file write",
          COMPUTER_HOST_PHASE_TIMEOUTS.file,
        );
        return Response.json({
          version: 1,
          effectId: request.effectId,
          entry: await this.entry(files, operation.path),
        });
      }
      case "file/stat":
        return Response.json({
          version: 1,
          effectId: request.effectId,
          entry: await withTimeout(
            this.entry(files, operation.path),
            "file stat",
            COMPUTER_HOST_PHASE_TIMEOUTS.file,
          ),
        });
      case "file/list": {
        const dirents = await withTimeout(
          files.readdir(operation.path, {
            withFileTypes: true,
            recursive: operation.recursive,
          }),
          "file list",
          COMPUTER_HOST_PHASE_TIMEOUTS.file,
        );
        const limit = 2_000;
        const page = dirents.slice(0, limit);
        return Response.json({
          version: 1,
          effectId: request.effectId,
          entries: page.map((dirent) => ({
            path: `${dirent.parentPath.replace(/\/$/, "")}/${dirent.name}`,
            kind: direntKind(dirent),
            size: 0,
            mode: 0,
          })),
          truncated: dirents.length > limit,
        });
      }
      case "file/delete": {
        let deleted = true;
        try {
          await withTimeout(
            files.rm(operation.path, { recursive: operation.recursive }),
            "file delete",
            COMPUTER_HOST_PHASE_TIMEOUTS.file,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          deleted = false;
        }
        return Response.json({
          version: 1,
          effectId: request.effectId,
          path: operation.path,
          deleted,
        });
      }
      default:
        throw new ComputerHostError(
          "invalid-request",
          "not a file operation",
          400,
        );
    }
  }

  private async entry(
    files: SpriteFilesystemHandle,
    path: string,
  ): Promise<ComputerHostFileEntryV1> {
    const stats = await files.stat(path);
    return {
      path,
      kind: stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other",
      size: Math.max(0, Math.trunc(stats.size)),
      mode: stats.mode & 0o7777,
      ...(stats.mtime instanceof Date && !Number.isNaN(stats.mtime.getTime())
        ? { modifiedAt: stats.mtime.toISOString() }
        : {}),
    };
  }

  private async readText(sprite: SpriteHandle, path: string): Promise<string> {
    const bytes = await sprite.filesystem("/").readFile(path, null);
    return bytes.toString("utf8");
  }

  // --- control, viewer, services -------------------------------------------

  /**
   * The human-takeover lease. It is `flock`-serialized *on the Sprite*, not
   * here: "one Computer serves all of a User's Bots", so the only lock that
   * covers every caller is the one on the shared box.
   */
  private async control(request: ComputerHostRequestV1): Promise<Response> {
    const operation = request.operation;
    if (operation.kind !== "control") {
      throw new ComputerHostError("invalid-request", "not a control call", 400);
    }
    const record = await this.computer(request.identity.userId);
    const sprite = await this.spriteFor(record.spriteName);
    // The lease key *is* the scope. A `bot` lease is keyed by the tenant's own
    // directory, exactly as human takeover always was; a `desktop-gui` lease is
    // keyed by one name shared by every tenant on the box, which is what makes
    // it User-wide — one Computer serves all of a User's Bots, and there is one
    // screen on it. The key is not a tenant directory and cannot collide with
    // one: `computerBotKeyV1` never produces this name.
    const leaseKey =
      operation.scope === "desktop-gui"
        ? DESKTOP_GUI_LEASE_KEY
        : computerBotKeyV1(request.tenant.botId, this.digest);
    const outcome = await this.run(
      sprite,
      `exec ${CONTROL_SCRIPT} ${shellQuote(operation.action)} ${shellQuote(leaseKey)} ${shellQuote(operation.ownerId)} ${operation.maxAgeSeconds}\n`,
      "control",
      COMPUTER_HOST_PHASE_TIMEOUTS.control,
    );
    if (outcome.exitCode === 73) {
      throw new ComputerHostError(
        "human-control-active",
        outcome.stderr.toString("utf8").trim() ||
          "This Computer is under human control",
        409,
      );
    }
    if (outcome.exitCode !== 0) {
      throw new ComputerHostError(
        "provider-failure",
        `Computer control ${operation.action} failed: ${outcome.stderr.toString("utf8").slice(0, 512)}`,
        502,
        true,
      );
    }
    // A human has just taken this Computer over. Every Bot's window is on one
    // screen now (ADR 0031), so the screen they are handed shows whichever
    // window Chromium last focused unless this raises theirs. Best effort: a
    // window that would not come to the front is a takeover of the wrong
    // rectangle, and is not worth refusing a lease the Sprite already granted.
    // Nothing is lowered on release — the next takeover raises its own.
    if (operation.action === "acquire") {
      await this.run(
        sprite,
        `exec ${FOCUS_WINDOW_SCRIPT} ${shellQuote(computerBotKeyV1(request.tenant.botId, this.digest))}\n`,
        "focus window",
        COMPUTER_HOST_PHASE_TIMEOUTS.control,
      ).catch(() => undefined);
    }
    const result: ComputerHostControlResultV1 = {
      version: 1,
      effectId: request.effectId,
      action: operation.action,
      ownerId: operation.ownerId,
      ...(operation.action === "release"
        ? {}
        : {
            expiresAt: new Date(
              this.now() + operation.maxAgeSeconds * 1_000,
            ).toISOString(),
          }),
    };
    return Response.json(result);
  }

  /**
   * A viewer session: an opaque token the Sprite's own websockify gateway
   * routes to that tenant's loopback VNC port. The token is minted on the
   * Sprite by the ensure script and never leaves it except inside this URL.
   */
  private async viewer(request: ComputerHostRequestV1): Promise<Response> {
    const operation = request.operation;
    if (operation.kind !== "viewer") {
      throw new ComputerHostError("invalid-request", "not a viewer call", 400);
    }
    const record = await this.computer(request.identity.userId);
    const sprite = await this.spriteFor(record.spriteName);
    const botKey = computerBotKeyV1(request.tenant.botId, this.digest);

    if (operation.action === "revoke") {
      await this.run(
        sprite,
        [
          `TOKEN=${shellQuote(operation.sessionId ?? "")}`,
          `TMP=$(mktemp ${RUNTIME_ROOT}/tokens.XXXXXX)`,
          `grep -v "^$TOKEN:" ${RUNTIME_ROOT}/tokens > "$TMP" || true`,
          `chmod 600 "$TMP"`,
          `mv "$TMP" ${RUNTIME_ROOT}/tokens`,
          "",
        ].join("\n"),
        "viewer revoke",
        COMPUTER_HOST_PHASE_TIMEOUTS.control,
      );
      return Response.json({ version: 1, effectId: request.effectId });
    }

    // The ensure exec that precedes a new viewer has already minted these
    // files and touched last-seen. Renewals still need the touch, so reading
    // both values and recording activity are one Sprite exec rather than two
    // filesystem requests followed by another exec (P3).
    const material = await this.run(
      sprite,
      [
        `set -eu`,
        `BOT=${shellQuote(`${BOTS_ROOT}/${botKey}`)}`,
        `if [ ! -s "$BOT/viewer-token" ] || [ ! -s "$BOT/vnc-password" ]; then`,
        `  echo ${VIEWER_MISSING_MARKER}`,
        `  exit 69`,
        `fi`,
        `touch "$BOT/last-seen"`,
        `printf '${VIEWER_TOKEN_PREFIX}%s\\n' "$(cat "$BOT/viewer-token")"`,
        `printf '${VIEWER_PASSWORD_PREFIX}%s\\n' "$(cat "$BOT/vnc-password")"`,
        "",
      ].join("\n"),
      `viewer ${operation.action}`,
      COMPUTER_HOST_PHASE_TIMEOUTS.control,
    );
    const materialText = material.stdout.toString("utf8");
    if (materialText.includes(VIEWER_MISSING_MARKER)) {
      throw new ComputerHostError(
        "not-found",
        "The Computer viewer session is not available",
        404,
      );
    }
    if (material.exitCode !== 0) {
      // Viewer stdout contains credentials. Never include it in an error that
      // can cross the host seam or reach durable failure state (P4).
      const detail = material.stderr.toString("utf8").trim().slice(0, 512);
      throw new ComputerHostError(
        "provider-failure",
        detail
          ? `Computer viewer session could not be minted: ${detail}`
          : "Computer viewer session could not be minted",
        502,
        true,
      );
    }
    const field = (prefix: string): string | undefined =>
      materialText
        .split("\n")
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length)
        .trim();
    const sessionId = field(VIEWER_TOKEN_PREFIX);
    const password = field(VIEWER_PASSWORD_PREFIX);
    if (!sessionId || !password) {
      throw new ComputerHostError(
        "provider-failure",
        "The Computer returned incomplete viewer session material",
        502,
        true,
      );
    }
    if (operation.action === "renew" && operation.sessionId !== sessionId) {
      throw new ComputerHostError(
        "not-found",
        "The Computer viewer session has expired",
        404,
      );
    }
    // A Sprite handle already carries the public URL. Only a legacy/malformed
    // handle with no URL pays another API lookup.
    const base =
      sprite.url ?? (await this.client.getSprite(record.spriteName)).url;
    if (!base) {
      throw new ComputerHostError(
        "provider-unavailable",
        "The Sprites API returned no Computer URL",
        503,
        true,
      );
    }
    const viewer = new URL(
      VIEWER_PAGE.slice(VIEWER_PAGE.lastIndexOf("/") + 1),
      base.endsWith("/") ? base : `${base}/`,
    );
    viewer.hash = new URLSearchParams({
      autoconnect: "1",
      reconnect: "1",
      resize: "scale",
      view_only: "1",
      path: `websockify?token=${sessionId}`,
      password,
    }).toString();
    return Response.json({
      version: 1,
      effectId: request.effectId,
      session: {
        id: sessionId,
        url: viewer.toString(),
        expiresAt: new Date(
          this.now() + CONTROL_LEASE_SECONDS * 1_000,
        ).toISOString(),
      },
    });
  }

  /**
   * Reattaches one declared service. "Only Computer-provider-declared services
   * may be reattached; other processes are assumed dead after a cold pause" —
   * so this refuses any name the Computer runtime does not declare.
   */
  private async service(request: ComputerHostRequestV1): Promise<Response> {
    const operation = request.operation;
    if (operation.kind !== "service") {
      throw new ComputerHostError("invalid-request", "not a service call", 400);
    }
    const declared =
      operation.name === DESKTOP_SERVICE ||
      operation.name === WORKSPACE_SYNC_SERVICE ||
      operation.name === SCREEN_SERVICE ||
      operation.name === BROWSER_SERVICE ||
      operation.name === WATCHDOG_SERVICE ||
      operation.name.startsWith(VIEW_TENANT_SERVICE_PREFIX);
    if (!declared) {
      throw new ComputerHostError(
        "invalid-request",
        `"${operation.name}" is not a Computer-provider-declared service`,
        400,
      );
    }
    const record = await this.computer(request.identity.userId);
    const sprite = await this.spriteFor(record.spriteName);
    let status: "running" | "unavailable" = "running";
    try {
      await withTimeout(
        settleService(
          await sprite.startService(operation.name, "30s"),
          operation.name,
        ),
        "service reattach",
        COMPUTER_HOST_PHASE_TIMEOUTS.service,
      );
    } catch {
      status = "unavailable";
    }
    return Response.json({
      version: 1,
      effectId: request.effectId,
      name: operation.name,
      status,
    });
  }
}

function direntKind(dirent: SpriteDirentHandle): ComputerHostFileKindV1 {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

/**
 * The tenant's directory key on the shared Computer. It matches
 * `computerBotKey` in `@frockbot/plugin-fly-sprite` exactly, because the two
 * must name the same directories on the same box.
 */
export function computerBotKeyV1(
  botId: string,
  digest: (value: string) => string,
): string {
  const id = botId.trim();
  const slug = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return `${slug || "bot"}-${digest(id).slice(0, 12)}`;
}

export { WORKSPACES_ROOT };
