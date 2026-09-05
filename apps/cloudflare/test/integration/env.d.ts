import type { D1Migration } from "cloudflare:test";

/**
 * Bindings the integration project adds on top of `../env.d.ts`. Both files
 * merge into one `Cloudflare.Env`, so nothing declared there is repeated here.
 */
interface IntegrationTestEnv {
  BETTER_AUTH_SECRET: string;
  APPLICATION_ARTIFACTS: R2Bucket;
  AUTH_DB: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  /** The built `dist/artifacts/foundation-v1.mjs`, read by the config. */
  FOUNDATION_ARTIFACT: string;
  /** The remote Package Catalog bucket the /catalog/v1 routes read. */
  /** The bucket the durable-root Workspace store writes through. */
  MEMORY_FILES: R2Bucket;
  PACKAGE_CATALOG: R2Bucket;
  TEST_MIGRATIONS: D1Migration[];
  /**
   * The Frock AI fake's RPC entrypoint under a second name. `AI` itself is
   * bound to the same entrypoint, but its production type is Cloudflare's
   * `Ai`, which has no call log; this alias is how a test reads one without
   * widening the deployed `Env`.
   */
  AI_PROBE: Service;
}

declare global {
  namespace Cloudflare {
    interface Env extends IntegrationTestEnv {}
  }
}
