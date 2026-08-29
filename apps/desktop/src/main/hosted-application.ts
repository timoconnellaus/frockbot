const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface HostedDesktopOrigins {
  applicationUrl: string;
  authBaseUrl: string;
}

function resolveHostedOrigin(
  value: string | undefined,
  variableName: string,
): string {
  const configured = value?.trim();
  if (!configured) {
    throw new Error(`${variableName} is required for desktop startup`);
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${variableName} must be a valid URL`);
  }
  if (url.username || url.password) {
    throw new Error(`${variableName} must not contain credentials`);
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    )
  ) {
    throw new Error(`${variableName} must use HTTPS or loopback HTTP`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${variableName} must be an origin without a path`);
  }
  return url.origin;
}

export function resolveHostedDesktopOrigins(
  applicationValue: string | undefined,
  authValue: string | undefined,
): HostedDesktopOrigins {
  return {
    applicationUrl: resolveHostedOrigin(
      applicationValue,
      "FROCKBOT_APPLICATION_URL",
    ),
    authBaseUrl: resolveHostedOrigin(authValue, "FROCKBOT_AUTH_BASE_URL"),
  };
}

export async function startHostedDesktopApplication<T>(
  applicationValue: string | undefined,
  authValue: string | undefined,
  start: (origins: HostedDesktopOrigins) => Promise<T>,
): Promise<T> {
  return start(resolveHostedDesktopOrigins(applicationValue, authValue));
}
