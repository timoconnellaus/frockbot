export function resolveHostedApplicationUrl(value: string | undefined): string {
  const applicationUrl = value?.trim();
  if (!applicationUrl) {
    throw new Error(
      "FROCKBOT_APPLICATION_URL is required for desktop startup",
    );
  }
  let protocol: string;
  try {
    protocol = new URL(applicationUrl).protocol;
  } catch {
    throw new Error("FROCKBOT_APPLICATION_URL must be a valid URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("FROCKBOT_APPLICATION_URL must use HTTP or HTTPS");
  }
  return applicationUrl;
}

export async function startHostedDesktopApplication<T>(
  value: string | undefined,
  start: (applicationUrl: string) => Promise<T>,
): Promise<T> {
  return start(resolveHostedApplicationUrl(value));
}
