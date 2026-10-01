/**
 * Prints a fresh `WEB_PUSH_VAPID_KEYS` value for a deployment profile under
 * `deployments/`, with that profile's app origin as the subject.
 *
 *   bun scripts/web-push-keys.ts hosted
 *   bun scripts/web-push-keys.ts staging
 *
 * A deploy-bundle install mints its own; this is for the hosted and staging
 * secrets, which live in GitHub environments.
 */
import { fileURLToPath } from "node:url";
import { loadProfileV1 } from "../apps/cloudflare/deployment-config/profile.ts";
import { appHostnameV1, vapidKeysV1 } from "./deploy-bundle/simple-profile.ts";

const name = process.argv[2];
if (!name) {
  console.error("usage: bun scripts/web-push-keys.ts <profile>");
  process.exit(2);
}
process.stdout.write(
  await vapidKeysV1(
    appHostnameV1(
      loadProfileV1(
        name,
        fileURLToPath(new URL("../deployments", import.meta.url)),
      ),
    ),
  ),
);
