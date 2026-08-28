import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  decodeDesktopApiRequest,
  decodeExternalAuthorizationUrl,
  type DesktopApiResponse,
} from "./desktop-api.js";
import { resolveHostedDesktopOrigins } from "./hosted-application.js";

const AUTH_PROTOCOL = "com.frockbot.desktop";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const pendingAuthorizationReturns = new Map<
  string,
  (status: "ready" | "pending" | "failed") => void
>();

function acceptAuthorizationReturn(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const status = url.searchParams.get("status");
  const nonce = url.searchParams.get("nonce");
  if (
    url.protocol !== `${AUTH_PROTOCOL}:` ||
    url.pathname !== "/connections" ||
    (status !== "ready" && status !== "pending" && status !== "failed") ||
    !nonce
  ) {
    return;
  }
  const resolve = pendingAuthorizationReturns.get(nonce);
  if (!resolve) return;
  pendingAuthorizationReturns.delete(nonce);
  resolve(status);
  const window = BrowserWindow.getAllWindows()[0];
  window?.show();
  window?.focus();
}

export function setupDesktopAuth(): void {
  const { applicationUrl, authBaseUrl } = resolveHostedDesktopOrigins(
    process.env.FROCKBOT_APPLICATION_URL,
    process.env.FROCKBOT_AUTH_BASE_URL,
  );
  const useDevelopmentIdentity =
    LOOPBACK_HOSTS.has(new URL(authBaseUrl).hostname.toLowerCase()) &&
    LOOPBACK_HOSTS.has(new URL(applicationUrl).hostname.toLowerCase());
  const authClient = createAuthClient({
    baseURL: authBaseUrl,
    plugins: [
      electronClient({
        clientID: "frockbot-desktop",
        protocol: { scheme: AUTH_PROTOCOL },
        signInURL: new URL("/", authBaseUrl),
        storage: storage(),
      }),
    ],
  });
  const trustedRenderer = (url: string): boolean => {
    try {
      return new URL(url).origin === applicationUrl;
    } catch {
      return false;
    }
  };

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
    const response = await fetch(new URL(decodedRequest.path, authBaseUrl), {
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
    async (event, url: unknown, nativeReturnNonce: unknown) => {
      if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
        throw new Error("untrusted renderer");
      }
      if (
        typeof nativeReturnNonce !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(nativeReturnNonce)
      ) {
        throw new Error("invalid native authorization nonce");
      }
      const authorizationUrl = decodeExternalAuthorizationUrl(url);
      return new Promise<void>((resolve, reject) => {
        const finish = (status: "ready" | "pending" | "failed") => {
          clearTimeout(timeout);
          pendingAuthorizationReturns.delete(nativeReturnNonce);
          if (status === "ready") resolve();
          else if (status === "pending") {
            reject(new Error("Connection authorization is still completing"));
          } else
            reject(new Error("Connection authorization was not completed"));
        };
        const timeout = setTimeout(() => {
          pendingAuthorizationReturns.delete(nativeReturnNonce);
          reject(new Error("Connection authorization timed out"));
        }, 10 * 60_000);
        if (pendingAuthorizationReturns.has(nativeReturnNonce)) {
          clearTimeout(timeout);
          reject(new Error("Connection authorization is already pending"));
          return;
        }
        pendingAuthorizationReturns.set(nativeReturnNonce, finish);
        void shell.openExternal(authorizationUrl).catch((error) => {
          clearTimeout(timeout);
          pendingAuthorizationReturns.delete(nativeReturnNonce);
          reject(error);
        });
      });
    },
  );
}
