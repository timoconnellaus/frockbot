import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { GatewayAuth } from "./contracts.js";

export interface AuthEnvironment {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

/** What better-auth is about to write, as the access authority reads it. */
export interface IdentityCandidateV1 {
  email: string;
  emailVerified: boolean;
}

export interface AuthDependencies {
  /**
   * Decides whether a first-time sign-in may write an identity. The gateway's
   * admission check runs after better-auth has already handled `/api/auth/*`,
   * so without this a closed deployment still writes `user` rows.
   */
  readonly mayCreateIdentity?: (
    candidate: IdentityCandidateV1,
  ) => Promise<boolean>;
}

/**
 * Refuses the identity creation better-auth is about to perform.
 *
 * `/api/auth/*` is served before the gateway's admission check, so this is the
 * only place a closed deployment can stop a `user` row being written. It is
 * not admission: an identity it lets through is still refused on every
 * request the access authority does not admit.
 */
export function identityCreationHooksV1(
  mayCreateIdentity: (candidate: IdentityCandidateV1) => Promise<boolean>,
) {
  return {
    user: {
      create: {
        before: async (user: { email?: string; emailVerified?: boolean }) =>
          (await mayCreateIdentity({
            email: user.email ?? "",
            emailVerified: user.emailVerified === true,
          }))
            ? { data: user }
            : false,
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
    ...(dependencies.mayCreateIdentity
      ? {
          databaseHooks: identityCreationHooksV1(
            dependencies.mayCreateIdentity,
          ),
        }
      : {}),
    plugins: [bearer()],
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

  // Public native-start requests need no identity lookup. Starting async auth
  // initialization there leaves work unfinished when the request ends.
  let auth: ReturnType<typeof createAuth> | undefined;
  const getAuth = () => (auth ??= createAuth(configured, dependencies));
  return {
    profile: async (userId) => {
      const user = await (
        await getAuth().$context
      ).internalAdapter.findUserById(userId);
      return user
        ? {
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified === true,
          }
        : null;
    },
    handler: (request) => getAuth().handler(request),
    getSession: async (headers) => {
      const session = await getAuth().api.getSession({ headers });
      return session
        ? {
            user: {
              id: session.user.id,
              email: session.user.email,
              emailVerified: session.user.emailVerified === true,
            },
          }
        : null;
    },
  };
}
