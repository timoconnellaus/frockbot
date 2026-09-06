export async function toolkitNamespace(
  toolkit: string,
  connectionId: string,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(connectionId),
  );
  return `${toolkit}--${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)}`;
}
