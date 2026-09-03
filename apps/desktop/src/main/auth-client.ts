import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { DesktopAuthCapability } from "@frockbot/plugin-auth/desktop";
import { createAuthClient } from "better-auth/client";
import type { Context } from "cordis";
import { app, BrowserWindow, ipcMain, shell, type Session } from "electron";
import {
  decodeDesktopAuthCallbackToken,
  decodeDesktopAuthRequest,
  decodeDesktopApiRequest,
  decodeDesktopExternalAuthorizationRequest,
  decodeExternalAuthorizationUrl,
  type DesktopAuthEventV1,
  type DesktopAuthUserV1,
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
const AUTH_CHANNEL = "frockbot:auth";
const AUTH_EVENT_CHANNEL = "frockbot:auth-event";

type AuthorizationStatus = "ready" | "pending" | "failed";

function isLoopbackOrigin(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function authErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication failed";
}

function desktopAuthUser(value: unknown): DesktopAuthUserV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authentication returned an invalid user");
  }
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    !user.id ||
    user.id.length > 256 ||
    typeof user.name !== "string" ||
    !user.name ||
    user.name.length > 256 ||
    typeof user.email !== "string" ||
    !user.email ||
    user.email.length > 320
  ) {
    throw new Error("Authentication returned an invalid user");
  }
  return { id: user.id, name: user.name, email: user.email };
}

function createElectronAuthClient(authBaseUrl: string) {
  return createAuthClient({
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
}

type ElectronAuthClient = ReturnType<typeof createElectronAuthClient>;

export interface PreparedElectronDesktopAuthRuntime {
  applicationUrl: string;
  authBaseUrl: string;
  useDevelopmentIdentity: boolean;
  authClient: ElectronAuthClient;
  getWindow(): BrowserWindow | null;
  prepareRendererSession(session: Session): Promise<void>;
}

export function prepareElectronDesktopAuthRuntime(): PreparedElectronDesktopAuthRuntime {
  const { applicationUrl, authBaseUrl } = resolveHostedDesktopOrigins(
    process.env.FROCKBOT_APPLICATION_URL,
    process.env.FROCKBOT_AUTH_BASE_URL,
  );
  const authClient = createElectronAuthClient(authBaseUrl);
  const rendererCookieNames = new Set<string>();
  const prepareRendererSession = async (electronSession: Session) => {
    for (const name of rendererCookieNames) {
      await electronSession.cookies.remove(applicationUrl, name);
    }
    rendererCookieNames.clear();
    const cookies = new Map<string, string>();
    if (isLoopbackOrigin(authBaseUrl) && isLoopbackOrigin(applicationUrl)) {
      cookies.set("frockbot_dev_user", "development");
    } else {
      for (const part of authClient.getCookie().split(";")) {
        const separator = part.indexOf("=");
        if (separator <= 0) continue;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name && value) cookies.set(name, value);
      }
    }
    const secure = new URL(applicationUrl).protocol === "https:";
    for (const [name, value] of cookies) {
      await electronSession.cookies.set({
        url: applicationUrl,
        name,
        value,
        httpOnly: true,
        secure,
        sameSite: "lax",
      });
      rendererCookieNames.add(name);
    }
  };
  setupDisposableAuthMain(authClient, app.isReady(), () => null);
  return {
    applicationUrl,
    authBaseUrl,
    useDevelopmentIdentity:
      isLoopbackOrigin(authBaseUrl) && isLoopbackOrigin(applicationUrl),
    authClient,
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    prepareRendererSession,
  };
}

export class ElectronDesktopAuthCapability extends DesktopAuthCapability {
  private readonly pendingAuthorizationReturns = new Map<
    string,
    (status: AuthorizationStatus) => void
  >();

  constructor(
    ctx: Context,
    private readonly runtime: PreparedElectronDesktopAuthRuntime,
  ) {
    super(ctx);
  }

  start(): () => void {
    const {
      applicationUrl,
      authBaseUrl,
      useDevelopmentIdentity,
      authClient,
      getWindow,
    } = this.runtime;
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
    const sendAuthEvent = (event: DesktopAuthEventV1) => {
      getWindow()?.webContents.send(AUTH_EVENT_CHANNEL, event);
    };
    const sendAuthError = (error: unknown) => {
      const message = authErrorMessage(error).slice(0, 2_000);
      sendAuthEvent({
        schemaVersion: 1,
        type: "auth/error",
        message: message || "Authentication failed",
      });
    };
    const acceptProtocolUrl = (value: string) => {
      const token = decodeDesktopAuthCallbackToken(value);
      if (token !== undefined) {
        void authClient
          .authenticate({ token })
          .then(async (result) => {
            if (result.error) sendAuthError(result.error);
            else {
              const session = await authClient.getSession();
              if (session.error || !session.data?.user) {
                throw new Error(
                  session.error?.message ??
                    "Authentication did not return a user",
                );
              }
              const window = getWindow();
              if (window) {
                await this.runtime.prepareRendererSession(
                  window.webContents.session,
                );
              }
              sendAuthEvent({
                schemaVersion: 1,
                type: "auth/authenticated",
                user: desktopAuthUser(session.data.user),
              });
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
    const authHandler = async (
      event: Electron.IpcMainInvokeEvent,
      value: unknown,
    ) => {
      requireTrustedRenderer(event);
      const request = decodeDesktopAuthRequest(value);
      if (request.type === "auth/get-user") {
        const session = await authClient.getSession();
        if (session.error) throw new Error(session.error.message);
        return {
          schemaVersion: 1,
          type: "auth/user",
          user: session.data?.user ? desktopAuthUser(session.data.user) : null,
        } as const;
      }
      if (request.type === "auth/request") {
        await authClient.requestAuth(
          request.provider ? { provider: request.provider } : undefined,
        );
        return { schemaVersion: 1, type: "auth/accepted" } as const;
      }
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message);
      const window = getWindow();
      if (window) {
        await this.runtime.prepareRendererSession(window.webContents.session);
      }
      sendAuthEvent({
        schemaVersion: 1,
        type: "auth/user-updated",
        user: null,
      });
      return { schemaVersion: 1, type: "auth/accepted" } as const;
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
      ipcRegistration(AUTH_CHANNEL, authHandler),
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
