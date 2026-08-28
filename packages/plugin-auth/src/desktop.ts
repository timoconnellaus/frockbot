import { type Context, type Plugin, Service } from "cordis";

export abstract class DesktopAuthCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopAuthCapability");
  }

  abstract start(): () => void;
}

declare module "cordis" {
  interface Context {
    desktopAuthCapability: DesktopAuthCapability;
  }
}

export const desktopAuthPlugin: Plugin.Function = (ctx) =>
  ctx.desktopAuthCapability.start();
desktopAuthPlugin.inject = ["desktopAuthCapability"];

export default desktopAuthPlugin;
