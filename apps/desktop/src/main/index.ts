import type { Context } from "cordis";
import { app, BrowserWindow } from "electron";
import { setDevelopmentAppIcon } from "./app-icon.js";
import { createCordisDesktopHost } from "./cordis-host.js";

let host: Context | undefined;
let disposing = false;

app.setName("FrockBot");

const hostPromise = createCordisDesktopHost();

void hostPromise
  .then(async (createdHost) => {
    host = createdHost;
    await app.whenReady();
    setDevelopmentAppIcon(app);
    await host.desktopWindows.create();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void host?.desktopWindows.create();
      }
    });
  })
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.quit();
  });

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
