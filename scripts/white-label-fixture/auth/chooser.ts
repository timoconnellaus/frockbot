// A STUB of a white-label's own auth Package chooser (ADR 0038 §3): what its
// profile names by path and the generator aliases `#auth-package` to. It signs
// nobody in. What the fixture proves is that a chooser written outside this
// repository, against nothing but the published `@frockbot/core/contracts`,
// is enough for the Worker to build with.
import type {
  AuthPackageBuildV1,
  AuthPackageV1,
} from "@frockbot/core/contracts";

/** What the Worker's `env` must hand this Package. */
export interface AuthPackageEnvironmentV1 {
  WALLET_PAL_SIGN_IN_APP?: string;
  WALLET_PAL_SIGN_IN_SECRET?: string;
}

const NOBODY_V1: AuthPackageV1 = {
  handler: async () => new Response("wallet-pal-stub", { status: 404 }),
  getSession: async () => null,
  signOut: async (_request, url) =>
    Response.redirect(new URL("/", url).toString(), 302),
  startSignIn: async () => new Response("wallet-pal-stub", { status: 503 }),
};

const SECRET_V1 = {
  name: "WALLET_PAL_SIGN_IN_SECRET",
  why: "Signs every Wallet Pal session, and the native door's codes.",
} as const;

export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> = {
  id: "wallet-pal-stub",
  required: [
    { name: "WALLET_PAL_SIGN_IN_APP", why: "Names the sign-in application." },
    SECRET_V1,
  ],
  admission: "authority",
  nativeTokenSecret: {
    ...SECRET_V1,
    read: (environment) => environment.WALLET_PAL_SIGN_IN_SECRET,
  },
  create: () => NOBODY_V1,
};
