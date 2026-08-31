import { createHash, randomUUID } from "node:crypto";
import { APIError, SpritesClient } from "@fly/sprites";
import {
  base64,
  BOTS_ROOT,
  CONTROL_SCRIPT,
  DATA_ROOT,
  DESKTOP_SERVICE,
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
  LEASE_MAX_AGE_SECONDS,
  NO_SLOTS_MARKER,
  provisionScript,
  RUNTIME_ROOT,
  shellQuote,
  SLOT_IDLE_SECONDS,
  WORKSPACE_SYNC_SERVICE,
  WORKSPACES_ROOT,
} from "@frockbot/computer-host-runtime";
import { ComputerError } from "@frockbot/computer-core";

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
  profileJson: string;
}

export interface SpriteExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export interface SpriteAgentExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface SpriteServiceStream extends AsyncIterable<unknown> {}

export interface SpriteHandle {
  name: string;
  url?: string;
  execFileHTTP(
    file: string,
    args?: string[],
    options?: { signal?: AbortSignal; timeout?: number; maxBuffer?: number },
  ): Promise<SpriteExecResult>;
  createService(
    name: string,
    config: {
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
      dir?: string;
      httpPort?: number;
    },
    duration?: string,
  ): Promise<SpriteServiceStream>;
  updateURLSettings(settings: { auth: string }): Promise<void>;
}

export interface SpritesClientHandle {
  listAllSprites(prefix?: string): Promise<SpriteHandle[]>;
  createSprite(name: string): Promise<SpriteHandle>;
  getSprite(name: string): Promise<SpriteHandle>;
}

export interface FlySpriteComputerOptions {
  token?: string;
  spriteName?: string;
  client?: SpritesClientHandle;
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

function configuredToken(): string | undefined {
  return process.env.SPRITES_TOKEN?.trim() || process.env.SPRITE_TOKEN?.trim();
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
  const name = identity.name ?? identity.id;
  const profileJson = JSON.stringify(
    {
      id: identity.id,
      name,
      description: identity.description ?? "FrockBot Bot",
      computer: { botKey: key, sharedHome: HOME_ROOT },
    },
    null,
    2,
  );
  return {
    identity,
    key,
    runtimeDir: `${BOTS_ROOT}/${key}`,
    workspaceDir: `${WORKSPACES_ROOT}/${key}`,
    profileJson,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString();
}

function clipped(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… output truncated`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 404;
}

async function settleService(
  stream: SpriteServiceStream,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of stream) {
    signal?.throwIfAborted();
    if (typeof event !== "object" || event === null) continue;
    const serviceEvent = event as {
      type?: unknown;
      data?: unknown;
      exitCode?: unknown;
    };
    if (serviceEvent.type === "error") {
      throw new Error(
        `${label} failed: ${String(serviceEvent.data ?? "unknown error")}`,
      );
    }
    if (
      serviceEvent.type === "exit" &&
      typeof serviceEvent.exitCode === "number" &&
      serviceEvent.exitCode !== 0
    ) {
      throw new Error(`${label} exited with code ${serviceEvent.exitCode}`);
    }
  }
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

  takeControl(signal?: AbortSignal): Promise<void> {
    return this.computer.control(this.layout, "acquire", signal);
  }

  refreshControl(signal?: AbortSignal): Promise<void> {
    return this.computer.control(this.layout, "renew", signal);
  }

  releaseControl(signal?: AbortSignal): Promise<void> {
    return this.computer.releaseForAgent(this.layout, signal);
  }
}

export class FlySpriteComputer {
  readonly spriteName: string;
  readonly configured: boolean;
  private readonly client?: SpritesClientHandle;
  private readonly ownerId = randomUUID();
  private readonly respectHumanControl: boolean;
  private runtimePromise?: Promise<SpriteHandle>;
  private readonly agentPromises = new Map<
    string,
    Promise<ComputerConnection>
  >();
  private readonly storagePromises = new Map<string, Promise<SpriteHandle>>();
  private readonly displays = new Map<string, string>();

  constructor(options: FlySpriteComputerOptions = {}) {
    const token = options.token?.trim() || configuredToken();
    this.spriteName = options.spriteName ?? configuredName();
    this.client =
      options.client ?? (token ? new SpritesClient(token) : undefined);
    this.configured = Boolean(this.client);
    this.respectHumanControl = options.respectHumanControl ?? true;
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

  async ensureAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    if (!this.client) {
      throw new Error("Set SPRITES_TOKEN to attach a Fly Sprite computer");
    }
    let promise = this.agentPromises.get(layout.key);
    if (!promise) {
      promise = this.provisionAgent(layout, signal).catch((error) => {
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
    const sprite = await this.readySprite(layout, signal);
    const guarded = [
      this.agentControlGuard(layout),
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      command,
    ].join("\n");
    try {
      const result = await sprite.execFileHTTP("bash", ["-c", guarded], {
        signal,
        timeout: 120_000,
        maxBuffer: MAX_OUTPUT * 2,
      });
      return clipped(
        [outputText(result.stdout), outputText(result.stderr)]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      throw new Error(`Sprite command failed: ${errorText(error)}`);
    }
  }

  async execForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
    limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<SpriteAgentExecResult> {
    const sprite = await this.readySprite(layout, signal);
    const guarded = [
      this.agentControlGuard(layout),
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      `bash -c ${shellQuote(command)}`,
      `printf '\\n%s%s\\n' ${shellQuote(EXEC_EXIT_MARKER)} "$?"`,
    ].join("\n");
    const maxOutput = Math.max(
      1,
      Math.min(limits.maxOutputBytes ?? MAX_OUTPUT, MAX_OUTPUT),
    );
    let result: SpriteExecResult;
    try {
      result = await sprite.execFileHTTP("bash", ["-c", guarded], {
        signal,
        timeout: Math.max(1, Math.min(limits.timeoutMs ?? 120_000, 120_000)),
        maxBuffer: MAX_OUTPUT * 2,
      });
    } catch (error) {
      throw new Error(`Sprite command failed: ${errorText(error)}`);
    }
    const raw = outputText(result.stdout);
    const match = new RegExp(`\\n?${EXEC_EXIT_MARKER}(\\d+)\\n?$`).exec(raw);
    const stdout = match ? raw.slice(0, match.index) : raw;
    const stderr = outputText(result.stderr);
    return {
      exitCode: match ? Number(match[1]) : null,
      stdout: stdout.slice(0, maxOutput),
      stderr: stderr.slice(0, maxOutput),
      outputTruncated:
        !match || stdout.length > maxOutput || stderr.length > maxOutput,
    };
  }

  async runStorageForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sprite = await this.readyStorageSprite(layout, signal);
    const storageCommand = [
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      command,
    ].join("\n");
    let result: SpriteExecResult;
    try {
      result = await sprite.execFileHTTP("bash", ["-c", storageCommand], {
        signal,
        timeout: 120_000,
        maxBuffer: MAX_STORAGE_OUTPUT * 2,
      });
    } catch (error) {
      throw new Error(`Sprite storage operation failed: ${errorText(error)}`);
    }
    const stdout = outputText(result.stdout);
    if (stdout.length > MAX_STORAGE_OUTPUT) {
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
    const sprite = await this.readySprite(layout, signal);
    const encoded = Buffer.from(JSON.stringify(action)).toString("base64url");
    const command = [
      this.agentControlGuard(layout),
      `PORT=$(cat ${layout.runtimeDir}/cdp-port)`,
      `node ${RUNTIME_ROOT}/browser.mjs "$PORT" ${shellQuote(encoded)}`,
    ].join("\n");
    try {
      const result = await sprite.execFileHTTP("bash", ["-c", command], {
        signal,
        timeout: 45_000,
        maxBuffer: MAX_OUTPUT * 2,
      });
      return clipped(
        outputText(result.stdout).trim() || outputText(result.stderr).trim(),
      );
    } catch (error) {
      throw new Error(`Sprite browser action failed: ${errorText(error)}`);
    }
  }

  async control(
    layout: AgentLayout,
    action: "acquire" | "renew",
    signal?: AbortSignal,
  ): Promise<void> {
    const sprite = await this.readySprite(layout, signal);
    await sprite.execFileHTTP(
      CONTROL_SCRIPT,
      [action, layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
  }

  async releaseForAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.client) return;
    let sprite: SpriteHandle;
    try {
      sprite = await this.client.getSprite(this.spriteName);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await sprite.execFileHTTP(
      CONTROL_SCRIPT,
      ["release", layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
  }

  private async provisionRuntime(signal?: AbortSignal): Promise<SpriteHandle> {
    signal?.throwIfAborted();
    const sprite = await this.findOrCreate();
    await sprite.execFileHTTP("bash", ["-lc", provisionScript], {
      signal,
      timeout: 10 * 60_000,
      maxBuffer: MAX_OUTPUT * 2,
    });
    const stream = await sprite.createService(
      DESKTOP_SERVICE,
      { cmd: `${RUNTIME_ROOT}/start-gateway.sh`, httpPort: 6080 },
      "30s",
    );
    await settleService(stream, "Desktop gateway", signal);
    // The durable-root sync's watcher is a declared service, so a cold pause
    // ends with it running again rather than with a silently stopped process.
    const sync = await sprite.createService(WORKSPACE_SYNC_SERVICE, {
      cmd: `${RUNTIME_ROOT}/watch-workspace.sh`,
    });
    await settleService(sync, "Workspace sync watcher", signal);
    await sprite.updateURLSettings({ auth: "public" });
    return sprite;
  }

  private async provisionAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    const sprite = await this.runtime(signal);
    if (this.respectHumanControl)
      await this.assertAgentControl(sprite, layout, signal);
    // Every display belonging to a tenant this provider still has open is a
    // declared outcome, not a crash: the alternative would be two Bots sharing
    // one screen, and Bots are separated on a Computer exactly so that does
    // not happen silently.
    const refused = (cause: unknown) =>
      new ComputerError(
        "capability-unavailable",
        `Every desktop on this Computer is in use; Bot "${layout.identity.id}" has no display until one is idle`,
        true,
        { cause },
      );
    let ensured: SpriteExecResult;
    try {
      ensured = await sprite.execFileHTTP(
        ENSURE_AGENT_SCRIPT,
        [layout.key, base64(layout.profileJson)],
        { signal, timeout: 60_000, maxBuffer: MAX_OUTPUT * 2 },
      );
    } catch (error) {
      if (
        errorText(error).includes(NO_SLOTS_MARKER) ||
        errorText(error).includes("no desktop slots available")
      ) {
        throw refused(error);
      }
      throw error;
    }
    if (outputText(ensured.stdout).includes(NO_SLOTS_MARKER)) {
      throw refused(undefined);
    }
    if (this.respectHumanControl) {
      await this.assertAgentControl(sprite, layout, signal);
    }
    const desktop = await sprite.createService(
      `frockbot-desktop-${layout.key}`,
      { cmd: `${RUNTIME_ROOT}/start-desktop.sh`, args: [layout.key] },
      "30s",
    );
    await settleService(desktop, `Desktop for ${layout.identity.id}`, signal);
    const current = await this.client?.getSprite(this.spriteName);
    const url = current?.url ?? sprite.url;
    if (!url) throw new Error("Sprites API did not return a computer URL");
    const [password, token, slot] = await Promise.all([
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/vnc-password`], {
        signal,
        timeout: 15_000,
      }),
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/viewer-token`], {
        signal,
        timeout: 15_000,
      }),
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/slot`], {
        signal,
        timeout: 15_000,
      }),
    ]);
    const display = `:${100 + Number(outputText(slot.stdout).trim() || 0)}`;
    this.displays.set(layout.key, display);
    const viewer = new URL("vnc.html", url.endsWith("/") ? url : `${url}/`);
    viewer.hash = new URLSearchParams({
      autoconnect: "1",
      reconnect: "1",
      resize: "scale",
      path: `websockify?token=${outputText(token.stdout).trim()}`,
      password: outputText(password.stdout).trim(),
    }).toString();
    return {
      botId: layout.identity.id,
      botKey: layout.key,
      spriteName: this.spriteName,
      viewerUrl: viewer.toString(),
      display,
      directory: `agent-data/agents/${layout.key}`,
    };
  }

  private runtime(signal?: AbortSignal): Promise<SpriteHandle> {
    if (!this.client) {
      return Promise.reject(
        new Error("Set SPRITES_TOKEN to attach a Fly Sprite computer"),
      );
    }
    if (!this.runtimePromise) {
      this.runtimePromise = this.provisionRuntime(signal).catch((error) => {
        this.runtimePromise = undefined;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  private async readySprite(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    await this.ensureAgent(layout, signal);
    if (!this.client) throw new Error("Sprites client is unavailable");
    return this.client.getSprite(this.spriteName);
  }

  private readyStorageSprite(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    signal?.throwIfAborted();
    let promise = this.storagePromises.get(layout.key);
    if (!promise) {
      promise = this.provisionStorage(layout, signal).catch((error) => {
        this.storagePromises.delete(layout.key);
        throw error;
      });
      this.storagePromises.set(layout.key, promise);
    }
    return promise;
  }

  private async provisionStorage(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    const sprite = await this.findOrCreate();
    await sprite.execFileHTTP(
      "mkdir",
      [
        "-p",
        layout.workspaceDir,
        `${DATA_ROOT}/agents/${layout.key}/memory`,
        `${DATA_ROOT}/agents/${layout.key}/skills`,
        `${DATA_ROOT}/user-memory`,
        `${DATA_ROOT}/user-packages`,
        `${RUNTIME_ROOT}/sync`,
      ],
      { signal, timeout: 15_000, maxBuffer: MAX_OUTPUT },
    );
    return sprite;
  }

  private assertAgentControl(
    sprite: SpriteHandle,
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteExecResult> {
    return sprite.execFileHTTP(
      CONTROL_SCRIPT,
      ["assert-agent", layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
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

  private async findOrCreate(): Promise<SpriteHandle> {
    if (!this.client) throw new Error("Sprites client is unavailable");
    const existing = (await this.client.listAllSprites(this.spriteName)).find(
      (sprite) => sprite.name === this.spriteName,
    );
    if (existing) return existing;
    try {
      return await this.client.createSprite(this.spriteName);
    } catch (error) {
      try {
        return await this.client.getSprite(this.spriteName);
      } catch {
        throw error;
      }
    }
  }
}
