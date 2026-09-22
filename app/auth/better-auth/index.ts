/**
 * Sign-in as the hosted deployment does it: better-auth, Google, a session
 * cookie, and identities in D1.
 *
 * This is one implementation of `AuthPackageV1` and the only place the
 * `better-auth` dependency exists, which
 * `scripts/check-auth-package-imports.ts` enforces. The deployment chooses it
 * in `apps/cloudflare/src/auth-package.ts`.
 */
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type {
  AuthIdentityCandidateV1,
  AuthPackageBuildV1,
  AuthPackageDependenciesV1,
  AuthPackageIdentityStoreV1,
  AuthPackageV1,
} from "@frockbot/core/contracts";
import { signInFailedV1, signInRedirectV1 } from "../shared.js";

export interface BetterAuthEnvironmentV1 {
  /**
   * Where the identities live. Optional because the other auth Package stores
   * nothing and its deployment binds no database, so the Worker's `env` cannot
   * promise one; without it this Package signs nobody in.
   */
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** The environment with every setting this Package needs actually present. */
type ConfiguredEnvironmentV1 = Required<BetterAuthEnvironmentV1>;

/**
 * Refuses the identity creation better-auth is about to perform.
 *
 * `/api/auth/*` is served before the gateway's admission check, so this is the
 * only place a closed deployment can stop a `user` row being written. It is
 * not admission: an identity it lets through is still refused on every
 * request the access authority does not admit.
 */
export function identityCreationHooksV1(
  mayCreateIdentity: (candidate: AuthIdentityCandidateV1) => Promise<boolean>,
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
  environment: ConfiguredEnvironmentV1,
  dependencies: AuthPackageDependenciesV1 = {},
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

function configuredEnvironment(
  environment: BetterAuthEnvironmentV1,
): ConfiguredEnvironmentV1 | null {
  const values = [
    environment.BETTER_AUTH_SECRET,
    environment.BETTER_AUTH_URL,
    environment.GOOGLE_CLIENT_ID,
    environment.GOOGLE_CLIENT_SECRET,
  ];
  return environment.AUTH_DB && values.every((value) => value?.trim())
    ? (environment as ConfiguredEnvironmentV1)
    : null;
}

const STORED_IDENTITY_COLUMNS =
  '"id", "email", "name", "emailVerified", "createdAt"';

interface StoredIdentityRowV1 {
  id: string;
  email: string;
  name: string;
  emailVerified: number;
  createdAt: string;
}

function storedIdentityOfV1(row: StoredIdentityRowV1) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.emailVerified === 1,
    createdAt: row.createdAt,
  };
}

/**
 * The stored-identity half of the Package: the `user` table, queried directly.
 *
 * Raw D1 rather than better-auth's adapter because admission reads this on
 * every native and machine request, and constructing a better-auth instance to
 * answer a one-row lookup is work the query does not need. It also answers
 * while sign-in itself is unconfigured: a deployment missing a Google secret
 * still has identities, and admission still has to decide about them.
 */
function identityStoreV1(
  environment: BetterAuthEnvironmentV1,
): AuthPackageIdentityStoreV1 {
  const database = environment.AUTH_DB;
  if (!database) return {};
  return {
    storedIdentity: async (userId) => {
      const row = await database
        .prepare(
          `select ${STORED_IDENTITY_COLUMNS} from "user" where "id" = ? limit 1`,
        )
        .bind(userId)
        .first<StoredIdentityRowV1>();
      return row ? storedIdentityOfV1(row) : null;
    },
    listStoredIdentities: async (limit) => {
      const result = await database
        .prepare(
          `select ${STORED_IDENTITY_COLUMNS} from "user" order by "createdAt" desc limit ?`,
        )
        .bind(limit)
        .all<StoredIdentityRowV1>();
      return (result.results ?? []).map(storedIdentityOfV1);
    },
  };
}

function unconfigured(environment: BetterAuthEnvironmentV1): AuthPackageV1 {
  const refuse = () =>
    Promise.resolve(
      Response.json(
        { error: "authentication is not configured" },
        { status: 503 },
      ),
    );
  return {
    ...identityStoreV1(environment),
    handler: refuse,
    getSession: () => Promise.resolve(null),
    signOut: refuse,
    // The same answer the native door has always given when the provider it
    // would redirect to refuses: the visitor cannot act on which secret is
    // missing, and the Worker log names it.
    startSignIn: () => Promise.resolve(signInFailedV1(401)),
  };
}

function betterAuthPackage(
  environment: BetterAuthEnvironmentV1,
  dependencies: AuthPackageDependenciesV1 = {},
): AuthPackageV1 {
  const configured = configuredEnvironment(environment);
  if (!configured) return unconfigured(environment);

  // Public native-start requests need no identity lookup. Starting async auth
  // initialization there leaves work unfinished when the request ends.
  let auth: ReturnType<typeof createAuth> | undefined;
  const getAuth = () => (auth ??= createAuth(configured, dependencies));
  const origin = configured.BETTER_AUTH_URL;
  return {
    ...identityStoreV1(configured),
    profile: async (userId) => {
      const user = await (
        await getAuth().$context
      ).internalAdapter.findUserById(userId);
      return user
        ? {
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified === true,
            ...(typeof user.image === "string" &&
            user.image.startsWith("https://")
              ? { image: user.image }
              : {}),
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
    signOut: async (request, url) => {
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      const response = await getAuth().handler(
        new Request(new URL("/api/auth/sign-out", url), {
          method: "POST",
          headers,
          body: "{}",
        }),
      );
      if (!response.ok) return response;
      const redirect = new Response(null, {
        status: 303,
        headers: response.headers,
      });
      redirect.headers.set("location", "/");
      return redirect;
    },
    startSignIn: async (request, returnTo) => {
      const response = await getAuth().handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            cookie: request.headers.get("cookie") ?? "",
          },
          body: JSON.stringify({ provider: "google", callbackURL: returnTo }),
        }),
      );
      if (!response.ok) return signInFailedV1(401);
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("url" in result) ||
        typeof result.url !== "string"
      )
        return signInFailedV1();
      const providerUrl = new URL(result.url);
      // The provider is the deployment's, never the answer's: a redirect this
      // page has not pinned is an open one.
      if (
        providerUrl.origin !== "https://accounts.google.com" ||
        providerUrl.username ||
        providerUrl.password
      )
        return signInFailedV1();
      return signInRedirectV1(providerUrl.toString(), response.headers);
    },
  };
}

export const BETTER_AUTH_PACKAGE_V1: AuthPackageBuildV1<BetterAuthEnvironmentV1> =
  {
    id: "better-auth",
    required: [
      {
        name: "BETTER_AUTH_URL",
        why: "The deployment's own origin; every sign-in redirect is built from it.",
      },
      {
        name: "BETTER_AUTH_SECRET",
        why: "Signs every session cookie. Absent, nobody can sign in.",
      },
      {
        name: "GOOGLE_CLIENT_ID",
        why: "The only sign-in method the hosted deployment offers.",
      },
      {
        name: "GOOGLE_CLIENT_SECRET",
        why: "The only sign-in method the hosted deployment offers.",
      },
    ],
    admission: "authority",
    // The live hosted key. Renaming what the native door signs with would
    // invalidate every code and bearer already issued, which is every signed-in
    // phone and Mac.
    nativeTokenSecret: {
      name: "BETTER_AUTH_SECRET",
      why: "Also signs the native sign-in codes and bearer tokens this deployment has already issued.",
      read: (environment) => environment.BETTER_AUTH_SECRET,
    },
    create: betterAuthPackage,
  };
