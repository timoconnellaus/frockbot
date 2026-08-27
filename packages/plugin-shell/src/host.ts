import type { Entry } from "@cordisjs/plugin-webui";
import type { Context } from "cordis";
import type { FrockBotWebData } from "./shared.ts";

export function addFrockBotWebEntry(
  ctx: Context,
  data: FrockBotWebData,
): Entry<FrockBotWebData> {
  const packageUrl = import.meta.resolve("@frockbot/plugin-shell/package.json");
  return ctx.webui.addEntry<FrockBotWebData>(
    {
      modulePath: "@frockbot/plugin-shell",
      baseUrl: packageUrl,
      source: "./src/client/index.ts",
      manifest: "./dist/manifest.json",
      routes: ["/"],
    },
    data,
  );
}
