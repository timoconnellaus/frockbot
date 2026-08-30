import type { CapacitorConfig } from "@capacitor/cli";

interface CapacitorEnvironment {
  readonly FROCKBOT_MOBILE_DEV_SERVER_URL?: string;
}

function developmentServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "FROCKBOT_MOBILE_DEV_SERVER_URL must be a valid http(s) origin",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "FROCKBOT_MOBILE_DEV_SERVER_URL must be an http(s) origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

export function createCapacitorConfig(
  environment: CapacitorEnvironment = {
    FROCKBOT_MOBILE_DEV_SERVER_URL: process.env.FROCKBOT_MOBILE_DEV_SERVER_URL,
  },
): CapacitorConfig {
  const configuredUrl = environment.FROCKBOT_MOBILE_DEV_SERVER_URL?.trim();
  const url = configuredUrl ? developmentServerUrl(configuredUrl) : undefined;

  return {
    appId: "com.frockbot.mobile",
    appName: "FrockBot",
    webDir: "dist",
    server: {
      androidScheme: "frockbot",
      ...(url
        ? {
            url,
            cleartext: url.startsWith("http:"),
          }
        : {}),
    },
    plugins: {
      SystemBars: {
        insetsHandling: "css",
      },
    },
  };
}

export default createCapacitorConfig();
