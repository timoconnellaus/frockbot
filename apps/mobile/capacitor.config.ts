import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.frockbot.mobile",
  appName: "FrockBot",
  webDir: "dist",
  server: {
    androidScheme: "frockbot",
  },
};

export default config;
