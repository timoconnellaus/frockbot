/// <reference path="../env.d.ts" />

import type { ClientPlugin, ClientPluginContext } from "@frockbot/client-core";
import { authSessionClientKey } from "../shared.js";
import AuthGate from "./AuthGate.vue";
import { createBrowserAuthSessionClient } from "./browser.js";
import "@frockbot/client-core/fonts.css";
import "./styles.css";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const authClientPlugin: ClientPlugin = (ctx: ClientPluginContext) => [
  ctx.provide(authSessionClientKey, createBrowserAuthSessionClient()),
  ctx.slot({ slot: "root", order: 20_000, component: AuthGate }),
];

export default authClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-auth/client",
  plugin: authClientPlugin,
});
