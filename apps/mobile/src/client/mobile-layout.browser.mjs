import { readFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

const browserInsets = { top: 11, right: 17, bottom: 23, left: 29 };
const nativeInsets = { top: 13, right: 19, bottom: 27, left: 31 };
const sharedStyles = await readFile(
  new URL(
    "../../../../packages/plugin-shell/src/client/styles.css",
    import.meta.url,
  ),
  "utf8",
);
const mobileStyles = await readFile(
  new URL("./mobile.css", import.meta.url),
  "utf8",
);

app.disableHardwareAcceleration();

function nativeVariables(insets) {
  return Object.entries(insets)
    .map(([edge, value]) => `--safe-area-inset-${edge}: ${value}px`)
    .join(";");
}

function documentFor(state, insets) {
  const rootStyle = insets ? ` style="${nativeVariables(insets)}"` : "";
  const content =
    state === "auth"
      ? `<div class="mobile-auth"><div id="auth-probe" style="width:100%;height:100%"></div></div>`
      : `<div class="mobile-root">
          <header class="mobile-topbar"></header>
          <div class="mobile-surface">
            <div class="frockbot-root"><main class="app-shell"><section class="workspace"></section></main></div>
          </div>
          <footer class="mobile-actions"></footer>
        </div>`;
  return `<!doctype html><html${rootStyle}><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${sharedStyles}\n${mobileStyles}</style></head><body><div id="app">${content}</div></body></html>`;
}

function rect(element) {
  const bounds = element.getBoundingClientRect();
  return {
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    left: bounds.left,
    width: bounds.width,
    height: bounds.height,
  };
}

async function measure(window, state, native) {
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(documentFor(state, native))}`,
  );
  return window.webContents.executeJavaScript(`(() => {
    const rect = ${rect.toString()};
    const root = document.querySelector('${state === "auth" ? ".mobile-auth" : ".mobile-root"}');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ${
        state === "auth"
          ? "auth: { root: rect(root), probe: rect(document.querySelector('#auth-probe')) }"
          : `authenticated: {
              root: rect(root),
              topbar: rect(document.querySelector('.mobile-topbar')),
              surface: rect(document.querySelector('.mobile-surface')),
              hostedRoot: rect(document.querySelector('.frockbot-root')),
              actions: rect(document.querySelector('.mobile-actions')),
            }`
      }
    };
  })()`);
}

async function measureLayout(window, native) {
  const auth = await measure(window, "auth", native);
  const authenticated = await measure(window, "authenticated", native);
  return {
    viewport: auth.viewport,
    auth: auth.auth,
    authenticated: authenticated.authenticated,
  };
}

async function run() {
  const window = new BrowserWindow({
    show: false,
    width: 360,
    height: 640,
    useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      offscreen: true,
      sandbox: true,
    },
  });
  await window.loadURL("about:blank");
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand(
    "Emulation.setSafeAreaInsetsOverride",
    { insets: browserInsets },
  );
  const browser = await measureLayout(window);
  const native = await measureLayout(window, nativeInsets);
  process.stdout.write(`${JSON.stringify({ browser, native })}\n`);
  window.destroy();
  app.quit();
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    app.exit(1);
  });
