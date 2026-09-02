import type { AuthoringProbe } from "./authoring-probe.ts";
import type { BotIsolateProbe } from "./bot-isolate-probe.ts";
import type { ComputerHostClientProbe } from "./computer-host-probe.ts";
import type {
  CompositionProbe,
  FlyCompatibilityProbe,
  WorkerdBotState,
} from "./fly-compatibility-worker.ts";
import type { UserConfiguration } from "../src/user-configuration.ts";
import type { DeploymentPolicy } from "../src/deployment-policy.ts";

interface FlyTestEnv {
  APPLICATION_ARTIFACTS: R2Bucket;
  AUTHORING: DurableObjectNamespace<AuthoringProbe>;
  AI: Ai;
  BOT_ISOLATES: DurableObjectNamespace<BotIsolateProbe>;
  BOT_STATES: DurableObjectNamespace<WorkerdBotState>;
  CREDENTIAL_KEYRING: string;
  SECRET_TOKEN: string;
  COMPOSITIONS: DurableObjectNamespace<CompositionProbe>;
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_CLIENT: DurableObjectNamespace<ComputerHostClientProbe>;
  COMPUTER_HOST_SHARDS: string;
  COMPUTER_HOST_TOKEN: string;
  FLY_COMPATIBILITY: DurableObjectNamespace<FlyCompatibilityProbe>;
  PACKAGE_CATALOG: R2Bucket;
  SPRITES_TOKEN: string;
  ROUTINE_HOOK_SECRET: string;
  MACHINE_TOKEN_SECRET: string;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  DEPLOYMENT_POLICY: DurableObjectNamespace<DeploymentPolicy>;
}

declare global {
  namespace Cloudflare {
    interface Env extends FlyTestEnv {}
  }
}
