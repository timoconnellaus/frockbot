/**
 * The import surface a second product's Worker entry uses.
 *
 * A consumer repository writes a thin `index.ts` that re-exports the Durable
 * Object classes and calls `createWorkerApp`. It does not copy this tree.
 *
 * Auth and the Computer host stay choosers the consumer owns:
 *
 * - `#auth-package` — the consumer's wrangler `alias` (or `imports` map)
 *   points at a file that exports `AUTH_PACKAGE_V1` the same way
 *   `auth-package.ts` does. The id is *not* added to `AuthPackageIdV1`;
 *   that enum stays `"better-auth" | "access"` for FrockBot's profiles.
 * - `computer-host.ts` — substitute the host the same way FrockBot's
 *   simple/hosted chooser does: one file beside the bindings.
 *
 * The seeded Plugin catalog is an option on `createWorkerApp`. Omission
 * keeps FrockBot's five locked card Plugins and the rest of this
 * deployment's catalog.
 */
export { createGateway } from "./gateway.js";
export type { GatewayDependencies } from "./contracts.js";
export { createNativeAuth } from "./native-auth.js";
export type { NativeAuth, NativeAuthOptions } from "./native-auth.js";
export {
  configureWorkerAppV1,
  deploymentPluginCatalogV1,
  type WorkerAppOptionsV1,
} from "@frockbot/app/plugins/catalog";
export {
  createWorkerApp,
  BotState,
  UserConfiguration,
  AppletState,
  AppletCapabilities,
  DeploymentPolicy,
  VoiceAssistant,
  BotCapabilities,
  PluginEgress,
  AdminEntrypoint,
} from "./index.js";
