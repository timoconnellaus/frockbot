import type { Context } from "cordis";
import { app, BrowserWindow } from "electron";
import { createCordisDesktopHost } from "./cordis-host.js";

let host: Context | undefined;
let disposing = false;

app.setName("FrockBot");

void app.whenReady().then(
  async () => {
    host = await createCordisDesktopHost();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void host?.desktopWindows.create();
      }
    });
  },
  (error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.quit();
  },
);

app.on("before-quit", (event) => {
  if (!host || disposing) return;
  event.preventDefault();
  disposing = true;
  void host.fiber.dispose().finally(() => {
    host = undefined;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
