/**
 * Sign-in, as everything above it already speaks to it.
 *
 * This is the seam the gateway has always had between `gateway.ts` and the
 * identity provider, named: resolve who a request is, serve the routes that
 * sign somebody in and out, and hand the native authorize page its identity
 * step. Nothing wider — the Bot, the Turn and the User Durable Objects know a
 * User id and never how it was established.
 *
 * Two implementations exist: `app/auth/better-auth` (Google, D1, a session
 * cookie) and `app/auth/access` (a Cloudflare Access token, no storage). Which
 * one a deployment builds is chosen in one file beside the bindings,
 * `apps/cloudflare/src/auth-package.ts`, the way the Computer host is chosen
 * (ADR 0028).
 */

/** Who a request is, once sign-in has identified them. */
export interface AuthIdentityV1 {
  user: {
    id: string;
    email?: string;
    /** Whether the identity provider verified `email`; absent means no. */
    emailVerified?: boolean;
  };
}

/** Display hints for an already authenticated User. Never a credential. */
export interface AuthProfileV1 {
  name?: string;
  email?: string;
  emailVerified?: boolean;
}

/** One auth Package, over one request. */
export interface AuthPackageV1 {
  /** Profile hints for the already authenticated User; no credential fields. */
  profile?(userId: string): Promise<AuthProfileV1 | null>;
  /** `/api/auth/*`: whatever sign-in routes this Package serves there. */
  handler(request: Request): Promise<Response>;
  /** The identity these request headers carry, or nobody. */
  getSession(headers: Headers): Promise<AuthIdentityV1 | null>;
  /**
   * `GET /sign-out`: ends the session and says where the browser goes next.
   * Whether that means clearing a cookie or leaving an identity provider is
   * the Package's business.
   */
  signOut(request: Request, url: URL): Promise<Response>;
  /**
   * Sends a browser that is nobody to sign in and come back to `returnTo`.
   * The native authorize page's identity step, and the only place the
   * gateway asks for a sign-in rather than serving one.
   */
  startSignIn(request: Request, returnTo: string): Promise<Response>;
}

/**
 * The half of an auth Package the native sign-in door needs: who a browser is,
 * and how to send one that is nobody to sign in. The door mints its own codes
 * and sessions, so it never serves the Package's own routes.
 */
export type AuthPackageIdentityV1 = Pick<
  AuthPackageV1,
  "getSession" | "profile" | "startSignIn"
>;

/** What an auth Package is about to write, as the access authority reads it. */
export interface AuthIdentityCandidateV1 {
  email: string;
  emailVerified: boolean;
}

/** What an auth Package is given beyond `env`. */
export interface AuthPackageDependenciesV1 {
  /**
   * Decides whether a first-time sign-in may write an identity. The gateway's
   * admission check runs after the Package has already served its own routes,
   * so without this a closed deployment still writes identity rows. A Package
   * that stores nothing has nothing to ask about and ignores it.
   */
  readonly mayCreateIdentity?: (
    candidate: AuthIdentityCandidateV1,
  ) => Promise<boolean>;
}

/** One `env` string an auth Package reads, and what it is for. */
export interface AuthPackageSettingV1 {
  readonly name: string;
  /** What it is for, in one line, for the operator reading a failed deploy. */
  readonly why: string;
}

/**
 * Who decides whether an identity may use the deployment.
 *
 * `authority` asks the `DeploymentPolicy` object, which holds the admission
 * mode, the access records and the invitations. `package` means the Package is
 * itself the allowlist — Cloudflare Access admits nobody its policy did not —
 * so there is no authority to ask and no admission UI to show (ADR 0028).
 */
export type AuthPackageAdmissionV1 = "authority" | "package";

/** Which implementation of sign-in a deployment built. */
export type AuthPackageIdV1 = "better-auth" | "access";

/** One implementation of sign-in, as a deployment's choosing file names it. */
export interface AuthPackageBuildV1<EnvironmentV1> {
  readonly id: AuthPackageIdV1;
  /** Every `env` string without which this Package can sign nobody in. */
  readonly required: readonly AuthPackageSettingV1[];
  readonly admission: AuthPackageAdmissionV1;
  /**
   * The Package over this Worker's bindings. Given an environment it is not
   * configured for it answers 503 to every route rather than failing to
   * construct, so a half-configured deployment still serves a reason.
   */
  create(
    environment: EnvironmentV1,
    dependencies?: AuthPackageDependenciesV1,
  ): AuthPackageV1;
}
