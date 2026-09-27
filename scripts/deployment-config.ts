#!/usr/bin/env bun
/**
 * `bun run deployment:config`: `frockbot-deployment-config` over this
 * repository's own profiles, writing into its own `.deployment/` wherever it
 * is run from (ADR 0028 step 3). The generator is `@frockbot/cloudflare`'s
 * (`apps/cloudflare/deployment-config/`), which is what a white-label runs.
 *
 *   bun run deployment:config hosted
 *   bun run deployment:config staging --d1-database-id <uuid>
 */
import { runDeploymentConfigCliV1 } from "../apps/cloudflare/deployment-config/cli.ts";
import {
  PROFILE_DIRECTORY_V1,
  REPO_ROOT_V1,
} from "./deployment-config/repository.ts";

process.exit(
  await runDeploymentConfigCliV1(process.argv.slice(2), {
    profileDirectory: PROFILE_DIRECTORY_V1,
    outputRoot: `${REPO_ROOT_V1}/.deployment`,
    displayRoot: REPO_ROOT_V1,
    command: "bun run deployment:config",
  }),
);
