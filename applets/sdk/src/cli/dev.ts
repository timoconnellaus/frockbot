/**
 * `applet dev` — the built Applet on a local port, ready to be opened and
 * screenshotted from the Computer's browser. It opens nothing itself.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readDescriptor } from "./manifest.js";
import { startAppletRuntime, type AppletRuntime } from "./runtime.js";

/**
 * In production the shell nests the Applet page and sends it `init`. There is
 * no shell here, so the dev page sends itself the same message — the page-side
 * contract is identical, which is the point of running it this way at all.
 */
const DEV_THEME_TOKENS: Record<string, string> = {
  surface: "#ffffff",
  "surface-raised": "#ffffff",
  "surface-subtle": "#f3f4f6",
  text: "#16181d",
  "text-muted": "#5b616b",
  border: "#d8dbe0",
  "accent-surface": "#2f6feb",
  "accent-text": "#ffffff",
  "radius-card": "10px",
};

function injectDevInit(
  html: string,
  token: string,
  generationId: string,
): string {
  const init = {
    schemaVersion: 1,
    type: "init",
    themeTokens: DEV_THEME_TOKENS,
    packageId: "applets",
    botId: "dev",
    slot: "frockbot.right-panel",
    applet: { socketUrl: "", token, generationId },
  };
  const script =
    `<script>(()=>{const m=${JSON.stringify(init)};` +
    `m.applet.socketUrl=location.origin.replace(/^http/,"ws")+"/socket";` +
    `window.postMessage(m,"*");})();</script>`;
  return html.replace("</body>", `${script}\n</body>`);
}

export interface AppletDevServer extends AppletRuntime {
  token: string;
}

export interface AppletDevOptions {
  directory: string;
  /** 0 picks a free port. */
  port?: number;
}

/** Serve `dist/` from Miniflare. Build first; this does not bundle. */
export async function startAppletDev(
  options: AppletDevOptions,
): Promise<AppletDevServer> {
  const descriptor = await readDescriptor(options.directory);
  const dist = join(options.directory, "dist");
  let serverCode: string;
  let html: string;
  try {
    serverCode = await readFile(join(dist, "server.js"), "utf8");
    html = await readFile(join(dist, "ui.html"), "utf8");
  } catch {
    throw new Error("No dist/ to serve; run `applet build` first");
  }
  const token = randomUUID();
  const runtime = await startAppletRuntime({
    serverCode,
    html: injectDevInit(html, token, "dev"),
    appletId: descriptor.id,
    token,
    port: options.port ?? 0,
  });
  return { ...runtime, token };
}
