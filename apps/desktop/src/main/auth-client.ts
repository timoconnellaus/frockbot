import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";
import { BrowserWindow, ipcMain } from "electron";

const AUTH_PROTOCOL = "com.frockbot.desktop";
const API_PATH_PATTERN = /^\/api\/bots\/[a-zA-Z0-9._-]+\/turns$/;
const MAX_BODY_BYTES = 64 * 1024;
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

export interface DesktopApiRequest {
  path: string;
  method: "GET" | "POST";
  body?: string;
}

export interface DesktopApiResponse {
  status: number;
  contentType: string | null;
  body: string;
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

function validApiRequest(value: unknown): value is DesktopApiRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<DesktopApiRequest>;
  return (
    typeof request.path === "string" &&
    API_PATH_PATTERN.test(request.path) &&
    (request.method === "GET" || request.method === "POST") &&
    (request.body === undefined ||
      (typeof request.body === "string" &&
        new TextEncoder().encode(request.body).byteLength <= MAX_BODY_BYTES))
  );
}

export function setupDesktopAuth(): void {
  if (!authClient || !authBaseURL) return;

  authClient.setupMain({
    csp: false,
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
  });

  ipcMain.handle("frockbot:api", async (event, request: unknown) => {
    if (!event.senderFrame || !trustedRenderer(event.senderFrame.url)) {
      throw new Error("untrusted renderer");
    }
    if (!validApiRequest(request)) throw new Error("invalid API request");

    const headers = new Headers({ cookie: authClient.getCookie() });
    if (useDevelopmentIdentity) {
      headers.set("x-frockbot-user-id", "development");
    }
    if (request.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(new URL(request.path, authBaseURL), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "error",
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    } satisfies DesktopApiResponse;
  });
}
