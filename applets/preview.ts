// Where an Applet's page is served from, and the URL a Bot is handed to look
// at one before it publishes.
//
// The anonymous artifact origin is `ui.<app host>`: immutable, CSP'd, and
// reaching no data without the HMAC viewer token on the socket
// (`apps/cloudflare/src/gateway.ts`). The hash is the capability, so a preview
// needs no new route and no new authorization — only the artifact, which the
// build already uploaded.

/** The anonymous artifact origin belonging to one app origin. */
export function appletUiArtifactOriginV1(appOrigin: URL): string {
  const host = appOrigin.hostname;
  const artifactHost =
    host === "localhost" || host === "127.0.0.1"
      ? "ui.localhost"
      : host.startsWith("ui.")
        ? host
        : `ui.${host}`;
  return `${appOrigin.protocol}//${artifactHost}${appOrigin.port ? `:${appOrigin.port}` : ""}`;
}

/** The page one built UI artifact is served at. */
export function appletPreviewUrlV1(appOrigin: URL, uiHash: string): string {
  return `${appletUiArtifactOriginV1(appOrigin)}/packages/${uiHash}.html`;
}
