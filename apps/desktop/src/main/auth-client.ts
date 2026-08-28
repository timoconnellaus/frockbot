import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { DesktopAuthCapability } from "@frockbot/plugin-auth/desktop";
import { createAuthClient } from "better-auth/client";
import type { Context } from "cordis";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  decodeDesktopApiRequest,
  decodeDesktopExternalAuthorizationRequest,
  decodeExternalAuthorizationUrl,
  type DesktopApiResponse,
} from "./desktop-api.js";
import { resolveHostedDesktopOrigins } from "./hosted-application.js";

const AUTH_PROTOCOL = "com.frockbot.desktop";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const API_CHANNEL = "frockbot:api";
const AUTHORIZATION_CHANNEL = "frockbot:open-external-authorization";

type AuthorizationStatus = "ready" | "pending" | "failed";

function isLoopbackOrigin(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export class ElectronDesktopAuthCapability extends DesktopAuthCapability {
  private readonly pendingAuthorizationReturns = new Map<
    string,
    (status: AuthorizationStatus) => void
  >();

  constructor(ctx: Context) {
    super(ctx);
  }

  start(): () => void {
    const { applicationUrl, authBaseUrl } = resolveHostedDesktopOrigins(
      process.env.FROCKBOT_APPLICATION_URL,
      process.env.FROCKBOT_AUTH_BASE_URL,
    );
    const useDevelopmentIdentity =
      isLoopbackOrigin(authBaseUrl) && isLoopbackOrigin(applicationUrl);
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
    const onOpenUrl = (event: Electron.Event, url: string) => {
      event.preventDefault();
      this.acceptAuthorizationReturn(url);
    };
    const onSecondInstance = (_event: Electron.Event, argv: string[]) => {
      for (const argument of argv) this.acceptAuthorizationReturn(argument);
    };

    app.on("open-url", onOpenUrl);
    app.on("second-instance", onSecondInstance);

    authClient.setupMain({
      csp: false,
      getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    });

    ipcMain.handle(API_CHANNEL, async (event, request: unknown) => {
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
        schemaVersion: 1,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      } satisfies DesktopApiResponse;
    });

    ipcMain.handle(AUTHORIZATION_CHANNEL, async (event, request: unknown) => {
      if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
        throw new Error("untrusted renderer");
      }
      const decodedRequest = decodeDesktopExternalAuthorizationRequest(request);
      const { nativeReturnNonce } = decodedRequest;
      const authorizationUrl = decodeExternalAuthorizationUrl(
        decodedRequest.url,
      );
      await new Promise<void>((resolve, reject) => {
        const finish = (status: AuthorizationStatus) => {
          clearTimeout(timeout);
          this.pendingAuthorizationReturns.delete(nativeReturnNonce);
          if (status === "ready") resolve();
          else if (status === "pending") {
            reject(new Error("Connection authorization is still completing"));
          } else {
            reject(new Error("Connection authorization was not completed"));
          }
        };
        const timeout = setTimeout(() => {
          this.pendingAuthorizationReturns.delete(nativeReturnNonce);
          reject(new Error("Connection authorization timed out"));
        }, 10 * 60_000);
        if (this.pendingAuthorizationReturns.has(nativeReturnNonce)) {
          clearTimeout(timeout);
          reject(new Error("Connection authorization is already pending"));
          return;
        }
        this.pendingAuthorizationReturns.set(nativeReturnNonce, finish);
        void shell.openExternal(authorizationUrl).catch((error) => {
          clearTimeout(timeout);
          this.pendingAuthorizationReturns.delete(nativeReturnNonce);
          reject(error);
        });
      });
      return { schemaVersion: 1, status: "accepted" } as const;
    });

    return () => {
      app.off("open-url", onOpenUrl);
      app.off("second-instance", onSecondInstance);
      ipcMain.removeHandler(API_CHANNEL);
      ipcMain.removeHandler(AUTHORIZATION_CHANNEL);
      for (const finish of this.pendingAuthorizationReturns.values()) {
        finish("failed");
      }
      this.pendingAuthorizationReturns.clear();
    };
  }

  private acceptAuthorizationReturn(value: string): void {
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
    const resolve = this.pendingAuthorizationReturns.get(nonce);
    if (!resolve) return;
    this.pendingAuthorizationReturns.delete(nonce);
    resolve(status);
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  }
}
