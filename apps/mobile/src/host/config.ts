function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/** Exact trusted hosted application URL accepted by the native shell. */
export function decodeHostedApplicationUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("FROCKBOT_HOSTED_APP_URL is required");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("FROCKBOT_HOSTED_APP_URL must be an absolute URL");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new Error(
      "FROCKBOT_HOSTED_APP_URL must be an HTTPS origin or loopback HTTP origin",
    );
  }
  return url.origin;
}
