import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFoundationTrustedDesktopContribution } from "@frockbot/application-foundation/desktop";
import { compileFoundationApplicationDeclarations } from "@frockbot/application-foundation/runtime";
import { type Context, Context as CordisContext, Service } from "cordis";
import { app, BrowserWindow } from "electron";
import {
  ElectronDesktopAuthCapability,
  prepareElectronDesktopAuthRuntime,
} from "./auth-client.js";
import { startHostedDesktopApplication } from "./hosted-application.js";

interface DesktopWindowConfig {
  baseUrl: string;
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
      backgroundColor: "#faf7f2",
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

export async function createCordisDesktopHost(): Promise<Context> {
  const declarations = compileFoundationApplicationDeclarations();
  const authContribution = resolveFoundationTrustedDesktopContribution(
    declarations,
    "auth",
  );
  const authRuntime = prepareElectronDesktopAuthRuntime();
  return startHostedDesktopApplication(
    process.env.FROCKBOT_APPLICATION_URL,
    process.env.FROCKBOT_AUTH_BASE_URL,
    async ({ applicationUrl }) => {
      const root = new CordisContext();
      try {
        await root.plugin(ElectronDesktopAuthCapability, authRuntime);
        await root.plugin(authContribution.plugin);
        await root.plugin(DesktopWindowService, { baseUrl: applicationUrl });
        return root;
      } catch (error) {
        await root.fiber.dispose();
        throw error;
      }
    },
  );
}
