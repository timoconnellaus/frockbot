import type { CapacitorConfig } from "@capacitor/cli";
import { decodeHostedApplicationUrl } from "./src/host/config.ts";

interface CapacitorEnvironment {
  readonly FROCKBOT_MOBILE_DEV_SERVER_URL?: string;
  /**
   * The hosted WebUI this shell opens (ADR 0005). Present in a production
   * build, so the container is a thin shell over the hosted origin rather than
   * a second copy of the product.
   */
  readonly FROCKBOT_HOSTED_APP_URL?: string;
  /**
   * Google Web OAuth client ID used as the audience of Android ID tokens.
   * This is public build configuration, not the Google client secret.
   */
  readonly FROCKBOT_GOOGLE_WEB_CLIENT_ID?: string;
}

const GOOGLE_WEB_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function decodeGoogleWebClientId(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("FROCKBOT_GOOGLE_WEB_CLIENT_ID is required");
  }
  const clientId = input.trim();
  const identifier = clientId.slice(0, -GOOGLE_WEB_CLIENT_ID_SUFFIX.length);
  if (
    !clientId.endsWith(GOOGLE_WEB_CLIENT_ID_SUFFIX) ||
    !identifier ||
    identifier.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(identifier)
  ) {
    throw new Error(
      "FROCKBOT_GOOGLE_WEB_CLIENT_ID must be a Google Web OAuth client ID",
    );
  }
  return clientId;
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
    FROCKBOT_HOSTED_APP_URL: process.env.FROCKBOT_HOSTED_APP_URL,
    FROCKBOT_GOOGLE_WEB_CLIENT_ID: process.env.FROCKBOT_GOOGLE_WEB_CLIENT_ID,
  },
): CapacitorConfig {
  const configuredUrl = environment.FROCKBOT_MOBILE_DEV_SERVER_URL?.trim();
  const hostedUrl = environment.FROCKBOT_HOSTED_APP_URL?.trim();
  const configuredGoogleClientId =
    environment.FROCKBOT_GOOGLE_WEB_CLIENT_ID?.trim();
  const googleWebClientId =
    hostedUrl || configuredGoogleClientId
      ? decodeGoogleWebClientId(configuredGoogleClientId)
      : undefined;
  // Live reload wins while developing; otherwise the shell opens the hosted
  // WebUI when one is configured, and bundled assets when it is not.
  const url = configuredUrl
    ? developmentServerUrl(configuredUrl)
    : hostedUrl
      ? decodeHostedApplicationUrl(hostedUrl)
      : undefined;

  return {
    appId: "com.frockbot.mobile",
    appName: "FrockBot",
    webDir: "dist",
    // The shell bundles no native plugins of its own; platform capabilities
    // are progressive enhancements declared by Packages.
    includePlugins: [],
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
      ...(googleWebClientId
        ? {
            FrockBotGoogleAuth: {
              serverClientId: googleWebClientId,
            },
          }
        : {}),
    },
  };
}

export default createCapacitorConfig();
