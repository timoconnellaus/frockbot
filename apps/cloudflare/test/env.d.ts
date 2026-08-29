import type { FlyCompatibilityProbe } from "./fly-compatibility-worker.ts";

interface FlyTestEnv {
  FLY_COMPATIBILITY: DurableObjectNamespace<FlyCompatibilityProbe>;
  FROCKBOT_RUN_LIVE_SPRITE_TEST: string;
  SPRITES_TOKEN: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends FlyTestEnv {}
  }
}
