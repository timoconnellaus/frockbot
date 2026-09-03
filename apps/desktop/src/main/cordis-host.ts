import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFoundationTrustedDesktopContribution } from "@frockbot/application-foundation/desktop";
import { compileFoundationApplicationDeclarations } from "@frockbot/application-foundation/runtime";
import { DesktopCommandRegistry } from "@frockbot/desktop-core";
import { type Context, Context as CordisContext, Service } from "cordis";
import { app, BrowserWindow, ipcMain, type Session } from "electron";
import {
  ElectronDesktopAuthCapability,
  prepareElectronDesktopAuthRuntime,
} from "./auth-client.js";
import { installMachineCapabilities } from "./desktop-capabilities.js";
import { createMachineMessagesDeviceRunnerV1 } from "@frockbot/plugin-machine-messages/device";
import { startHostedDesktopApplication } from "./hosted-application.js";
import {
  createMachineBridgeHandlerV1,
  MACHINE_CHANNEL,
} from "./machine-bridge.js";

interface DesktopWindowConfig {
  baseUrl: string;
  prepareSession?(session: Session): Promise<void>;
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
      backgroundColor: "#1f1e24",
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
    await this.config.prepareSession?.(window.webContents.session);
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
  // The device agent for row 48: the registered machine is this app.
  const machineContribution = resolveFoundationTrustedDesktopContribution(
    declarations,
    "user-machine",
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
        await root.plugin(DesktopCommandRegistry);
        await installMachineCapabilities(root);
        await root.plugin(machineContribution.plugin, {
          origin: applicationUrl,
          agentVersion: app.getVersion(),
          // Row 57g's handlers, handed to the agent rather than reached for by
          // it: the agent reports the `messages` capability only when it has
          // these *and* it is running on a Mac, so a Linux build never claims
          // a capability whose second gate it could not pass.
          messages: createMachineMessagesDeviceRunnerV1({
            seam: root.desktopMessages,
          }),
        });
        // The settings section reaches the agent over one channel, and only
        // from the hosted application's own origin. Registered as a plugin so
        // the handler is removed by the same disposal that stops the agent.
        await root.plugin((ctx) => {
          const handle = createMachineBridgeHandlerV1(ctx, applicationUrl);
          ipcMain.handle(MACHINE_CHANNEL, (event, value: unknown) =>
            handle(event.senderFrame?.url, value),
          );
          return () => ipcMain.removeHandler(MACHINE_CHANNEL);
        });
        await root.plugin(DesktopWindowService, {
          baseUrl: applicationUrl,
          prepareSession: (session) =>
            authRuntime.prepareRendererSession(session),
        });
        return root;
      } catch (error) {
        await root.fiber.dispose();
        throw error;
      }
    },
  );
}
