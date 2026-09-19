import type { BotIsolateProbe } from "./bot-isolate-probe.ts";
import type { FlyHostTransportProbeV1 } from "./computer-host-probe.ts";
import type {
  CompositionProbe,
  ComputerCompatibilityProbe,
  WorkerdBotState,
} from "./computer-compatibility-worker.ts";
import type { UserConfiguration } from "../src/user-configuration.ts";
import type { AppletState } from "../src/applet-state.ts";
import type { DeploymentPolicy } from "../src/deployment-policy.ts";
import type { WorkerdVoiceAssistant } from "./voice-assistant-probe.ts";
import type { D1Migration } from "cloudflare:test";

interface ComputerTestEnv {
  APPLICATION_ARTIFACTS: R2Bucket;
  // The durable-root bucket. `vitest.config.ts` binds it, and a suite that
  // reads a stored file's own bytes or content type heads the object directly.
  MEMORY_FILES: R2Bucket;
  AUTH_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
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
  // The build service the Applet and Plugin hosts post source to. A stand-in
  // here, because a real build needs a container this pool cannot start; the
  // token is what makes the host reach for it rather than call the deployment
  // unable to build.
  APPLET_BUILD: Fetcher;
  APPLET_BUILD_TOKEN: string;
  APPLETS: WorkerLoader;
  APPLET_STATES: DurableObjectNamespace<AppletState>;
  COMPOSITIONS: DurableObjectNamespace<CompositionProbe>;
  COMPUTER_HOST: Fetcher;
  COMPUTER_HOST_CLIENT: DurableObjectNamespace<FlyHostTransportProbeV1>;
  COMPUTER_HOST_SHARDS: string;
  COMPUTER_HOST_TOKEN: string;
  COMPUTER_COMPATIBILITY: DurableObjectNamespace<ComputerCompatibilityProbe>;
  ROUTINE_HOOK_SECRET: string;
  COMPOSIO_API_KEY: string;
  MACHINE_TOKEN_SECRET: string;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  DEPLOYMENT_POLICY: DurableObjectNamespace<DeploymentPolicy>;
  VOICE_ASSISTANTS: DurableObjectNamespace<WorkerdVoiceAssistant>;
}

declare global {
  namespace Cloudflare {
    interface Env extends ComputerTestEnv {}
  }
}
