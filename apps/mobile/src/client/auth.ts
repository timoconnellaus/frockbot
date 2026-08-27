import type { PreferenceStore } from "./preferences.ts";

export const GATEWAY_URL_KEY = "frockbot.gateway-url";
export const AUTH_TOKEN_KEY = "frockbot.auth-token";
export const DEVELOPMENT_USER_KEY = "frockbot.development-user";
export const AUTH_TOKEN_HEADER = "set-auth-token";

export class UnauthorizedError extends Error {
  constructor(message = "authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface AuthState {
  gatewayUrl: string;
  token?: string;
  developmentUserId?: string;
}

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthSessionOptions {
  store: PreferenceStore;
  fetch: FetchLike;
  defaultGatewayUrl?: string;
}

export interface AuthSession {
  load(): Promise<AuthState>;
  state(): AuthState;
  setGatewayUrl(value: string): Promise<string>;
  setToken(token: string | undefined): Promise<void>;
  setDevelopmentUserId(userId: string | undefined): Promise<void>;
  authorizedFetch(path: string, init?: RequestInit): Promise<Response>;
  probe(botId: string): Promise<boolean>;
  startGoogleSignIn(callbackUrl: string): Promise<string>;
  signOut(): Promise<void>;
  onUnauthorized(listener: () => void): () => void;
}

export function normalizeGatewayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("gateway URL must not be empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("gateway URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("gateway URL must be an absolute http(s) URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function optionalValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requestUrl(state: AuthState, path: string): string {
  if (!state.gatewayUrl) throw new Error("gateway URL is not configured");
  if (!path.startsWith("/")) throw new Error("request path must start with /");
  const url = new URL(`${state.gatewayUrl}${path}`);
  if (state.developmentUserId) {
    url.searchParams.set("as_user", state.developmentUserId);
  }
  return url.toString();
}

function decodeSignInUrl(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("sign-in response must be an object");
  }
  const record = value as Record<string, unknown>;
  const url = record.url;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("sign-in response did not carry a redirect URL");
  }
  return url;
}

export function createAuthSession(options: AuthSessionOptions): AuthSession {
  const listeners = new Set<() => void>();
  const state: AuthState = {
    gatewayUrl: options.defaultGatewayUrl
      ? normalizeGatewayUrl(options.defaultGatewayUrl)
      : "",
  };

  function notifyUnauthorized(): void {
    for (const listener of [...listeners]) listener();
  }

  async function persist(
    key: string,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined) {
      await options.store.remove(key);
      return;
    }
    await options.store.set(key, value);
  }

  async function authorizedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (state.token) headers.set("authorization", `Bearer ${state.token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await options.fetch(requestUrl(state, path), {
      ...init,
      headers,
      credentials: "omit",
    });
    const issued = response.headers.get(AUTH_TOKEN_HEADER)?.trim();
    if (issued) {
      state.token = issued;
      await persist(AUTH_TOKEN_KEY, issued);
    }
    if (response.status === 401) {
      state.token = undefined;
      await persist(AUTH_TOKEN_KEY, undefined);
      notifyUnauthorized();
      throw new UnauthorizedError();
    }
    return response;
  }

  return {
    async load(): Promise<AuthState> {
      const [gatewayUrl, token, developmentUserId] = await Promise.all([
        options.store.get(GATEWAY_URL_KEY),
        options.store.get(AUTH_TOKEN_KEY),
        options.store.get(DEVELOPMENT_USER_KEY),
      ]);
      const stored = optionalValue(gatewayUrl);
      if (stored) {
        try {
          state.gatewayUrl = normalizeGatewayUrl(stored);
        } catch {
          await options.store.remove(GATEWAY_URL_KEY);
        }
      }
      state.token = optionalValue(token);
      state.developmentUserId = optionalValue(developmentUserId);
      return { ...state };
    },
    state: () => ({ ...state }),
    async setGatewayUrl(value: string): Promise<string> {
      const normalized = normalizeGatewayUrl(value);
      state.gatewayUrl = normalized;
      await persist(GATEWAY_URL_KEY, normalized);
      return normalized;
    },
    async setToken(token: string | undefined): Promise<void> {
      const normalized = token?.trim() ? token.trim() : undefined;
      state.token = normalized;
      await persist(AUTH_TOKEN_KEY, normalized);
    },
    async setDevelopmentUserId(userId: string | undefined): Promise<void> {
      const normalized = userId?.trim() ? userId.trim() : undefined;
      state.developmentUserId = normalized;
      await persist(DEVELOPMENT_USER_KEY, normalized);
    },
    authorizedFetch,
    async probe(botId: string): Promise<boolean> {
      if (!state.token && !state.developmentUserId) return false;
      try {
        const response = await authorizedFetch(
          `/api/bots/${encodeURIComponent(botId)}/turns`,
        );
        return response.ok;
      } catch (error) {
        if (error instanceof UnauthorizedError) return false;
        throw error;
      }
    },
    async startGoogleSignIn(callbackUrl: string): Promise<string> {
      const response = await authorizedFetch("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          callbackURL: callbackUrl,
          errorCallbackURL: callbackUrl,
          newUserCallbackURL: callbackUrl,
          disableRedirect: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`sign-in request failed with ${response.status}`);
      }
      return decodeSignInUrl(await response.json());
    },
    async signOut(): Promise<void> {
      state.token = undefined;
      state.developmentUserId = undefined;
      await Promise.all([
        options.store.remove(AUTH_TOKEN_KEY),
        options.store.remove(DEVELOPMENT_USER_KEY),
      ]);
    },
    onUnauthorized(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
