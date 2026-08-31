import type { AuthoringProbe } from "./authoring-probe.ts";
import type { BotIsolateProbe } from "./bot-isolate-probe.ts";
import type { ComputerHostClientProbe } from "./computer-host-probe.ts";
import type {
  CompositionProbe,
  FlyCompatibilityProbe,
  WorkerdBotState,
} from "./fly-compatibility-worker.ts";
import type { UserConfiguration } from "../src/user-configuration.ts";

interface FlyTestEnv {
  AUTHORING: DurableObjectNamespace<AuthoringProbe>;
  BOT_ISOLATES: DurableObjectNamespace<BotIsolateProbe>;
  BOT_STATES: DurableObjectNamespace<WorkerdBotState>;
  SECRET_TOKEN: string;
  COMPOSITIONS: DurableObjectNamespace<CompositionProbe>;
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_CLIENT: DurableObjectNamespace<ComputerHostClientProbe>;
  COMPUTER_HOST_SHARDS: string;
  COMPUTER_HOST_TOKEN: string;
  FLY_COMPATIBILITY: DurableObjectNamespace<FlyCompatibilityProbe>;
  FROCKBOT_RUN_LIVE_SPRITE_TEST: string;
  PACKAGE_CATALOG: R2Bucket;
  SPRITES_TOKEN: string;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
}

declare global {
  namespace Cloudflare {
    interface Env extends FlyTestEnv {}
  }
}
