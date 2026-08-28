import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  decodeDesktopApiRequest,
  decodeExternalAuthorizationUrl,
  type DesktopApiResponse,
} from "./desktop-api.js";

const AUTH_PROTOCOL = "com.frockbot.desktop";
const authBaseURL = process.env.FROCKBOT_AUTH_BASE_URL?.trim();
const applicationURL = process.env.FROCKBOT_APPLICATION_URL?.trim();
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

const useDevelopmentIdentity =
  isLoopbackUrl(authBaseURL) && isLoopbackUrl(applicationURL);

const pendingAuthorizationReturns = new Set<
  (status: "ready" | "failed") => void
>();

function acceptAuthorizationReturn(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const status = url.searchParams.get("status");
  if (
    url.protocol !== `${AUTH_PROTOCOL}:` ||
    url.pathname !== "/connections" ||
    (status !== "ready" && status !== "failed")
  ) {
    return;
  }
  for (const resolve of pendingAuthorizationReturns) resolve(status);
  pendingAuthorizationReturns.clear();
  const window = BrowserWindow.getAllWindows()[0];
  window?.show();
  window?.focus();
}

export const authClient = authBaseURL
  ? createAuthClient({
      baseURL: authBaseURL,
      plugins: [
        electronClient({
          clientID: "frockbot-desktop",
          protocol: { scheme: AUTH_PROTOCOL },
          signInURL: new URL("/", authBaseURL),
          storage: storage(),
        }),
      ],
    })
  : undefined;

function trustedRenderer(url: string): boolean {
  if (!applicationURL) return false;
  try {
    return new URL(url).origin === new URL(applicationURL).origin;
  } catch {
    return false;
  }
}

export function setupDesktopAuth(): void {
  if (!authClient || !authBaseURL) return;

  app.on("open-url", (event, url) => {
    event.preventDefault();
    acceptAuthorizationReturn(url);
  });
  app.on("second-instance", (_event, argv) => {
    for (const argument of argv) acceptAuthorizationReturn(argument);
  });

  authClient.setupMain({
    csp: false,
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  });

  ipcMain.handle("frockbot:api", async (event, request: unknown) => {
    if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
      throw new Error("untrusted renderer");
    }
    const decodedRequest = decodeDesktopApiRequest(request);

    const headers = new Headers({ cookie: authClient.getCookie() });
    headers.set("x-frockbot-client", "desktop");
    if (useDevelopmentIdentity) {
      headers.set("x-frockbot-user-id", "development");
    }
    if (decodedRequest.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(new URL(decodedRequest.path, authBaseURL), {
      method: decodedRequest.method,
      headers,
      body: decodedRequest.body,
      redirect: "error",
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    } satisfies DesktopApiResponse;
  });

  ipcMain.handle(
    "frockbot:open-external-authorization",
    async (event, url: unknown) => {
      if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
        throw new Error("untrusted renderer");
      }
      await shell.openExternal(decodeExternalAuthorizationUrl(url));
      return new Promise<void>((resolve, reject) => {
        const finish = (status: "ready" | "failed") => {
          clearTimeout(timeout);
          pendingAuthorizationReturns.delete(finish);
          if (status === "ready") resolve();
          else reject(new Error("Connection authorization was not completed"));
        };
        const timeout = setTimeout(() => {
          pendingAuthorizationReturns.delete(finish);
          reject(new Error("Connection authorization timed out"));
        }, 10 * 60_000);
        pendingAuthorizationReturns.add(finish);
      });
    },
  );
}
