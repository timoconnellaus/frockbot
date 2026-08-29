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
import {
  mountOwnedRegistrations,
  setupDisposableAuthMain,
} from "./owned-registrations.js";

const AUTH_PROTOCOL = "com.frockbot.desktop";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const API_CHANNEL = "frockbot:api";
const AUTHORIZATION_CHANNEL = "frockbot:open-external-authorization";
const BETTER_AUTH_CHANNEL = "better-auth:";

type AuthorizationStatus = "ready" | "pending" | "failed";

function isLoopbackOrigin(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
  return record;
}

function authErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication failed";
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
          userImageProxy: { enabled: false },
        }),
      ],
    });
    const getWindow = () => BrowserWindow.getAllWindows()[0] ?? null;
    setupDisposableAuthMain(authClient, app.isReady(), getWindow);
    const trustedRenderer = (url: string): boolean => {
      try {
        return new URL(url).origin === applicationUrl;
      } catch {
        return false;
      }
    };
    const requireTrustedRenderer = (event: Electron.IpcMainInvokeEvent) => {
      if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
        throw new Error("untrusted renderer");
      }
    };
    const sendAuthError = (error: unknown) => {
      getWindow()?.webContents.send(`${BETTER_AUTH_CHANNEL}error`, {
        message: authErrorMessage(error),
      });
    };
    const acceptProtocolUrl = (value: string) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return;
      }
      if (
        url.protocol === `${AUTH_PROTOCOL}:` &&
        url.pathname === "/auth/callback" &&
        url.hash.startsWith("#token=")
      ) {
        const token = url.hash.slice("#token=".length);
        if (!token) return;
        void authClient
          .authenticate({ token })
          .then((result) => {
            if (result.error) sendAuthError(result.error);
            else {
              const window = getWindow();
              window?.show();
              window?.focus();
            }
          })
          .catch(sendAuthError);
        return;
      }
      this.acceptAuthorizationReturn(value);
    };
    const onOpenUrl = (event: Electron.Event, url: string) => {
      event.preventDefault();
      acceptProtocolUrl(url);
    };
    const onSecondInstance = (
      _event: Electron.Event,
      argv: string[],
      _workingDirectory: string,
      _additionalData: unknown,
    ) => {
      for (const argument of argv) acceptProtocolUrl(argument);
    };
    const onReady = () => {
      if (process.platform === "darwin") return;
      for (const argument of process.argv) acceptProtocolUrl(argument);
    };

    const apiHandler = async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ): Promise<DesktopApiResponse> => {
      requireTrustedRenderer(event);
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
    };

    const authorizationHandler = async (
      event: Electron.IpcMainInvokeEvent,
      request: unknown,
    ) => {
      requireTrustedRenderer(event);
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
    };
    const betterAuthGetUser = async (event: Electron.IpcMainInvokeEvent) => {
      requireTrustedRenderer(event);
      const session = await authClient.getSession();
      if (session.error) throw new Error(session.error.message);
      return session.data?.user ?? null;
    };
    const betterAuthRequest = async (
      event: Electron.IpcMainInvokeEvent,
      value: unknown,
    ) => {
      requireTrustedRenderer(event);
      if (value === undefined) return await authClient.requestAuth();
      const request = exactRecord(value, ["provider"], "auth request");
      if (
        request.provider !== undefined &&
        (typeof request.provider !== "string" || !request.provider)
      ) {
        throw new Error("auth request provider is invalid");
      }
      await authClient.requestAuth(
        request.provider ? { provider: request.provider } : undefined,
      );
    };
    const betterAuthAuthenticate = async (
      event: Electron.IpcMainInvokeEvent,
      value: unknown,
    ) => {
      requireTrustedRenderer(event);
      const request = exactRecord(value, ["token"], "auth callback");
      if (typeof request.token !== "string" || !request.token) {
        throw new Error("auth callback token is invalid");
      }
      const result = await authClient.authenticate({ token: request.token });
      if (result.error) throw new Error(result.error.message);
    };
    const betterAuthSignOut = async (event: Electron.IpcMainInvokeEvent) => {
      requireTrustedRenderer(event);
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message);
      getWindow()?.webContents.send(`${BETTER_AUTH_CHANNEL}user-updated`, null);
    };
    const ipcRegistration =
      (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
      () => {
        ipcMain.handle(channel, listener);
        return () => ipcMain.removeHandler(channel);
      };

    return mountOwnedRegistrations([
      () => {
        if (!app.requestSingleInstanceLock()) {
          app.quit();
          throw new Error("another FrockBot desktop instance owns OAuth");
        }
        return () => app.releaseSingleInstanceLock();
      },
      () => {
        if (app.isPackaged) return;
        const args = process.defaultApp
          ? process.argv[1]
            ? [process.argv[1]]
            : []
          : undefined;
        const registered = args
          ? app.setAsDefaultProtocolClient(
              AUTH_PROTOCOL,
              process.execPath,
              args,
            )
          : app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
        if (!registered) {
          throw new Error("could not register the desktop OAuth protocol");
        }
        return () => {
          if (args) {
            app.removeAsDefaultProtocolClient(
              AUTH_PROTOCOL,
              process.execPath,
              args,
            );
          } else {
            app.removeAsDefaultProtocolClient(AUTH_PROTOCOL);
          }
        };
      },
      () => {
        app.on("open-url", onOpenUrl);
        return () => app.off("open-url", onOpenUrl);
      },
      () => {
        app.on("second-instance", onSecondInstance);
        return () => app.off("second-instance", onSecondInstance);
      },
      () => {
        app.on("ready", onReady);
        return () => app.off("ready", onReady);
      },
      ipcRegistration(API_CHANNEL, apiHandler),
      ipcRegistration(AUTHORIZATION_CHANNEL, authorizationHandler),
      ipcRegistration(`${BETTER_AUTH_CHANNEL}getUser`, betterAuthGetUser),
      ipcRegistration(`${BETTER_AUTH_CHANNEL}requestAuth`, betterAuthRequest),
      ipcRegistration(
        `${BETTER_AUTH_CHANNEL}authenticate`,
        betterAuthAuthenticate,
      ),
      ipcRegistration(`${BETTER_AUTH_CHANNEL}signOut`, betterAuthSignOut),
      () => () => {
        for (const finish of this.pendingAuthorizationReturns.values()) {
          finish("failed");
        }
        this.pendingAuthorizationReturns.clear();
      },
    ]);
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
