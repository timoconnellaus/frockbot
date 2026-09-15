/**
 * How a simple deployment signs people in: Cloudflare Access, and nothing
 * stored anywhere.
 *
 * The twin of `auth-package.ts`, which is the tracked default. A profile whose
 * `authPackage` is `access` makes the generator write
 * `alias: { "#auth-package": "<this file> }` into the app Worker's config, and
 * wrangler resolves every `#auth-package` import here instead — so the Access
 * bundle carries no better-auth and the hosted bundle carries no Access
 * verifier. Neither file imports the other, which is what makes that true.
 *
 * `tsconfig.access.json` type-checks the whole Worker against this file, so an
 * `env` name only the hosted build has cannot reach the Access build unnoticed.
 */
import type { AuthPackageBuildV1 } from "@frockbot/core/contracts";
import { ACCESS_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/access";
import type { AccessEnvironmentV1 } from "@frockbot/app/auth/access";

/** What a Worker must hand the Package this build deploys. */
export type AuthPackageEnvironmentV1 = AccessEnvironmentV1;

/** The sign-in Package this build deploys. */
export const AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1> =
  ACCESS_AUTH_PACKAGE_V1;
