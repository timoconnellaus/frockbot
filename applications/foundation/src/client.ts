import type { ClientPlugin } from "@frockbot/client-core";
import authClientPlugin from "@frockbot/plugin-auth/client";

// The immutable application owns the concrete client contribution list.
// pi-lens-ignore: ts:2307
import clockClientPlugin from "@frockbot/plugin-clock/client";
import computerClientPlugin from "../../../packages/plugin-computer/src/client/application.js";
import shellClientPlugin from "@frockbot/plugin-shell/client";

export const foundationClientPlugins: readonly ClientPlugin[] = [
  authClientPlugin,
  shellClientPlugin,
  clockClientPlugin,
  computerClientPlugin,
];
