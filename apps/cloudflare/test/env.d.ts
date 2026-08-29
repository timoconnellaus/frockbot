import type {
  FlyCompatibilityProbe,
  WorkerdBotState,
} from "./fly-compatibility-worker.ts";
import type { UserConfiguration } from "../src/user-configuration.ts";

interface FlyTestEnv {
  BOT_STATES: DurableObjectNamespace<WorkerdBotState>;
  FLY_COMPATIBILITY: DurableObjectNamespace<FlyCompatibilityProbe>;
  FROCKBOT_RUN_LIVE_SPRITE_TEST: string;
  SPRITES_TOKEN: string;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
}

declare global {
  namespace Cloudflare {
    interface Env extends FlyTestEnv {}
  }
}
