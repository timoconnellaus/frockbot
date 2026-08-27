import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  IPC_CHANNELS,
  isPromptRequest,
  type AgentEvent,
} from "@frockbot/protocol";
import { AgentProcess } from "./agent-process.js";

let agentProcess: AgentProcess | undefined;
let latestWorkerStatus: AgentEvent | undefined;
const loadedWindows = new WeakSet<BrowserWindow>();
const capturedWindows = new WeakSet<BrowserWindow>();
let smokePromptSent = false;
let smokeRunFinished = false;

async function captureSmoke(window: BrowserWindow): Promise<void> {
  const screenshotPath = process.env.FROCKBOT_SMOKE_SCREENSHOT;
  if (
    !screenshotPath ||
    !latestWorkerStatus ||
    !loadedWindows.has(window) ||
    capturedWindows.has(window)
  ) {
    return;
  }

  const smokePrompt = process.env.FROCKBOT_SMOKE_PROMPT;
  if (
    smokePrompt &&
    latestWorkerStatus.type === "worker-ready" &&
    !smokePromptSent
  ) {
    smokePromptSent = true;
    await window.webContents.executeJavaScript(`
      (async () => {
        const textarea = document.querySelector('.composer textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Smoke composer not found');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, ${JSON.stringify(smokePrompt)});
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        textarea.form?.requestSubmit();
      })()
    `);
    return;
  }
  if (
    smokePrompt &&
    latestWorkerStatus.type === "worker-ready" &&
    !smokeRunFinished
  )
    return;

  capturedWindows.add(window);
  const absolutePath = resolve(screenshotPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await window.webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const image = await window.webContents.capturePage();
  const html = await window.webContents.executeJavaScript(
    "document.documentElement.outerHTML",
  );
  await Promise.all([
    writeFile(absolutePath, image.toPNG()),
    writeFile(`${absolutePath}.html`, String(html)),
  ]);
  app.quit();
}

function broadcast(event: AgentEvent): void {
  if (
    event.type === "settled" ||
    (event.type === "error" && event.phase === "run")
  ) {
    smokeRunFinished = true;
  }
  if (
    event.type === "worker-ready" ||
    event.type === "worker-exit" ||
    (event.type === "error" && event.phase === "startup")
  ) {
    latestWorkerStatus = event;
  }
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
    void captureSmoke(window);
  }
}

function registerAgentIPC(): void {
  ipcMain.handle(IPC_CHANNELS.prompt, (_event, request: unknown) => {
    if (!isPromptRequest(request))
      return { accepted: false, error: "Prompt is empty or malformed" };
    return (
      agentProcess?.prompt(request) ?? {
        accepted: false,
        error: "Pi worker is unavailable",
      }
    );
  });
  ipcMain.handle(IPC_CHANNELS.abort, (_event, runId: unknown) => {
    if (typeof runId === "string") agentProcess?.abort(runId);
  });
  ipcMain.handle(IPC_CHANNELS.restart, () => agentProcess?.restart());
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: "FrockBot",
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#050505",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: app.isPackaged
        ? join(process.resourcesPath, "preload", "index.cjs")
        : join(app.getAppPath(), "resources", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("did-finish-load", () => {
    loadedWindows.add(window);
    if (latestWorkerStatus)
      window.webContents.send(IPC_CHANNELS.event, latestWorkerStatus);
    void captureSmoke(window);
  });
  window.once("ready-to-show", () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
}

app.setName("FrockBot");

app.whenReady().then(() => {
  registerAgentIPC();
  createWindow();
  agentProcess = new AgentProcess(broadcast);
  agentProcess.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => agentProcess?.dispose());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
