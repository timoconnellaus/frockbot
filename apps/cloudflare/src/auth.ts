import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import {
  verifyGoogleIdToken,
  type VerifyGoogleIdTokenOptions,
} from "better-auth/social-providers";
import type { GatewayAuth } from "./contracts.js";

export interface AuthEnvironment {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export const HOSTED_AUTH_TRUSTED_ORIGINS = ["com.frockbot.desktop:/"] as const;

export type GoogleIdTokenVerifier = (
  options: VerifyGoogleIdTokenOptions,
) => Promise<unknown | null>;

export interface AuthDependencies {
  readonly verifyGoogleIdToken?: GoogleIdTokenVerifier;
  /**
   * Decides whether a first-time sign-in may create an account. The gateway's
   * admission check runs after better-auth has already handled `/api/auth/*`,
   * so without this a closed deployment still writes `user` rows.
   */
  readonly mayCreateAccount?: (email: string) => Promise<boolean>;
}

export function createGoogleIdTokenVerifier(
  audience: string,
  verifier: GoogleIdTokenVerifier = verifyGoogleIdToken,
) {
  return async (token: string, nonce?: string): Promise<boolean> =>
    (await verifier({ token, audience, nonce })) !== null;
}

/**
 * Refuses the account creation better-auth is about to perform.
 *
 * `/api/auth/*` is served before the gateway's admission check, so this is the
 * only place a closed deployment can stop a `user` row being written. An
 * existing account is unaffected: better-auth consults this only on create.
 */
export function signupDatabaseHooksV1(
  mayCreateAccount: (email: string) => Promise<boolean>,
) {
  return {
    user: {
      create: {
        before: async (user: { email?: string }) =>
          (await mayCreateAccount(user.email ?? "")) ? { data: user } : false,
      },
    },
  };
}

export function createAuth(
  environment: AuthEnvironment,
  dependencies: AuthDependencies = {},
) {
  return betterAuth({
    appName: "FrockBot",
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    database: environment.AUTH_DB,
    trustedOrigins: [...HOSTED_AUTH_TRUSTED_ORIGINS],
    socialProviders: {
      google: {
        clientId: environment.GOOGLE_CLIENT_ID,
        clientSecret: environment.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        verifyIdToken: createGoogleIdTokenVerifier(
          environment.GOOGLE_CLIENT_ID,
          dependencies.verifyGoogleIdToken,
        ),
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    ...(dependencies.mayCreateAccount
      ? { databaseHooks: signupDatabaseHooksV1(dependencies.mayCreateAccount) }
      : {}),
    plugins: [electron({ clientID: "frockbot-desktop" }), bearer()],
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

export function gatewayAuth(
  environment: RuntimeAuthEnvironment,
  dependencies: AuthDependencies = {},
): GatewayAuth {
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

  const auth = createAuth(configured, dependencies);
  return {
    profile: async (userId) => {
      const user = await (
        await auth.$context
      ).internalAdapter.findUserById(userId);
      return user ? { name: user.name, email: user.email } : null;
    },
    handler: (request) => auth.handler(request),
    getSession: async (headers) => {
      const session = await auth.api.getSession({ headers });
      return session
        ? { user: { id: session.user.id, email: session.user.email } }
        : null;
    },
  };
}
