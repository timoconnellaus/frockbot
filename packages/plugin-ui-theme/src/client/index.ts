import type { ClientPlugin } from "@frockbot/client-core";
import "./tokens.generated.css";
import "./theme.css";
import { defineClientContribution } from "@frockbot/kernel-contracts/contributions";

export const uiThemeClientPlugin: ClientPlugin = () => undefined;

export default uiThemeClientPlugin;

/**
 * The manifest's `client` entry, resolved by specifier. The application looks
 * this descriptor up in its Contribution table; it never branches on which
 * Package it belongs to.
 */
export const clientContribution = defineClientContribution<ClientPlugin>({
  specifier: "@frockbot/plugin-ui-theme/client",
  plugin: uiThemeClientPlugin,
});
