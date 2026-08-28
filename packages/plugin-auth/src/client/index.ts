/// <reference path="../env.d.ts" />

import type { ClientPlugin, ClientPluginContext } from "@frockbot/client-core";
import AuthGate from "./AuthGate.vue";
import "@frockbot/client-core/fonts.css";
import "./styles.css";

export const authClientPlugin: ClientPlugin = (ctx: ClientPluginContext) =>
  ctx.slot({ slot: "root", order: 20_000, component: AuthGate });

export default authClientPlugin;
