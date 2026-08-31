import type { D1Migration } from "cloudflare:test";

/**
 * Bindings the integration project adds on top of `../env.d.ts`. Both files
 * merge into one `Cloudflare.Env`, so nothing declared there is repeated here.
 */
interface IntegrationTestEnv {
  APPLICATION_ARTIFACTS: R2Bucket;
  AUTH_DB: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  /** The built `dist/artifacts/foundation-v1.mjs`, read by the config. */
  FOUNDATION_ARTIFACT: string;
  /** The remote Package Catalog bucket the /catalog/v1 routes read. */
  PACKAGE_CATALOG: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
}

declare global {
  namespace Cloudflare {
    interface Env extends IntegrationTestEnv {}
  }
}
