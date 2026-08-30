import type { CapacitorConfig } from "@capacitor/cli";
import { decodeHostedApplicationUrl } from "./src/host/config.ts";

const hostedApplicationUrl = decodeHostedApplicationUrl(
  process.env.FROCKBOT_HOSTED_APP_URL,
);

const config: CapacitorConfig = {
  appId: "com.frockbot.mobile",
  appName: "FrockBot",
  webDir: "dist",
  server: {
    url: hostedApplicationUrl,
    cleartext: hostedApplicationUrl.startsWith("http://"),
  },
  includePlugins: [],
  plugins: {
    SystemBars: {
      insetsHandling: "css",
    },
  },
};

export default config;
