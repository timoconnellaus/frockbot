// A white-label's own auth Package chooser, as its profile names it by path,
// for the generator's tests. It signs nobody in: what is under test is how the
// generator aliases it and holds it to its profile (ADR 0038 §3).
import type {
  AuthPackageBuildV1,
  AuthPackageV1,
} from "../../../../core/contracts/auth-package.ts";

export interface AuthPackageEnvironmentV1 {
  STUB_SIGN_IN_APP_ID?: string;
  STUB_SIGN_IN_SECRET?: string;
}

const nobody: AuthPackageV1 = {
  handler: async () => new Response(null, { status: 404 }),
  getSession: async () => null,
  signOut: async () => Response.redirect("https://wallet-pal.example/", 302),
  startSignIn: async () => new Response(null, { status: 503 }),
};

export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> = {
  id: "stub-sign-in",
  required: [
    { name: "STUB_SIGN_IN_APP_ID", why: "Names the sign-in application." },
    { name: "STUB_SIGN_IN_SECRET", why: "Signs every session." },
  ],
  admission: "authority",
  nativeTokenSecret: {
    name: "STUB_SIGN_IN_SECRET",
    why: "Signs every session.",
    read: (environment) => environment.STUB_SIGN_IN_SECRET,
  },
  create: () => nobody,
};
