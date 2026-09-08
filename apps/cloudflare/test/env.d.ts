import type { BotIsolateProbe } from "./bot-isolate-probe.ts";
import type { FlyHostTransportProbeV1 } from "./computer-host-probe.ts";
import type {
  CompositionProbe,
  FlyCompatibilityProbe,
  WorkerdBotState,
} from "./fly-compatibility-worker.ts";
import type { UserConfiguration } from "../src/user-configuration.ts";
import type { AppletState } from "../src/applet-state.ts";
import type { DeploymentPolicy } from "../src/deployment-policy.ts";

interface FlyTestEnv {
  APPLICATION_ARTIFACTS: R2Bucket;
  AI: Ai;
  BOT_ISOLATES: DurableObjectNamespace<BotIsolateProbe>;
  BOT_STATES: DurableObjectNamespace<WorkerdBotState>;
  MEMORY_INDEX_PROBE: {
    deletedBatches(): Promise<string[][]>;
    reset(): Promise<boolean>;
  };
  CREDENTIAL_KEYRING: string;
  SECRET_TOKEN: string;
  APPLET_VIEWER_SECRET: string;
  APPLETS: WorkerLoader;
  APPLET_STATES: DurableObjectNamespace<AppletState>;
  COMPOSITIONS: DurableObjectNamespace<CompositionProbe>;
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_CLIENT: DurableObjectNamespace<FlyHostTransportProbeV1>;
  COMPUTER_HOST_SHARDS: string;
  COMPUTER_HOST_TOKEN: string;
  FLY_COMPATIBILITY: DurableObjectNamespace<FlyCompatibilityProbe>;
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
