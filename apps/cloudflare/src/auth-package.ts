/**
 * How the hosted deployment signs people in: better-auth with Google.
 *
 * `AuthPackageV1` is the interface the gateway speaks to sign-in
 * (`core/contracts/auth-package.ts`); this file and `auth-package.access.ts`
 * are the two builds of it, and each is exactly one value import, so that a
 * build is a one-line file and a `grep` finds it.
 *
 * This is the one the tracked source resolves: `wrangler dev`, every suite and
 * the hosted deploy all reach it through `#auth-package`, which
 * `apps/cloudflare/package.json` maps here. A profile whose `authPackage` is
 * `access` gets a generated wrangler config carrying
 * `alias: { "#auth-package": "<path to auth-package.access.ts>" }`, so the
 * Access build resolves that specifier to the other file and this one is not in
 * its bundle at all.
 *
 * `scripts/check-auth-package-imports.ts` keeps the `better-auth` dependency
 * inside `app/auth/better-auth/**` and this file. Nothing else in the Worker may
 * name an implementation.
 */
import type { AuthPackageBuildV1 } from "@frockbot/core/contracts";
import { BETTER_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/better-auth";
import type { BetterAuthEnvironmentV1 } from "@frockbot/app/auth/better-auth";

/**
 * What a Worker must hand the Package this build deploys.
 *
 * One Package's settings, not both: the Worker's `env` declares every name
 * either build reads, and the build that is not here reads none of it. Each
 * chooser exports this name, so `index.ts` is the same file on both builds.
 */
export type AuthPackageEnvironmentV1 = BetterAuthEnvironmentV1;

/** The sign-in Package this build deploys. */
export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> =
  BETTER_AUTH_PACKAGE_V1;
