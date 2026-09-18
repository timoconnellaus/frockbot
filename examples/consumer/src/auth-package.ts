/**
 * A consumer chooser. The id is this product's, not FrockBot's
 * `"better-auth" | "access"` profile enum. Privy (or anything else that
 * implements `AuthPackageV1`) is written the same way.
 */
import type {
  AuthPackageBuildV1,
  AuthPackageV1,
} from "@frockbot/core/contracts";

export type AuthPackageEnvironmentV1 = {
  NATIVE_TOKEN_SECRET?: string;
};

function unconfigured(): AuthPackageV1 {
  const refuse = () =>
    Promise.resolve(
      Response.json(
        { error: "authentication is not configured" },
        { status: 503 },
      ),
    );
  return {
    handler: refuse,
    getSession: async () => null,
    signOut: async (_request, url) =>
      Response.redirect(new URL("/", url.origin)),
    startSignIn: refuse,
  };
}

/** The sign-in Package this consumer deploys. */
export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> = {
  id: "consumer-fixture",
  required: [],
  admission: "package",
  nativeTokenSecret: {
    name: "NATIVE_TOKEN_SECRET",
    why: "Signs the shared native door on a consumer that has no better-auth.",
    read: (environment) => environment.NATIVE_TOKEN_SECRET,
  },
  create: () => unconfigured(),
};
