import type { Entry } from "@cordisjs/plugin-webui";
import type { Context, Plugin } from "cordis";
import type { ClockWebData } from "./shared.ts";

function currentTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date());
}

class ClockHostController {
  private entry: Entry<ClockWebData>;
  private data: ClockWebData;

  constructor(ctx: Context) {
    this.data = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lastTime: currentTime(),
      refresh: () => Promise.resolve(this.refresh()),
    };
    this.entry = ctx.webui.addEntry(
      {
        modulePath: "@frockbot/plugin-clock",
        baseUrl: import.meta.resolve("@frockbot/plugin-clock/package.json"),
        source: "./src/client/index.ts",
        manifest: "./dist/manifest.json",
      },
      this.data,
    );
  }

  dispose(): void {
    this.entry.dispose();
  }

  private refresh(): string {
    const value = currentTime();
    this.entry.mutate((data) => {
      data.lastTime = value;
    });
    return value;
  }
}

export const clockHostPlugin: Plugin.Function = (ctx) => {
  const controller = new ClockHostController(ctx);
  return () => controller.dispose();
};
clockHostPlugin.inject = ["webui"];

export default clockHostPlugin;
