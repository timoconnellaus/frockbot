import { createHash, randomUUID } from "node:crypto";
import { ComputerError } from "@frockbot/computer-core";
import type {
  ComputerHostControlResultV1,
  ComputerHostOpenResultV1,
  ComputerHostViewerResultV1,
} from "@frockbot/computer-host-protocol";
import {
  BOTS_ROOT,
  CONTROL_SCRIPT,
  DATA_ROOT,
  HOME_ROOT,
  LEASE_MAX_AGE_SECONDS,
  NO_SLOTS_MARKER,
  RUNTIME_ROOT,
  shellQuote,
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

/** Deadlines this provider asks the host for, per phase. */
const TIMEOUTS = {
  /** Provisioning apt-installs a desktop stack on a cold Computer. */
  open: 10 * 60_000,
  command: 120_000,
  browser: 45_000,
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
  control(
    action: "acquire" | "renew" | "release",
    ownerId: string,
    maxAgeSeconds: number,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostControlResultV1>;
  viewer(
    action: "open" | "revoke",
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
  /** The tenant's X display on the shared Computer, e.g. `:100`. */
  display: string;
  /** The tenant's durable directory, relative to the Workspace home. */
  directory: string;
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

  /** Opens a viewer session on this tenant's desktop. */
  viewer(signal?: AbortSignal): Promise<ComputerHostViewerResultV1> {
    return this.computer.viewerForAgent(this.layout, "open", signal);
  }

  revokeViewer(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ComputerHostViewerResultV1> {
    return this.computer.viewerForAgent(
      this.layout,
      "revoke",
      signal,
      sessionId,
    );
  }

  takeControl(signal?: AbortSignal): Promise<ComputerHostControlResultV1> {
    return this.computer.control(this.layout, "acquire", signal);
  }

  refreshControl(signal?: AbortSignal): Promise<ComputerHostControlResultV1> {
    return this.computer.control(this.layout, "renew", signal);
  }

  releaseControl(signal?: AbortSignal): Promise<void> {
    return this.computer.releaseForAgent(this.layout, signal);
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
      promise = this.openAgent(layout, signal).catch((error: unknown) => {
        this.agentPromises.delete(layout.key);
        throw error;
      });
      this.agentPromises.set(layout.key, promise);
    }
    return promise;
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
  ): Promise<ComputerHostControlResultV1> {
    return this.hostFor(layout).control(
      action,
      this.ownerId,
      LEASE_MAX_AGE_SECONDS,
      { signal, timeoutMs: TIMEOUTS.control },
    );
  }

  async releaseForAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.host) return;
    try {
      await this.hostFor(layout).control(
        "release",
        this.ownerId,
        LEASE_MAX_AGE_SECONDS,
        { signal, timeoutMs: TIMEOUTS.control },
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
    action: "open" | "revoke",
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<ComputerHostViewerResultV1> {
    return this.hostFor(layout).viewer(action, {
      signal,
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
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    const host = this.hostFor(layout);
    let opened: ComputerHostOpenResultV1;
    try {
      opened = await host.open({ signal, timeoutMs: TIMEOUTS.open });
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
      await this.assertAgentControl(host, layout, signal);
    }
    const viewer = await host.viewer("open", {
      signal,
      timeoutMs: TIMEOUTS.viewer,
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
      display: opened.display ?? "",
      directory: `agent-data/agents/${layout.key}`,
    };
  }

  private async assertAgentControl(
    host: ComputerHostSurfaceV1,
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.execute(
      host,
      `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(
        this.ownerId,
      )} ${LEASE_MAX_AGE_SECONDS}\n`,
      { signal, timeoutMs: TIMEOUTS.control, maxOutputBytes: MAX_OUTPUT },
      "Sprite command failed",
    );
  }

  private tenantEnvironment(layout: AgentLayout): string[] {
    return [
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
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
    const bot = shellQuote(`${BOTS_ROOT}/${layout.key}`);
    return [
      `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(this.ownerId)} ${LEASE_MAX_AGE_SECONDS} || exit $?`,
      `mkdir -p ${bot} && touch ${bot}/last-seen`,
    ].join("\n");
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
        options.signal ? { signal: options.signal } : {},
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
