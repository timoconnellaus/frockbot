import { randomUUID } from "node:crypto";
import { APIError, SpritesClient } from "@fly/sprites";

const DESKTOP_SERVICE = "frockbot-desktop";
const ROOT = "/home/sprite/.frockbot";
const LEASE = `${ROOT}/human-control`;
const MAX_OUTPUT = 30_000;
const LEASE_MAX_AGE_SECONDS = 90;

const desktopScript = `#!/usr/bin/env bash
set -eu
export DISPLAY=:99
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
for _ in $(seq 1 50); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.1; done
fluxbox >/tmp/frockbot-fluxbox.log 2>&1 &
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer --user-data-dir=${ROOT}/chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --start-maximized about:blank >/tmp/frockbot-chromium.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -passwd "$(cat ${ROOT}/vnc-password)" >/tmp/frockbot-x11vnc.log 2>&1 &
exec websockify --web=/usr/share/novnc 6080 localhost:5900
`;

const browserHelper = `import { chromium } from "playwright-core";
const action = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const context = browser.contexts()[0];
const pages = context.pages();
const page = pages.at(-1) ?? await context.newPage();
if (action.action === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded" });
if (action.action === "click") await page.getByRole(action.role, { name: action.name, exact: action.exact ?? false }).click();
if (action.action === "fill") await page.getByLabel(action.label, { exact: action.exact ?? false }).fill(action.text);
if (action.action === "press") await page.keyboard.press(action.key);
if (action.action === "wait") await page.waitForTimeout(action.milliseconds ?? 1000);
const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10000 });
console.log(JSON.stringify({ url: page.url(), title: await page.title(), snapshot }));
await browser.close();
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function base64(value: string): string {
  return Buffer.from(value).toString("base64");
}

const provisionScript = `set -eu
mkdir -p ${ROOT}
if ! command -v Xvfb >/dev/null || ! command -v chromium >/dev/null || ! command -v websockify >/dev/null; then
  if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi
  $SUDO apt-get update >/tmp/frockbot-provision.log 2>&1
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium xvfb fluxbox x11vnc novnc websockify x11-utils ca-certificates >>/tmp/frockbot-provision.log 2>&1
fi
if [ ! -s ${ROOT}/vnc-password ]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '\\n=+/' > ${ROOT}/vnc-password
fi
printf %s ${shellQuote(base64(desktopScript))} | base64 -d > ${ROOT}/start-desktop.sh
printf %s ${shellQuote(base64(browserHelper))} | base64 -d > ${ROOT}/browser.mjs
chmod 700 ${ROOT}/start-desktop.sh ${ROOT}/browser.mjs
if [ ! -d ${ROOT}/node_modules/playwright-core ]; then
  npm install --prefix ${ROOT} --no-audit --no-fund playwright-core@1.55.0 >>/tmp/frockbot-provision.log 2>&1
fi
`;

export interface SpriteExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
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
  spriteName: string;
  viewerUrl: string;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString();
}

function clipped(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… output truncated`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 404;
}

export class FlySpriteComputer {
  readonly spriteName: string;
  readonly configured: boolean;
  private readonly client?: SpritesClientHandle;
  private readonly ownerId = randomUUID();
  private readonly respectHumanControl: boolean;
  private ensurePromise?: Promise<ComputerConnection>;

  constructor(options: FlySpriteComputerOptions = {}) {
    const token = options.token?.trim() || configuredToken();
    this.spriteName = options.spriteName ?? configuredName();
    this.client =
      options.client ?? (token ? new SpritesClient(token) : undefined);
    this.configured = Boolean(this.client);
    this.respectHumanControl = options.respectHumanControl ?? false;
  }

  ensure(signal?: AbortSignal): Promise<ComputerConnection> {
    if (!this.client) {
      return Promise.reject(
        new Error("Set SPRITES_TOKEN to attach a Fly Sprite computer"),
      );
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.provision(signal).catch((error) => {
        this.ensurePromise = undefined;
        throw error;
      });
    }
    return this.ensurePromise;
  }

  async run(command: string, signal: AbortSignal): Promise<string> {
    const sprite = await this.readySprite(signal);
    const guarded = `${this.agentControlGuard()}\n${command}`;
    try {
      const result = await sprite.execFileHTTP("bash", ["-lc", guarded], {
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

  async browser(action: BrowserAction, signal: AbortSignal): Promise<string> {
    const sprite = await this.readySprite(signal);
    const encoded = Buffer.from(JSON.stringify(action)).toString("base64url");
    const command = `${this.agentControlGuard()}\nnode ${ROOT}/browser.mjs ${shellQuote(encoded)}`;
    try {
      const result = await sprite.execFileHTTP("bash", ["-lc", command], {
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

  async takeControl(signal?: AbortSignal): Promise<void> {
    const sprite = await this.readySprite(signal);
    const owner = shellQuote(this.ownerId);
    await sprite.execFileHTTP(
      "bash",
      [
        "-lc",
        `set -eu; mkdir -p ${ROOT}; if [ -e ${LEASE} ]; then existing=$(cat ${LEASE} 2>/dev/null || true); if [ "$existing" = ${owner} ]; then touch ${LEASE}; exit 0; fi; now=$(date +%s); changed=$(stat -c %Y ${LEASE}); age=$((now - changed)); if [ "$age" -le ${LEASE_MAX_AGE_SECONDS} ]; then echo "The computer is already under human control" >&2; exit 73; fi; rm -f ${LEASE}; fi; set -C; printf '%s\\n' ${owner} > ${LEASE}`,
      ],
      { signal, timeout: 15_000 },
    );
  }

  async refreshControl(signal?: AbortSignal): Promise<void> {
    const sprite = await this.readySprite(signal);
    await sprite.execFileHTTP(
      "bash",
      [
        "-lc",
        `set -eu; owner=$(cat ${LEASE} 2>/dev/null || true); [ "$owner" = ${shellQuote(this.ownerId)} ]; touch ${LEASE}`,
      ],
      { signal, timeout: 15_000 },
    );
  }

  async releaseControl(signal?: AbortSignal): Promise<void> {
    if (!this.client) return;
    let sprite: SpriteHandle;
    try {
      sprite = await this.client.getSprite(this.spriteName);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await sprite.execFileHTTP(
      "bash",
      [
        "-lc",
        `owner=$(cat ${LEASE} 2>/dev/null || true); if [ "$owner" = ${shellQuote(this.ownerId)} ]; then rm -f ${LEASE}; fi`,
      ],
      { signal, timeout: 15_000 },
    );
  }

  private async provision(signal?: AbortSignal): Promise<ComputerConnection> {
    signal?.throwIfAborted();
    const sprite = await this.findOrCreate();
    if (this.respectHumanControl) await this.assertAgentControl(sprite, signal);
    await sprite.execFileHTTP("bash", ["-lc", provisionScript], {
      signal,
      timeout: 10 * 60_000,
      maxBuffer: MAX_OUTPUT * 2,
    });
    if (this.respectHumanControl) await this.assertAgentControl(sprite, signal);
    const stream = await sprite.createService(
      DESKTOP_SERVICE,
      { cmd: `${ROOT}/start-desktop.sh`, httpPort: 6080 },
      "30s",
    );
    for await (const event of stream) {
      signal?.throwIfAborted();
      if (typeof event !== "object" || event === null) continue;
      // SAFETY: the preceding runtime object check permits reading optional
      // fields as unknown without assuming their values or full shape.
      const serviceEvent = event as {
        type?: unknown;
        data?: unknown;
        exitCode?: unknown;
      };
      if (serviceEvent.type === "error") {
        throw new Error(
          `Desktop service failed: ${String(serviceEvent.data ?? "unknown error")}`,
        );
      }
      if (
        serviceEvent.type === "exit" &&
        typeof serviceEvent.exitCode === "number" &&
        serviceEvent.exitCode !== 0
      ) {
        throw new Error(
          `Desktop service exited with code ${serviceEvent.exitCode}`,
        );
      }
    }
    await sprite.updateURLSettings({ auth: "public" });
    const current = await this.client?.getSprite(this.spriteName);
    const url = current?.url ?? sprite.url;
    if (!url) throw new Error("Sprites API did not return a computer URL");
    const password = await sprite.execFileHTTP(
      "cat",
      [`${ROOT}/vnc-password`],
      {
        signal,
        timeout: 15_000,
      },
    );
    const viewer = new URL("vnc.html", url.endsWith("/") ? url : `${url}/`);
    viewer.hash = new URLSearchParams({
      autoconnect: "1",
      reconnect: "1",
      resize: "scale",
      password: outputText(password.stdout).trim(),
    }).toString();
    return { spriteName: this.spriteName, viewerUrl: viewer.toString() };
  }

  private async readySprite(signal?: AbortSignal): Promise<SpriteHandle> {
    await this.ensure(signal);
    if (!this.client) throw new Error("Sprites client is unavailable");
    return this.client.getSprite(this.spriteName);
  }

  private async assertAgentControl(
    sprite: SpriteHandle,
    signal?: AbortSignal,
  ): Promise<void> {
    await sprite.execFileHTTP("bash", ["-lc", this.agentControlGuard()], {
      signal,
      timeout: 15_000,
    });
  }

  private agentControlGuard(): string {
    return `if [ -e ${LEASE} ]; then owner=$(cat ${LEASE} 2>/dev/null || true); if [ "$owner" != ${shellQuote(this.ownerId)} ]; then now=$(date +%s); changed=$(stat -c %Y ${LEASE}); age=$((now - changed)); if [ "$age" -le ${LEASE_MAX_AGE_SECONDS} ]; then echo "The user is controlling the computer" >&2; exit 73; fi; rm -f ${LEASE}; fi; fi`;
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
