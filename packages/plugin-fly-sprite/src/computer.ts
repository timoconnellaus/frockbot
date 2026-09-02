import { createHash, randomUUID } from "node:crypto";
import {
  ComputerError,
  decodeComputerDoctorReportV1,
  type ComputerControlRequestV1,
  type ComputerDoctorReportV1,
  type ComputerOperationOptions,
} from "@frockbot/computer-core";
import type {
  ComputerHostControlResultV1,
  ComputerHostFileReadResultV1,
  ComputerHostOpenResultV1,
  ComputerHostProvisioningV1,
  ComputerHostViewerResultV1,
} from "@frockbot/computer-host-protocol";
import {
  BIN_ROOT,
  BOTS_ROOT,
  BOUNDED_LOG_SCRIPT,
  CONTROL_SCRIPT,
  DATA_ROOT,
  DOCTOR_MARKER,
  DOCTOR_SCRIPT,
  HOME_ROOT,
  LEASE_MAX_AGE_SECONDS,
  NO_SLOTS_MARKER,
  RUNTIME_ROOT,
  SANCTIONED_SURFACE_ENV,
  SCRATCH_ENV,
  SCRATCH_ROOT,
  shellQuote,
  SHIMS_ROOT,
  SLOT_IDLE_SECONDS,
  WORKSPACE_SYNC_SERVICE,
  WORKSPACES_ROOT,
} from "@frockbot/computer-host-runtime";
import type {
  ComputerHostCallOptions,
  ComputerHostExecCommandV1,
  ComputerHostExecOutcomeV1,
} from "./host-client.js";

// The Computer's on-Sprite layout, its provisioning script, and its declared
// services live in `@frockbot/computer-host-runtime`, so the shared Computer
// host of ADR 0004 and this provider ship one runtime rather than two. Both
// names below are re-exported because they are part of this module's public
// surface: the sync Package names the watcher service, and the slot-reclaim
// threshold is policy a caller may need to reason about.
export { SLOT_IDLE_SECONDS, WORKSPACE_SYNC_SERVICE };

const MAX_OUTPUT = 30_000;
const MAX_STORAGE_OUTPUT = 500_000;
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";
/** Largest screenshot this provider will carry back off a Computer. */
export const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
/** Log bytes a single read carries back from a background process. */
export const PROCESS_LOG_DEFAULT_TAIL_BYTES = 8_192;
export const PROCESS_LOG_MAX_TAIL_BYTES = 64_000;
/** How long a stopped process is given to handle TERM before KILL. */
export const PROCESS_STOP_GRACE_SECONDS = 5;
const PROCESS_MARKER = "__FROCKBOT_PROCESS__";

/** Deadlines this provider asks the host for, per phase. */
const TIMEOUTS = {
  /** Provisioning apt-installs a desktop stack on a cold Computer. */
  open: 10 * 60_000,
  command: 120_000,
  browser: 45_000,
  screenshot: 30_000,
  /** box-doctor probes a dozen things, none of them slow. */
  doctor: 45_000,
  control: 15_000,
  viewer: 30_000,
} as const;

/**
 * The shared Computer host as this provider uses it (ADR 0004).
 *
 * `ComputerHostClient` satisfies it, and so does a test double. It is declared
 * here rather than imported as a class so this module depends on the *shape*
 * of the host and not on the transport: the client owns the service binding,
 * the framing, and the retry classification, and this module owns what a Bot
 * tenant means on a Computer.
 */
export interface ComputerHostSurfaceV1 {
  open(options?: ComputerHostCallOptions): Promise<ComputerHostOpenResultV1>;
  exec(
    command: ComputerHostExecCommandV1,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostExecOutcomeV1>;
  fileRead(
    path: string,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostFileReadResultV1>;
  control(
    action: "acquire" | "renew" | "release",
    ownerId: string,
    maxAgeSeconds: number,
    options?: ComputerHostCallOptions & { scope?: "bot" | "desktop-gui" },
  ): Promise<ComputerHostControlResultV1>;
  viewer(
    action: "open" | "renew" | "revoke",
    options?: ComputerHostCallOptions & { sessionId?: string },
  ): Promise<ComputerHostViewerResultV1>;
}

/**
 * Makes the host surface for one Bot on one User's Computer.
 *
 * The identity and the tenant are both arguments because they mean different
 * things (ADR 0012): the User names the Computer, the Bot names the tenant on
 * it, and the host has to be told both on every call.
 */
export type ComputerHostFactoryV1 = (
  identity: { userId: string },
  tenant: { botId: string },
) => ComputerHostSurfaceV1;

export interface ComputerBotIdentity {
  id: string;
  name?: string;
  description?: string;
}

interface AgentLayout {
  identity: ComputerBotIdentity;
  key: string;
  runtimeDir: string;
  workspaceDir: string;
}

/** One capture of a tenant's desktop, as it left the Computer. */
export interface SpriteScreenshotV1 {
  bytes: Uint8Array;
  /** The X display the capture was taken from, e.g. `:100`. */
  display: string;
  /** Where the capture sat on the Computer before it was read back. */
  path: string;
  capturedAt: string;
}

/** What a background launch left on the Computer. */
export interface SpriteProcessLaunchV1 {
  pid: number;
  logPath: string;
  cwd: string;
}

/** What the Computer says about one background process right now. */
export interface SpriteProcessStateV1 {
  alive: boolean;
  exitCode?: number;
  logTail: string;
}

export interface SpriteAgentExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface FlySpriteComputerOptions {
  /** Whose Computer this is. One Computer per User (ADR 0012). */
  identity?: { userId: string };
  /**
   * The shared Computer host. Absent, and this Computer is unconfigured: the
   * provider Package can no longer reach a Sprite from the Durable Object on
   * its own, so a Computer with no host is a Computer with no compute.
   */
  host?: ComputerHostFactoryV1;
  /** The Sprite name this Computer expects, before the host answers with one. */
  spriteName?: string;
  respectHumanControl?: boolean;
}

export interface BrowserAction {
  action: "snapshot" | "navigate" | "click" | "fill" | "press" | "wait";
  url?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  key?: string;
  exact?: boolean;
  milliseconds?: number;
}

export interface ComputerConnection {
  botId: string;
  botKey: string;
  spriteName: string;
  viewerUrl: string;
  viewerSessionId: string;
  viewerExpiresAt?: string;
  /** The tenant's X display on the shared Computer, e.g. `:100`. */
  display: string;
  /** The tenant's durable directory, relative to the Workspace home. */
  directory: string;
  /** The progress from the host wake that opened this connection, if any. */
  message?: string;
}

function provisioningMessage(progress: ComputerHostProvisioningV1): string {
  return progress.kind === "update"
    ? `Updating the Computer: ${progress.label}`
    : `Preparing the Computer: ${progress.label}`;
}

function configuredName(): string {
  const name = process.env.FROCKBOT_SPRITE_NAME?.trim() || "frockbot-barebones";
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name)) {
    throw new Error(
      "FROCKBOT_SPRITE_NAME must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  return name;
}

export function flySpriteNameForBot(
  botId: string,
  baseName = configuredName(),
): string {
  const normalizedBase = baseName.trim();
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(normalizedBase)) {
    throw new Error(
      "Fly Sprite base name must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  const suffix = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  const prefix = normalizedBase.slice(0, 49).replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

function normalizedIdentity(
  input: string | ComputerBotIdentity,
): ComputerBotIdentity {
  const identity = typeof input === "string" ? { id: input } : input;
  const id = identity.id.trim();
  if (!id || id.length > 200) {
    throw new Error("Computer Bot id must contain 1-200 characters");
  }
  return {
    id,
    name: identity.name?.trim() || undefined,
    description: identity.description?.trim() || undefined,
  };
}

export function computerBotKey(botId: string): string {
  const id = normalizedIdentity(botId).id;
  const slug = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${slug || "bot"}-${digest}`;
}

function layoutFor(input: string | ComputerBotIdentity): AgentLayout {
  const identity = normalizedIdentity(input);
  const key = computerBotKey(identity.id);
  return {
    identity,
    key,
    runtimeDir: `${BOTS_ROOT}/${key}`,
    workspaceDir: `${WORKSPACES_ROOT}/${key}`,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const decoder = new TextDecoder();

function outputText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function clipped(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… output truncated`;
}

/** True when the host refused because no desktop slot was free. */
function isSlotExhaustion(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes(NO_SLOTS_MARKER) ||
    text.includes("no desktop slots available") ||
    text.includes("no display until one is idle")
  );
}

export class FlySpriteAgentComputer {
  readonly botId: string;
  readonly botKey: string;
  private readonly computer: FlySpriteComputer;
  private readonly layout: AgentLayout;

  constructor(computer: FlySpriteComputer, layout: AgentLayout) {
    this.computer = computer;
    this.layout = layout;
    this.botId = layout.identity.id;
    this.botKey = layout.key;
  }

  /** The tenant's allocated X display, once its desktop has been ensured. */
  get display(): string | undefined {
    return this.computer.displayForTenant(this.layout.key);
  }

  /** The tenant's durable directory, relative to the Workspace home. */
  get directory(): string {
    return `agent-data/agents/${this.layout.key}`;
  }

  ensure(signal?: AbortSignal): Promise<ComputerConnection> {
    return this.computer.ensureAgent(this.layout, signal);
  }

  connect(options?: ComputerOperationOptions): Promise<ComputerConnection> {
    return this.computer.connectAgent(this.layout, options);
  }

  run(command: string, signal: AbortSignal): Promise<string> {
    return this.computer.runForAgent(this.layout, command, signal);
  }

  exec(
    command: string,
    signal: AbortSignal,
    limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<SpriteAgentExecResult> {
    return this.computer.execForAgent(this.layout, command, signal, limits);
  }

  runStorage(command: string, signal: AbortSignal): Promise<string> {
    return this.computer.runStorageForAgent(this.layout, command, signal);
  }

  browser(action: BrowserAction, signal: AbortSignal): Promise<string> {
    return this.computer.browserForAgent(this.layout, action, signal);
  }

  /** Captures this tenant's own desktop. */
  screenshot(signal: AbortSignal): Promise<SpriteScreenshotV1> {
    return this.computer.screenshotForAgent(this.layout, signal);
  }

  /** Runs the Computer's self-check for this tenant. */
  doctor(signal: AbortSignal): Promise<ComputerDoctorReportV1> {
    return this.computer.doctorForAgent(this.layout, signal);
  }

  launchProcess(
    processId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<SpriteProcessLaunchV1> {
    return this.computer.launchProcessForAgent(
      this.layout,
      processId,
      command,
      signal,
    );
  }

  inspectProcess(
    processId: string,
    signal: AbortSignal,
    tailBytes?: number,
  ): Promise<SpriteProcessStateV1> {
    return this.computer.inspectProcessForAgent(
      this.layout,
      processId,
      signal,
      tailBytes,
    );
  }

  stopProcess(
    processId: string,
    signal: AbortSignal,
  ): Promise<SpriteProcessStateV1> {
    return this.computer.stopProcessForAgent(this.layout, processId, signal);
  }

  /** The Computer's provisioning generation, once it has been opened. */
  get generation(): number | undefined {
    return this.computer.generationForTenant(this.layout.key);
  }

  /** The generation the Computer is on now, asked of the host. */
  currentGeneration(signal?: AbortSignal): Promise<number> {
    return this.computer.currentGenerationForAgent(this.layout, signal);
  }

  /** This tenant's working directory on the Computer. */
  get workingDirectory(): string {
    return this.layout.workspaceDir;
  }

  /** Opens a viewer session on this tenant's desktop. */
  viewer(
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostViewerResultV1> {
    return this.computer.viewerForAgent(
      this.layout,
      "open",
      options?.signal,
      undefined,
      options?.effectId,
    );
  }

  revokeViewer(
    sessionId: string,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostViewerResultV1> {
    return this.computer.viewerForAgent(
      this.layout,
      "revoke",
      options?.signal,
      sessionId,
      options?.effectId,
    );
  }

  refreshViewer(
    sessionId: string,
    options?: ComputerOperationOptions,
  ): Promise<ComputerHostViewerResultV1> {
    return this.computer.viewerForAgent(
      this.layout,
      "renew",
      options?.signal,
      sessionId,
      options?.effectId,
    );
  }

  takeControl(
    options?: ComputerOperationOptions,
    request?: ComputerControlRequestV1,
  ): Promise<ComputerHostControlResultV1> {
    return this.computer.control(
      this.layout,
      "acquire",
      options?.signal,
      request,
      options?.effectId,
    );
  }

  refreshControl(
    options?: ComputerOperationOptions,
    request?: ComputerControlRequestV1,
  ): Promise<ComputerHostControlResultV1> {
    return this.computer.control(
      this.layout,
      "renew",
      options?.signal,
      request,
      options?.effectId,
    );
  }

  releaseControl(
    options?: ComputerOperationOptions,
    request?: ComputerControlRequestV1,
  ): Promise<void> {
    return this.computer.releaseForAgent(
      this.layout,
      options?.signal,
      request,
      options?.effectId,
    );
  }

  /** The human-control lease owner this Computer holds leases under. */
  get controlOwnerId(): string {
    return this.computer.ownerId;
  }
}

/**
 * One User's Computer, driven through the shared host.
 *
 * Everything Fly-specific that used to live here — the Sprites SDK, the
 * provisioning script, the declared services, the viewer token files — is on
 * the host now (ADR 0004). What remains is what a Bot *tenant* means on a
 * Computer: its directory key, its human-control guard, and the shape of the
 * commands it runs. That is why `FlySpriteAgentComputer`'s method surface is
 * unchanged: `workspace.ts` and `sync.ts` generate bash against it and neither
 * knows, or needs to know, that the bash now travels on a command's stdin.
 */
export class FlySpriteComputer {
  readonly configured: boolean;
  /** The lease owner every human-control call from this Computer names. */
  readonly ownerId = randomUUID();
  private readonly identity: { userId: string };
  private readonly host?: ComputerHostFactoryV1;
  private readonly respectHumanControl: boolean;
  private expectedSpriteName: string;
  private readonly surfaces = new Map<string, ComputerHostSurfaceV1>();
  private readonly agentPromises = new Map<
    string,
    Promise<ComputerConnection>
  >();
  private readonly storagePromises = new Map<string, Promise<unknown>>();
  private readonly displays = new Map<string, string>();
  private readonly generations = new Map<string, number>();

  constructor(options: FlySpriteComputerOptions = {}) {
    this.identity = options.identity ?? {
      userId: process.env.FROCKBOT_USER_ID?.trim() || "local-user",
    };
    this.host = options.host;
    this.expectedSpriteName = options.spriteName ?? configuredName();
    this.configured = Boolean(options.host);
    this.respectHumanControl = options.respectHumanControl ?? true;
  }

  /**
   * The Sprite backing this Computer. It is the host's answer once one has
   * been opened, and the configured expectation before that: the host derives
   * the name from the User, so the two agree, and only the host's is a fact.
   */
  get spriteName(): string {
    return this.expectedSpriteName;
  }

  bot(identity: string | ComputerBotIdentity): FlySpriteAgentComputer {
    return new FlySpriteAgentComputer(this, layoutFor(identity));
  }

  /**
   * The X display this Computer allocated to one tenant, once its desktop has
   * been ensured. Slots are allocated on demand, exactly as GrokBot allocates
   * displays on demand rather than one per agent, so this is `undefined` until
   * the tenant's desktop has started.
   */
  displayForTenant(botKey: string): string | undefined {
    return this.displays.get(botKey);
  }

  /** The Computer's provisioning generation, as the host last reported it. */
  generationForTenant(botKey: string): number | undefined {
    return this.generations.get(botKey);
  }

  async ensureAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    this.hostFor(layout);
    let promise = this.agentPromises.get(layout.key);
    if (!promise) {
      promise = this.openAgent(layout, { signal }).catch((error: unknown) => {
        this.agentPromises.delete(layout.key);
        throw error;
      });
      this.agentPromises.set(layout.key, promise);
    }
    return promise;
  }

  connectAgent(
    layout: AgentLayout,
    options?: ComputerOperationOptions,
  ): Promise<ComputerConnection> {
    this.hostFor(layout);
    return this.openAgent(layout, options);
  }

  async runForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
  ): Promise<string> {
    const host = await this.readyHost(layout, signal);
    const script = [
      this.agentControlGuard(layout),
      ...this.tenantEnvironment(layout),
      command,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      { signal, timeoutMs: TIMEOUTS.command, maxOutputBytes: MAX_OUTPUT * 2 },
      "Sprite command failed",
    );
    return clipped(
      [outputText(outcome.stdout), outputText(outcome.stderr)]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async execForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
    limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<SpriteAgentExecResult> {
    const host = await this.readyHost(layout, signal);
    const maxOutput = Math.max(
      1,
      Math.min(limits.maxOutputBytes ?? MAX_OUTPUT, MAX_OUTPUT),
    );
    // The marker survives the move to the host for one reason: the outer
    // script's exit code belongs to the control guard, and the Bot's command
    // has an exit code of its own. Collapsing the two would make a Computer
    // under human control indistinguishable from a command that failed.
    const script = [
      this.agentControlGuard(layout),
      ...this.tenantEnvironment(layout),
      `bash -c ${shellQuote(command)}`,
      `printf '\\n%s%s\\n' ${shellQuote(EXEC_EXIT_MARKER)} "$?"`,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      {
        signal,
        timeoutMs: Math.max(
          1,
          Math.min(limits.timeoutMs ?? TIMEOUTS.command, TIMEOUTS.command),
        ),
        maxOutputBytes: MAX_OUTPUT * 2,
      },
      "Sprite command failed",
    );
    const raw = outputText(outcome.stdout);
    const match = new RegExp(`\\n?${EXEC_EXIT_MARKER}(\\d+)\\n?$`).exec(raw);
    const stdout = match ? raw.slice(0, match.index) : raw;
    const stderr = outputText(outcome.stderr);
    return {
      exitCode: match ? Number(match[1]) : null,
      stdout: stdout.slice(0, maxOutput),
      stderr: stderr.slice(0, maxOutput),
      outputTruncated:
        !match ||
        outcome.outputTruncated ||
        stdout.length > maxOutput ||
        stderr.length > maxOutput,
    };
  }

  /**
   * The Workspace and the durable-root sync's own commands.
   *
   * They carry no human-control guard on purpose: reconciling durable state is
   * not the Bot acting on the Computer, and a human holding the screen must
   * not stop a Turn's files from reaching object storage.
   */
  async runStorageForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
  ): Promise<string> {
    const host = this.hostFor(layout);
    signal.throwIfAborted();
    await this.readyStorage(layout, host, signal);
    const script = [...this.tenantEnvironment(layout), command].join("\n");
    const outcome = await this.execute(
      host,
      script,
      {
        signal,
        timeoutMs: TIMEOUTS.command,
        maxOutputBytes: MAX_STORAGE_OUTPUT * 2,
      },
      "Sprite storage operation failed",
    );
    const stdout = outputText(outcome.stdout);
    if (stdout.length > MAX_STORAGE_OUTPUT || outcome.outputTruncated) {
      throw new ComputerError(
        "limit-exceeded",
        "Sprite storage output exceeded the maximum size",
      );
    }
    return stdout;
  }

  /**
   * Captures the tenant's own desktop and carries the PNG back.
   *
   * Two host operations and no new one: a guarded `exec` runs `scrot` under
   * the tenant's own `DISPLAY`, and `file/read` brings the bytes back. The
   * guard is the same one every Bot command carries, so a screenshot taken
   * while a human holds the takeover lease is refused rather than handing the
   * Bot a picture of the human's session.
   *
   * The file is read back rather than left where it landed because a durable
   * root reached by a shell write syncs back `unattributed`: the caller writes
   * these bytes through the Workspace, which is what records the Bot as their
   * writer.
   */
  async screenshotForAgent(
    layout: AgentLayout,
    signal: AbortSignal,
  ): Promise<SpriteScreenshotV1> {
    const host = await this.readyHost(layout, signal);
    const display = this.displays.get(layout.key);
    if (!display) {
      throw new ComputerError(
        "capability-unavailable",
        `Bot "${layout.identity.id}" has no desktop on this Computer to capture`,
      );
    }
    const bot = `${BOTS_ROOT}/${layout.key}`;
    const path = `${bot}/screenshot.png`;
    const script = [
      this.agentControlGuard(layout),
      ...this.tenantEnvironment(layout),
      `export DISPLAY=${shellQuote(display)}`,
      // `scrot` is one of the shimmed names, and this is the surface the shim
      // exists to point at, so it is allowed through here and nowhere else.
      `export ${SANCTIONED_SURFACE_ENV}=1`,
      `rm -f ${shellQuote(path)}`,
      `scrot --overwrite ${shellQuote(path)}`,
      `stat -c %s ${shellQuote(path)}`,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      {
        signal,
        timeoutMs: TIMEOUTS.screenshot,
        maxOutputBytes: MAX_OUTPUT,
      },
      "Sprite screenshot failed",
    );
    const size = Number(outputText(outcome.stdout).trim().split("\n").pop());
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new ComputerError(
        "provider-unavailable",
        "The Computer produced no screenshot",
      );
    }
    if (size > SCREENSHOT_MAX_BYTES) {
      throw new ComputerError(
        "limit-exceeded",
        `The screenshot is ${size} bytes, past the ${SCREENSHOT_MAX_BYTES}-byte limit`,
      );
    }
    const read = await host.fileRead(path, {
      signal,
      timeoutMs: TIMEOUTS.screenshot,
    });
    const bytes = Uint8Array.from(Buffer.from(read.bytesBase64, "base64"));
    if (bytes.byteLength === 0) {
      throw new ComputerError(
        "provider-unavailable",
        "The Computer returned an empty screenshot",
      );
    }
    return {
      bytes,
      display,
      path,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Runs box-doctor and decodes its report.
   *
   * No human-control guard, and deliberately: a Computer a human has taken
   * over is exactly a Computer somebody may need to ask what is wrong with,
   * and every check reads. The tenant stamp still runs, because asking is
   * using and a tenant being asked about must not lose its display slot
   * mid-answer.
   *
   * The script prints its report on one marked line and its human-readable
   * lines to `/tmp/box-doctor.log`, so the marker is what separates the report
   * from anything else the Computer said.
   */
  async doctorForAgent(
    layout: AgentLayout,
    signal: AbortSignal,
  ): Promise<ComputerDoctorReportV1> {
    const host = await this.readyHost(layout, signal);
    const generation = this.generations.get(layout.key) ?? 0;
    const script = [
      this.tenantStamp(layout),
      ...this.tenantEnvironment(layout),
      `if [ ! -x ${DOCTOR_SCRIPT} ]; then echo "missing" >&2; exit 69; fi`,
      `${DOCTOR_SCRIPT} ${shellQuote(layout.key)} ${String(generation)}`,
    ].join("\n");
    let outcome: ComputerHostExecOutcomeV1;
    try {
      outcome = await this.execute(
        host,
        script,
        {
          signal,
          timeoutMs: TIMEOUTS.doctor,
          maxOutputBytes: MAX_OUTPUT * 2,
        },
        "Sprite self-check failed",
      );
    } catch (error) {
      // A Computer provisioned before the self-check existed has no script to
      // run. That is a stated outcome — it installs on the next open — not a
      // crash, and saying which it is costs one sentence.
      if (errorText(error).includes("missing")) {
        throw new ComputerError(
          "capability-unavailable",
          "This Computer has no self-check installed yet; it is installed the next time the Computer is opened",
        );
      }
      throw error;
    }
    const line = outputText(outcome.stdout)
      .split("\n")
      .find((candidate) => candidate.startsWith(DOCTOR_MARKER));
    let parsed: unknown;
    try {
      parsed = line ? JSON.parse(line.slice(DOCTOR_MARKER.length)) : undefined;
    } catch {
      parsed = undefined;
    }
    const report = decodeComputerDoctorReportV1(parsed);
    if (!report) {
      throw new ComputerError(
        "provider-failure",
        "The Computer's self-check produced no readable report",
      );
    }
    return report;
  }

  /**
   * Starts a command that outlives its Turn.
   *
   * `setsid` makes the command a process group leader, which is what lets a
   * later `stop` end the whole tree with one signal rather than orphaning the
   * children of a shell pipeline. `nohup` detaches it from the exec's own
   * terminal, so the process survives the connection closing — and connections
   * to a Computer are expected to drop on every pause.
   *
   * The launch returns as soon as the pid file exists. Nothing here keeps the
   * Computer awake: a process is a thing running on a Computer while it is
   * awake, not a reason for it to stay that way.
   */
  async launchProcessForAgent(
    layout: AgentLayout,
    processId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<SpriteProcessLaunchV1> {
    const host = await this.readyHost(layout, signal);
    const directory = this.processDirectory(layout, processId);
    const script = [
      this.agentControlGuard(layout),
      ...this.tenantEnvironment(layout),
      `DIR=${shellQuote(directory)}`,
      'mkdir -p "$DIR"',
      `printf %s ${shellQuote(command)} > "$DIR/command"`,
      // One `bash -c` holding the pipeline, so `$!` is the group leader and
      // the exit code recorded is the command's own, not the logger's.
      `setsid nohup bash -c ${shellQuote(
        [
          `bash -c ${shellQuote(command)} 2>&1 | ${BOUNDED_LOG_SCRIPT} "${directory}/log"`,
          `printf '%s\\n' "\${PIPESTATUS[0]}" > "${directory}/exit"`,
        ].join("\n"),
      )} >/dev/null 2>&1 &`,
      `printf '%s\\n' "$!" > "$DIR/pid"`,
      `printf '%s%s\\n' ${shellQuote(PROCESS_MARKER)} "$(cat "$DIR/pid")"`,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      { signal, timeoutMs: TIMEOUTS.control, maxOutputBytes: MAX_OUTPUT },
      "Sprite background launch failed",
    );
    const pid = Number(
      new RegExp(`${PROCESS_MARKER}(\\d+)`).exec(
        outputText(outcome.stdout),
      )?.[1],
    );
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ComputerError(
        "provider-unavailable",
        "The Computer started no background process",
      );
    }
    return { pid, logPath: `${directory}/log`, cwd: layout.workspaceDir };
  }

  /**
   * Reads a process's outcome. It never restarts anything: recovery reads an
   * outcome rather than repeating an effect.
   */
  async inspectProcessForAgent(
    layout: AgentLayout,
    processId: string,
    signal: AbortSignal,
    tailBytes?: number,
  ): Promise<SpriteProcessStateV1> {
    const host = await this.readyHost(layout, signal);
    return this.readProcess(host, layout, processId, signal, tailBytes);
  }

  /**
   * Ends the process group: TERM, a grace, then KILL.
   *
   * The negative pid is the point — a background command is usually a shell
   * pipeline, and signalling only the leader leaves its children running with
   * nothing recording them.
   */
  async stopProcessForAgent(
    layout: AgentLayout,
    processId: string,
    signal: AbortSignal,
  ): Promise<SpriteProcessStateV1> {
    const host = await this.readyHost(layout, signal);
    const directory = this.processDirectory(layout, processId);
    const script = [
      this.agentControlGuard(layout),
      ...this.tenantEnvironment(layout),
      `DIR=${shellQuote(directory)}`,
      'PID=$(cat "$DIR/pid" 2>/dev/null || echo 0)',
      'if [ "$PID" -gt 0 ]; then',
      '  kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true',
      `  for _ in $(seq 1 ${PROCESS_STOP_GRACE_SECONDS * 10}); do`,
      '    kill -0 "$PID" 2>/dev/null || break',
      "    sleep 0.1",
      "  done",
      '  if kill -0 "$PID" 2>/dev/null; then',
      '    kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true',
      "  fi",
      "fi",
      // A stop that had to signal leaves no exit file of its own, so one is
      // written here: an ended process must not read back as `unknown`.
      '[ -f "$DIR/exit" ] || printf \'143\\n\' > "$DIR/exit"',
    ].join("\n");
    await this.execute(
      host,
      script,
      {
        signal,
        timeoutMs: (PROCESS_STOP_GRACE_SECONDS + 10) * 1_000,
        maxOutputBytes: MAX_OUTPUT,
      },
      "Sprite background stop failed",
    );
    return this.readProcess(host, layout, processId, signal);
  }

  /**
   * Asks the host what generation this Computer is on *now*.
   *
   * Deliberately not the cached answer from `ensureAgent`: the cached one is
   * the generation this provider instance opened under, and the whole question
   * a background process asks is whether the Computer answering today is the
   * Computer it was launched on. A reprovision between the two is exactly the
   * case that must not read back as `running`.
   */
  async currentGenerationForAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<number> {
    const host = await this.readyHost(layout, signal);
    const opened = await host.open({ signal, timeoutMs: TIMEOUTS.open });
    this.generations.set(layout.key, opened.generation);
    if (opened.display) this.displays.set(layout.key, opened.display);
    return opened.generation;
  }

  private processDirectory(layout: AgentLayout, processId: string): string {
    return `${BOTS_ROOT}/${layout.key}/processes/${processId}`;
  }

  /**
   * One read of a process's directory: liveness, exit code, and the bounded
   * log the logger keeps in two halves.
   */
  private async readProcess(
    host: ComputerHostSurfaceV1,
    layout: AgentLayout,
    processId: string,
    signal: AbortSignal,
    tailBytes = PROCESS_LOG_DEFAULT_TAIL_BYTES,
  ): Promise<SpriteProcessStateV1> {
    const bounded = Math.max(
      1,
      Math.min(tailBytes, PROCESS_LOG_MAX_TAIL_BYTES),
    );
    const directory = this.processDirectory(layout, processId);
    // No human-control guard, and deliberately: reading a process's outcome is
    // not the Bot acting on the Computer, and a Routine collecting the result
    // of a long job must not be blocked because a human is holding the screen.
    // The stamp still runs, because a tenant with a running process is a live
    // tenant and its display slot must not be reclaimed under it.
    const script = [
      this.tenantStamp(layout),
      `DIR=${shellQuote(directory)}`,
      'PID=$(cat "$DIR/pid" 2>/dev/null || echo 0)',
      `printf '%salive=%s\\n' ${shellQuote(PROCESS_MARKER)} "$(kill -0 "$PID" 2>/dev/null && echo 1 || echo 0)"`,
      `if [ -f "$DIR/exit" ]; then printf '%sexit=%s\\n' ${shellQuote(PROCESS_MARKER)} "$(cat "$DIR/exit")"; fi`,
      `printf '%slog\\n' ${shellQuote(PROCESS_MARKER)}`,
      `if [ -s "$DIR/log.head" ]; then head -c ${bounded} "$DIR/log.head"; fi`,
      `if [ -s "$DIR/log.tail" ]; then printf '\\n… earlier output dropped …\\n'; tail -c ${bounded} "$DIR/log.tail"; fi`,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      {
        signal,
        timeoutMs: TIMEOUTS.control,
        maxOutputBytes: PROCESS_LOG_MAX_TAIL_BYTES * 4,
      },
      "Sprite background read failed",
    );
    const raw = outputText(outcome.stdout);
    const alive = new RegExp(`${PROCESS_MARKER}alive=1`).test(raw);
    const exit = new RegExp(`${PROCESS_MARKER}exit=(-?\\d+)`).exec(raw);
    const logIndex = raw.indexOf(`${PROCESS_MARKER}log\n`);
    const logTail =
      logIndex < 0 ? "" : raw.slice(logIndex + `${PROCESS_MARKER}log\n`.length);
    return {
      alive,
      ...(exit ? { exitCode: Number(exit[1]) } : {}),
      logTail: clipped(logTail, bounded * 2),
    };
  }

  async browserForAgent(
    layout: AgentLayout,
    action: BrowserAction,
    signal: AbortSignal,
  ): Promise<string> {
    const host = await this.readyHost(layout, signal);
    const encoded = Buffer.from(JSON.stringify(action)).toString("base64url");
    const script = [
      this.agentControlGuard(layout),
      `PORT=$(cat ${layout.runtimeDir}/cdp-port)`,
      `node ${RUNTIME_ROOT}/browser.mjs "$PORT" ${shellQuote(encoded)}`,
    ].join("\n");
    const outcome = await this.execute(
      host,
      script,
      { signal, timeoutMs: TIMEOUTS.browser, maxOutputBytes: MAX_OUTPUT * 2 },
      "Sprite browser action failed",
    );
    return clipped(
      outputText(outcome.stdout).trim() || outputText(outcome.stderr).trim(),
    );
  }

  control(
    layout: AgentLayout,
    action: "acquire" | "renew",
    signal?: AbortSignal,
    request?: ComputerControlRequestV1,
    effectId?: string,
  ): Promise<ComputerHostControlResultV1> {
    return this.hostFor(layout).control(
      action,
      request?.ownerId ?? this.ownerId,
      LEASE_MAX_AGE_SECONDS,
      {
        signal,
        effectId,
        timeoutMs: TIMEOUTS.control,
        ...(request?.scope ? { scope: request.scope } : {}),
      },
    );
  }

  async releaseForAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
    request?: ComputerControlRequestV1,
    effectId?: string,
  ): Promise<void> {
    if (!this.host) return;
    try {
      await this.hostFor(layout).control(
        "release",
        request?.ownerId ?? this.ownerId,
        LEASE_MAX_AGE_SECONDS,
        {
          signal,
          effectId,
          timeoutMs: TIMEOUTS.control,
          ...(request?.scope ? { scope: request.scope } : {}),
        },
      );
    } catch (error) {
      // A Computer that is not there holds no lease to release. Every other
      // refusal is real and the caller has to see it.
      if (error instanceof ComputerError && error.code === "conflict") return;
      throw error;
    }
  }

  viewerForAgent(
    layout: AgentLayout,
    action: "open" | "renew" | "revoke",
    signal?: AbortSignal,
    sessionId?: string,
    effectId?: string,
  ): Promise<ComputerHostViewerResultV1> {
    return this.hostFor(layout).viewer(action, {
      signal,
      effectId,
      timeoutMs: TIMEOUTS.viewer,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Creates the tenant's durable directories once per Computer.
   *
   * The Workspace and the sync both assume their roots exist. They are made
   * here rather than by the host's `open` because storage is reachable while
   * the tenant has no desktop: a Turn that only reads files must not have to
   * provision a screen first.
   */
  private readyStorage(
    layout: AgentLayout,
    host: ComputerHostSurfaceV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let held = this.storagePromises.get(layout.key);
    if (!held) {
      held = this.execute(
        host,
        `mkdir -p ${[
          layout.workspaceDir,
          `${DATA_ROOT}/agents/${layout.key}/memory`,
          `${DATA_ROOT}/agents/${layout.key}/skills`,
          `${DATA_ROOT}/user-memory`,
          `${DATA_ROOT}/user-packages`,
          `${RUNTIME_ROOT}/sync`,
        ]
          .map(shellQuote)
          .join(" ")}\n`,
        { signal, timeoutMs: TIMEOUTS.control, maxOutputBytes: MAX_OUTPUT },
        "Sprite storage operation failed",
      ).catch((error: unknown) => {
        this.storagePromises.delete(layout.key);
        throw error;
      });
      this.storagePromises.set(layout.key, held);
    }
    return held;
  }

  private hostFor(layout: AgentLayout): ComputerHostSurfaceV1 {
    if (!this.host) {
      throw new ComputerError(
        "provider-unavailable",
        "Set SPRITES_TOKEN to attach a Fly Sprite computer",
      );
    }
    let held = this.surfaces.get(layout.key);
    if (!held) {
      held = this.host(this.identity, { botId: layout.identity.id });
      this.surfaces.set(layout.key, held);
    }
    return held;
  }

  private async readyHost(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerHostSurfaceV1> {
    await this.ensureAgent(layout, signal);
    return this.hostFor(layout);
  }

  /**
   * Opens the Computer and attaches this tenant to it.
   *
   * One call: the host provisions the Sprite if it must, runs the ensure
   * script, allocates a display slot, and answers with the tenant's directory
   * and generation. The Durable Object no longer sequences provisioning steps
   * because it can no longer see the Sprite — and that is the point.
   */
  private async openAgent(
    layout: AgentLayout,
    options?: ComputerOperationOptions,
  ): Promise<ComputerConnection> {
    const signal = options?.signal;
    const effectId = options?.effectId;
    const host = this.hostFor(layout);
    let opened: ComputerHostOpenResultV1;
    try {
      opened = await host.open({
        signal,
        timeoutMs: TIMEOUTS.open,
        ...(effectId ? { effectId: `${effectId}:open` } : {}),
      });
    } catch (error) {
      // Every display belonging to a tenant this Computer still has open is a
      // declared outcome, not a crash: the alternative would be two Bots
      // sharing one screen, and Bots are separated on a Computer exactly so
      // that does not happen silently.
      if (isSlotExhaustion(error)) {
        throw new ComputerError(
          "capability-unavailable",
          `Every desktop on this Computer is in use; Bot "${layout.identity.id}" has no display until one is idle`,
          true,
          { cause: error },
        );
      }
      throw error;
    }
    this.expectedSpriteName = opened.spriteName;
    this.generations.set(layout.key, opened.generation);
    if (opened.display) this.displays.set(layout.key, opened.display);
    if (this.respectHumanControl) {
      await this.assertAgentControl(
        host,
        layout,
        signal,
        effectId ? `${effectId}:assert-control` : undefined,
      );
    }
    const viewer = await host.viewer("open", {
      signal,
      timeoutMs: TIMEOUTS.viewer,
      ...(effectId ? { effectId: `${effectId}:viewer` } : {}),
    });
    if (!viewer.session) {
      throw new ComputerError(
        "provider-unavailable",
        "The Computer host returned no viewer session",
        true,
      );
    }
    return {
      botId: layout.identity.id,
      botKey: layout.key,
      spriteName: opened.spriteName,
      viewerUrl: viewer.session.url,
      viewerSessionId: viewer.session.id,
      ...(viewer.session.expiresAt
        ? { viewerExpiresAt: viewer.session.expiresAt }
        : {}),
      display: opened.display ?? "",
      directory: `agent-data/agents/${layout.key}`,
      ...(opened.provisioning
        ? { message: provisioningMessage(opened.provisioning) }
        : {}),
    };
  }

  private async assertAgentControl(
    host: ComputerHostSurfaceV1,
    layout: AgentLayout,
    signal?: AbortSignal,
    effectId?: string,
  ): Promise<void> {
    await this.execute(
      host,
      `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(
        this.ownerId,
      )} ${LEASE_MAX_AGE_SECONDS}\n`,
      {
        signal,
        effectId,
        timeoutMs: TIMEOUTS.control,
        maxOutputBytes: MAX_OUTPUT,
      },
      "Sprite command failed",
    );
  }

  /**
   * The environment every command this provider runs for a tenant starts in.
   *
   * `PATH` leads with the shims and then the Computer's own `bin`: a command
   * that reaches for `chromium` or `xdotool` by name finds the refusal, and
   * the browser launcher is still reachable by name.
   * That is policy, not a boundary — the real binaries are still on the box,
   * one absolute path away — and it is stated as policy in `browser.md` and in
   * the refusal itself.
   *
   * The Bot's working directory stays its own private workspace; the shared
   * scratch is named in the environment rather than entered, because a default
   * cwd every Bot of a User shares is a default cwd where files collide.
   */
  private tenantEnvironment(layout: AgentLayout): string[] {
    return [
      `export HOME=${HOME_ROOT}`,
      `export PATH=${SHIMS_ROOT}:${BIN_ROOT}:$PATH`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `export ${SCRATCH_ENV}=${SCRATCH_ROOT}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
    ];
  }

  /**
   * Prefixes every command this provider runs for a tenant: the human-control
   * assertion, and the registry's `last-seen` stamp.
   *
   * The stamp is what keeps an exec-only tenant's desktop slot: it never opens
   * a viewer and never holds an X lock, so without it the slot reclaim would
   * be free to hand its display to another Bot mid-run.
   */
  private agentControlGuard(layout: AgentLayout): string {
    return [
      `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(this.ownerId)} ${LEASE_MAX_AGE_SECONDS} || exit $?`,
      this.tenantStamp(layout),
    ].join("\n");
  }

  /** The registry's `last-seen` stamp, without the control assertion. */
  private tenantStamp(layout: AgentLayout): string {
    const bot = shellQuote(`${BOTS_ROOT}/${layout.key}`);
    return `mkdir -p ${bot} && touch ${bot}/last-seen`;
  }

  /**
   * Runs one script and refuses a non-zero exit.
   *
   * A non-zero exit here is the outer document's, not the Bot's command's: the
   * control guard, a missing directory, an unreadable file. Those are failures
   * of the operation the caller asked for, so they throw with the label the
   * caller named, exactly as the SDK's own rejection used to.
   */
  private async execute(
    host: ComputerHostSurfaceV1,
    script: string,
    options: {
      signal?: AbortSignal;
      effectId?: string;
      timeoutMs: number;
      maxOutputBytes: number;
    },
    label: string,
  ): Promise<ComputerHostExecOutcomeV1> {
    let outcome: ComputerHostExecOutcomeV1;
    try {
      outcome = await host.exec(
        {
          script,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.effectId ? { effectId: options.effectId } : {}),
        },
      );
    } catch (error) {
      if (error instanceof ComputerError) throw error;
      throw new Error(`${label}: ${errorText(error)}`);
    }
    if (outcome.exitCode !== 0) {
      const detail =
        outputText(outcome.stderr).trim() ||
        outputText(outcome.stdout).trim() ||
        `exit ${String(outcome.exitCode)}`;
      throw new Error(`${label}: ${detail}`);
    }
    return outcome;
  }
}
