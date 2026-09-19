import type { BotState } from "./bot-state.js";
import type { UserConfiguration } from "./user-configuration.js";
import type {
  AssertRpcTargetV1,
  BotStateRpcTargetV1,
  BotUserConfigurationRpcTargetV1,
} from "@frockbot/app/shell/durable-rpc-targets";

/** Compile-time checks that either Durable Object RPC surface cannot drift. */
export type UserConfigurationRpcTargetTestV1 = AssertRpcTargetV1<
  BotUserConfigurationRpcTargetV1,
  UserConfiguration
>;
export type BotStateRpcTargetTestV1 = AssertRpcTargetV1<
  BotStateRpcTargetV1,
  BotState
>;
