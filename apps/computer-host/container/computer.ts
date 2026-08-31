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
  computerSpriteNameV1,
  computerSpriteNameSourceV1,
  CONTROL_SCRIPT,
  DATA_ROOT,
  DESKTOP_SERVICE,
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
  NO_SLOTS_MARKER,
  PROVISION_MARKERS,
  PROVISION_PHASES,
  PROVISION_RUNNER_PREFIX,
  PROVISION_STARTING_PHASE,
  provisionLaunchScript,
  provisionLogTailScript,
  provisionPollScript,
  RUNTIME_ROOT,
  shellQuote,
  WORKSPACE_SYNC_SERVICE,
  WORKSPACES_ROOT,
} from "@frockbot/computer-host-runtime";
import {
  COMPUTER_HOST_STREAM_MEDIA_TYPE,
  computerHostProblemV1,
  encodeComputerHostExecFrameV1,
  problem,
  type ComputerHostControlResultV1,
  type ComputerHostErrorCodeV1,
  type ComputerHostExecOperationV1,
  type ComputerHostExecResultV1,
  type ComputerHostFileEntryV1,
  type ComputerHostFileKindV1,
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
 * Sprite, `apt-get install chromium` is heavy enough that the machine drops
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
}

/** Decodes a provisioning report. Anything unreadable reads as "starting". */
export function readProvisionObservation(text: string): ProvisionObservation {
  const running = text.includes(`${PROVISION_RUNNER_PREFIX}running`);
  const base: ProvisionObservation = {
    phase: PROVISION_STARTING_PHASE.name,
    label: PROVISION_STARTING_PHASE.label,
    index: 0,
    total: PROVISION_PHASES.length,
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
  /**
   * Told every time a provisioning run reaches a new phase.
   *
   * `open` answers once, at the end, so a cold Computer is minutes of quiet
   * from outside the container. This is how the container itself is not quiet:
   * the process log names the phase while it is happening, which is what an
   * operator needs when an install is slow rather than broken.
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

  constructor(options: ComputerHostOptions) {
    this.client = options.client;
    this.baseSpriteName = options.baseSpriteName;
    this.digest = options.digest;
    this.now = options.now ?? (() => Date.now());
    this.concurrency = options.concurrency ?? COMPUTER_HOST_CONCURRENCY;
    this.provisionPollMs =
      options.provisionPollMs ?? COMPUTER_HOST_PHASE_TIMEOUTS.provisionPoll;
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
    // A streaming exec has not finished when it answers: its `Response` is an
    // open stream. It therefore takes ownership of the release, or a cancel
    // arriving mid-stream would find nothing to cancel.
    const streaming =
      request.operation.kind === "exec" && request.operation.stream;
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
        return this.open(request);
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
  private async open(request: ComputerHostRequestV1): Promise<Response> {
    const record = await this.computer(request.identity.userId);
    const sprite = await this.client.getSprite(record.spriteName);
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

    const ensured = await this.run(
      sprite,
      [
        `exec ${ENSURE_AGENT_SCRIPT} ${shellQuote(botKey)} ${shellQuote(profile)}`,
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

    // A display is optional. Slots are allocated on demand and there are a
    // hundred of them, so a tenant that has not been given one — or a Computer
    // whose desktop stack is not up — is answered without a display rather
    // than refused: the exec and file surfaces do not need a screen.
    const display = await this.displayFor(sprite, botKey);
    const result: ComputerHostOpenResultV1 = {
      version: 1,
      effectId: request.effectId,
      spriteName: record.spriteName,
      directory: `${DATA_ROOT}/agents/${botKey}`,
      ...(display ? { display } : {}),
      generation: record.generation,
      ...(record.provisioning ? { provisioning: record.provisioning } : {}),
    };
    return Response.json(result);
  }

  private async displayFor(
    sprite: SpriteHandle,
    botKey: string,
  ): Promise<string | undefined> {
    let slot: number;
    try {
      slot = Number(
        (await this.readText(sprite, `${BOTS_ROOT}/${botKey}/slot`)).trim(),
      );
    } catch {
      return undefined;
    }
    return Number.isSafeInteger(slot) && slot >= 0
      ? `:${100 + slot}`
      : undefined;
  }

  /** The User's Computer, provisioning it exactly once per container. */
  private computer(userId: string): Promise<ComputerRecord> {
    const cached = this.computers.get(userId);
    if (cached) return Promise.resolve(cached);
    let pending = this.openings.get(userId);
    if (!pending) {
      pending = this.provision(userId)
        .then((record) => {
          // The progress belongs to the run, not to the Computer: the call
          // that provisioned it reports the phases, and every later `open`
          // reports an adoption with nothing to say about provisioning.
          const { provisioning: _provisioning, ...adopted } = record;
          this.computers.set(userId, adopted);
          return record;
        })
        .finally(() => {
          this.openings.delete(userId);
        });
      this.openings.set(userId, pending);
    }
    return pending;
  }

  private async provision(userId: string): Promise<ComputerRecord> {
    const spriteName = this.spriteNameFor(userId);
    const sprite = await this.findOrCreate(spriteName);
    const adopted = await this.readState(sprite);
    if (adopted) return { spriteName, generation: adopted.generation };

    const provisioning = await this.driveProvisioning(sprite);
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
        `${JSON.stringify({ version: 1, generation })}\n`,
        { mode: 0o600 },
      );
    return { spriteName, generation, provisioning };
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
  ): Promise<ComputerHostProvisioningV1> {
    const deadline = this.now() + COMPUTER_HOST_PHASE_TIMEOUTS.provision;
    let progress = await this.provisionStep(sprite, provisionLaunchScript);
    // A Sprite that already carries phase markers is being *completed*: the
    // provisioner skips what is done, so this run is a resume, not a repeat.
    const resumed = await this.hasProvisionMarkers(sprite);
    let announced = "";
    const announce = (observed: ProvisionObservation): void => {
      if (observed.phase === announced) return;
      announced = observed.phase;
      const { running: _running, ...reported } = observed;
      this.onProvisionProgress?.(sprite.name, { ...reported, resumed });
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
      if (progress.status === "complete") {
        // `running` is the host's own liveness question and never travels: the
        // protocol result carries the phase and nothing about the lock.
        const { running: _running, ...reported } = progress;
        return { ...reported, resumed };
      }
      if (progress.status === "failed") {
        throw await this.provisioningFailure(sprite, progress);
      }
      if (this.now() >= deadline) {
        throw new ComputerHostError(
          "timeout",
          `Computer provisioning exceeded ${COMPUTER_HOST_PHASE_TIMEOUTS.provision}ms during ${progress.label} (${progress.index}/${progress.total})`,
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
        script = provisionLaunchScript;
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

      const observed = await this.provisionStep(sprite, script).catch(
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
    return readProvisionObservation(text);
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
      `Computer provisioning failed during ${progress.label} (${progress.index}/${progress.total})${tail ? `: ${tail.slice(-512)}` : ""}`,
      502,
      true,
    );
  }

  private async readState(
    sprite: SpriteHandle,
  ): Promise<{ generation: number } | undefined> {
    let text: string;
    try {
      text = await this.readText(sprite, COMPUTER_HOST_STATE_PATH);
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        Number.isSafeInteger((parsed as { generation?: unknown }).generation)
      ) {
        return { generation: (parsed as { generation: number }).generation };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async findOrCreate(name: string): Promise<SpriteHandle> {
    try {
      return await this.client.getSprite(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      return await this.client.createSprite(name);
    } catch (error) {
      try {
        return await this.client.getSprite(name);
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
    const sprite = await this.client.getSprite(record.spriteName);
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
    const sprite = await this.client.getSprite(record.spriteName);
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
    const sprite = await this.client.getSprite(record.spriteName);
    const botKey = computerBotKeyV1(request.tenant.botId, this.digest);
    const outcome = await this.run(
      sprite,
      `exec ${CONTROL_SCRIPT} ${shellQuote(operation.action)} ${shellQuote(botKey)} ${shellQuote(operation.ownerId)} ${operation.maxAgeSeconds}\n`,
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
    const sprite = await this.client.getSprite(record.spriteName);
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

    const [token, password] = await Promise.all([
      this.readText(sprite, `${BOTS_ROOT}/${botKey}/viewer-token`),
      this.readText(sprite, `${BOTS_ROOT}/${botKey}/vnc-password`),
    ]);
    const base =
      (await this.client.getSprite(record.spriteName)).url ?? sprite.url;
    if (!base) {
      throw new ComputerHostError(
        "provider-unavailable",
        "The Sprites API returned no Computer URL",
        503,
        true,
      );
    }
    const viewer = new URL("vnc.html", base.endsWith("/") ? base : `${base}/`);
    viewer.hash = new URLSearchParams({
      autoconnect: "1",
      reconnect: "1",
      resize: "scale",
      path: `websockify?token=${token.trim()}`,
      password: password.trim(),
    }).toString();
    return Response.json({
      version: 1,
      effectId: request.effectId,
      session: {
        id: token.trim(),
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
      operation.name.startsWith("frockbot-desktop-");
    if (!declared) {
      throw new ComputerHostError(
        "invalid-request",
        `"${operation.name}" is not a Computer-provider-declared service`,
        400,
      );
    }
    const record = await this.computer(request.identity.userId);
    const sprite = await this.client.getSprite(record.spriteName);
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
