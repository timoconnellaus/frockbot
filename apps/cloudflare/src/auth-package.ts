/**
 * The one place this deployment chooses how people sign in.
 *
 * `AuthPackageV1` is the interface the gateway speaks to sign-in
 * (`core/contracts/auth-package.ts`); better-auth with Google is one
 * implementation and Cloudflare Access is another. Which one this Worker
 * builds is a deployment decision, not an application one, so it is made here,
 * beside the bindings the choice depends on — and it is exactly one import
 * line, so that flipping it is a one-line diff and a `grep` finds it.
 *
 * Stage 3 of ADR 0028 owns the flip: the deployment config generator writes
 * this file's import for the profile it is generating. The hosted profile
 * names better-auth, which is what is written below; the simple profile names
 * Access:
 *
 *     import { ACCESS_AUTH_PACKAGE_V1 as CHOSEN_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/access";
 *
 * `scripts/check-auth-package-imports.ts` keeps the `better-auth` dependency
 * inside `app/auth/better-auth/**` and this file, so the Access build carries
 * none of it. Nothing else in the Worker may name an implementation.
 */
import type { AuthPackageBuildV1 } from "@frockbot/core/contracts";
import { BETTER_AUTH_PACKAGE_V1 as CHOSEN_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/better-auth";
import type { AccessEnvironmentV1 } from "@frockbot/app/auth/access";
import type { BetterAuthEnvironmentV1 } from "@frockbot/app/auth/better-auth";

/**
 * What a Worker must hand whichever Package it built.
 *
 * Both implementations' settings, so the Worker's `env` satisfies either one
 * and flipping the import above is provably a one-line change rather than a
 * rewiring. A Package reads only its own names and answers 503 without them.
 */
export type AuthPackageEnvironmentV1 = BetterAuthEnvironmentV1 &
  AccessEnvironmentV1;

/** The sign-in Package this build deploys. */
export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> =
  CHOSEN_AUTH_PACKAGE_V1;
