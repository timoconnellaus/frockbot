const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const DEVELOPMENT_USER_ID = "development";

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function developmentUserFromUrl(url: URL): string | undefined {
  if (!isLoopbackHost(url.hostname)) return undefined;
  return url.searchParams.get("as_user") === DEVELOPMENT_USER_ID
    ? DEVELOPMENT_USER_ID
    : undefined;
}

export function developmentLoginUrl(url: URL): string {
  try {
    const loginUrl = new URL(url.href);
    loginUrl.searchParams.set("as_user", DEVELOPMENT_USER_ID);
    return loginUrl.toString();
  } catch {
    return url.toString();
  }
}
