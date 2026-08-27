import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import type { GatewayAuth } from "./contracts.js";

export interface AuthEnvironment {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export function createAuth(environment: AuthEnvironment) {
  return betterAuth({
    appName: "FrockBot",
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    database: environment.AUTH_DB,
    trustedOrigins: ["com.frockbot.desktop:/"],
    socialProviders: {
      google: {
        clientId: environment.GOOGLE_CLIENT_ID,
        clientSecret: environment.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    plugins: [electron({ clientID: "frockbot-desktop" })],
  });
}

type RuntimeAuthEnvironment = Partial<AuthEnvironment> &
  Pick<AuthEnvironment, "AUTH_DB">;

function configuredEnvironment(
  environment: RuntimeAuthEnvironment,
): AuthEnvironment | null {
  const values = [
    environment.BETTER_AUTH_SECRET,
    environment.BETTER_AUTH_URL,
    environment.GOOGLE_CLIENT_ID,
    environment.GOOGLE_CLIENT_SECRET,
  ];
  return values.every((value) => value?.trim())
    ? (environment as AuthEnvironment)
    : null;
}

export function gatewayAuth(environment: RuntimeAuthEnvironment): GatewayAuth {
  const configured = configuredEnvironment(environment);
  if (!configured) {
    return {
      handler: () =>
        Promise.resolve(
          Response.json(
            { error: "authentication is not configured" },
            { status: 503 },
          ),
        ),
      getSession: () => Promise.resolve(null),
    };
  }

  const auth = createAuth(configured);
  return {
    handler: (request) => auth.handler(request),
    getSession: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return session ? { user: { id: session.user.id } } : null;
    },
  };
}
