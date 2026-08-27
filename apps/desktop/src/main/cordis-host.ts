import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Server from "@cordisjs/plugin-server";
import WebUI from "@cordisjs/plugin-webui";
import {
  LocalCordisContributionHost,
  PackageCatalog,
  PassiveContributionHost,
} from "@frockbot/plugin-catalog";
import { clockManifest } from "@frockbot/plugin-clock";
import flySpriteManifest from "@frockbot/plugin-fly-sprite/manifest";
import {
  type Context,
  Context as CordisContext,
  type Plugin,
  Service,
} from "cordis";
import { app, BrowserWindow } from "electron";
import { webChatPlugin } from "./web-chat.js";

interface DesktopWindowConfig {
  baseUrl: string;
  credential?: string;
}

declare module "cordis" {
  interface Context {
    desktopWindows: DesktopWindowService;
  }
}

class DesktopWindowService extends Service {
  private config: DesktopWindowConfig;
  private windows = new Set<BrowserWindow>();

  constructor(ctx: Context, config: DesktopWindowConfig) {
    super(ctx, "desktopWindows");
    this.config = config;
  }

  async create(): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      title: "FrockBot",
      width: 1351,
      height: 859,
      minWidth: 980,
      minHeight: 620,
      backgroundColor: "#050505",
      show: false,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      webPreferences: {
        preload: fileURLToPath(
          new URL("../preload/index.mjs", import.meta.url),
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.windows.add(window);
    window.once("closed", () => this.windows.delete(window));
    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      try {
        const allowedOrigin = new URL(this.config.baseUrl).origin;
        if (new URL(url).origin !== allowedOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    if (this.config.credential) {
      await window.webContents.session.cookies.set({
        url: this.config.baseUrl,
        name: "frockbot_session",
        value: this.config.credential,
        httpOnly: true,
        sameSite: "strict",
      });
    }
    await window.loadURL(this.config.baseUrl);
    if (process.env.FROCKBOT_SMOKE_SCREENSHOT) void this.captureSmoke(window);
    return window;
  }

  [Service.init](): () => void {
    return () => {
      for (const window of this.windows) window.destroy();
      this.windows.clear();
    };
  }

  private async captureSmoke(window: BrowserWindow): Promise<void> {
    const screenshotPath = process.env.FROCKBOT_SMOKE_SCREENSHOT;
    if (!screenshotPath) return;
    const prompt = process.env.FROCKBOT_SMOKE_PROMPT;
    const expandComputer = process.env.FROCKBOT_SMOKE_EXPAND_COMPUTER === "1";
    await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const check = () => {
          const shell = document.querySelector('.app-shell');
          const composer = document.querySelector('.composer textarea');
          const computer = document.querySelector('.sprite-computer');
          const styled = shell instanceof HTMLElement && getComputedStyle(shell).display === 'grid';
          if (styled && computer && composer instanceof HTMLTextAreaElement && !composer.disabled) return resolve(true);
          if (Date.now() > deadline) return reject(new Error('FrockBot WebUI did not become ready'));
          setTimeout(check, 25);
        };
        check();
      })
    `);
    if (prompt) {
      await window.webContents.executeJavaScript(`
        (() => {
          const textarea = document.querySelector('.composer textarea');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Smoke composer not found');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(textarea, ${JSON.stringify(prompt)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.form?.requestSubmit();
        })()
      `);
      await window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const check = () => {
            const assistant = document.querySelector('.message-assistant .message-bubble');
            if (assistant?.textContent?.trim() && !document.querySelector('.stop-button')) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('FrockBot WebUI prompt did not settle'));
            setTimeout(check, 25);
          };
          check();
        })
      `);
    }
    if (expandComputer) {
      await window.webContents.executeJavaScript(`
        (() => {
          const computer = document.querySelector('.sprite-screen-thumbnail');
          if (!(computer instanceof HTMLElement)) throw new Error('Computer preview not found');
          computer.click();
        })()
      `);
      await window.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            const overlay = document.querySelector('.sprite-computer-overlay');
            const bounds = overlay instanceof HTMLElement ? overlay.getBoundingClientRect() : undefined;
            const coversWindow = bounds && bounds.width >= innerWidth && bounds.height >= innerHeight;
            if (overlay instanceof HTMLElement && getComputedStyle(overlay).position === 'fixed' && coversWindow) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('Computer overlay did not open'));
            setTimeout(check, 25);
          };
          check();
        })
      `);
    }
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))",
    );
    const absolutePath = resolve(screenshotPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const [image, html] = await Promise.all([
      window.webContents.capturePage(),
      window.webContents.executeJavaScript(
        "document.documentElement.outerHTML",
      ),
    ]);
    await Promise.all([
      writeFile(absolutePath, image.toPNG()),
      writeFile(`${absolutePath}.html`, String(html)),
    ]);
    app.quit();
  }
}

function createAdmissionPlugin(
  baseUrl: string,
  credential: string,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const hasCredential = (cookies: string | null) =>
      (cookies ?? "").split(/;\s*/).includes(`frockbot_session=${credential}`);
    const httpAdmission = ctx.server.use(async (request, response, next) => {
      response.headers.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self' 'sha256-Vy96PtZRI7fYqJ2gNVKETLELTSMNWTVyT22r0v1TlLQ='; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; frame-src https://*.sprites.app",
      );
      const origin = request.headers.get("origin");
      if (origin && origin !== baseUrl) {
        response.status = 403;
        return;
      }
      if (!hasCredential(request.headers.get("cookie"))) {
        response.status = 401;
        return;
      }
      await next();
    });
    const socketAdmission = ctx.on("server/route-check", (request) => {
      if (request.path !== "/api") return;
      if (request.headers.get("origin") !== baseUrl) return true;
      if (!hasCredential(request.headers.get("cookie"))) return true;
    });
    return [httpAdmission, socketAdmission];
  };
  plugin.inject = ["server"];
  return plugin;
}

export async function createCordisDesktopHost(): Promise<Context> {
  const root = new CordisContext();
  const applicationUrl = process.env.FROCKBOT_APPLICATION_URL?.trim();
  if (applicationUrl) {
    let protocol: string;
    try {
      protocol = new URL(applicationUrl).protocol;
    } catch {
      throw new Error("FROCKBOT_APPLICATION_URL must be a valid URL");
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("FROCKBOT_APPLICATION_URL must use HTTP or HTTPS");
    }
    await root.plugin(DesktopWindowService, { baseUrl: applicationUrl });
    await root.desktopWindows.create();
    return root;
  }

  await root.plugin(Server, { host: "127.0.0.1", port: 0, maxPort: 0 });
  const baseUrl = root.server.baseUrl;
  const credential = randomUUID();
  await root.plugin(createAdmissionPlugin(baseUrl, credential));
  await root.plugin(WebUI, {
    uiPath: "",
    apiPath: "/api",
    selfUrl: "",
    devMode: false,
    open: false,
  });
  await root.plugin(PackageCatalog, { kinds: ["desktop", "web"] });
  root.packages.registerHost(
    new LocalCordisContributionHost(
      "desktop",
      root,
      (specifier: string) => import(specifier),
    ),
  );
  root.packages.registerHost(new PassiveContributionHost("web"));
  root.packages.install({
    specifier: "@frockbot/plugin-clock",
    manifest: clockManifest,
  });
  root.packages.install({
    specifier: "@frockbot/plugin-fly-sprite",
    manifest: flySpriteManifest,
  });
  await root.packages.enable("clock");
  await root.packages.enable("fly-sprite");
  await root.plugin(webChatPlugin);
  await root.plugin(DesktopWindowService, { baseUrl, credential });
  await root.desktopWindows.create();
  return root;
}
