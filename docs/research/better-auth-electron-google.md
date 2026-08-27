# Better Auth: Electron + Google on Cloudflare

Research date: 2026-08-27

## Decisions

- Use Better Auth's official Electron integration rather than an OAuth flow inside an embedded `BrowserWindow`. The integration opens the system browser, uses PKCE/state, redirects through a registered reverse-domain custom scheme, and keeps session credentials in Electron's main process.
- Expose only the package's safe preload IPC bridge to the sandboxed renderer. Do not expose the auth client, cookies, tokens, or Node APIs.
- Mount Better Auth at `/api/auth/*` in the Cloudflare gateway and use a D1 binding for durable users, accounts, sessions, and verification state.
- Configure Google as a Web application OAuth client. Both desktop and browser flows return to the hosted Better Auth callback; the desktop flow then transfers the authenticated session back through the custom protocol.
- Keep the existing explicit development identity header only as a local test seam. Production application routing derives the user ID from the Better Auth session.

## Required configuration

- Better Auth server: explicit `baseURL`, strong `BETTER_AUTH_SECRET`, D1 database, `socialProviders.google`, official `electron()` plugin, and `com.frockbot.desktop:/` in `trustedOrigins`.
- Electron main process: official `electronClient()`, `setupMain()` before `app.ready`, system-browser sign-in URL, persistent main-process storage, and custom protocol scheme `com.frockbot.desktop`.
- Electron preload: call `setupRenderer()` while retaining `contextIsolation: true`, `nodeIntegration: false`, and Chromium sandboxing.
- Web sign-in page: official proxy client, preserve Electron PKCE/state query parameters when calling `signIn.social`, and call `ensureElectronRedirect()`.
- Google console redirect URIs: `http://127.0.0.1:8787/api/auth/callback/google` for local development and `https://<production-host>/api/auth/callback/google` in production.

## Sources

- Better Auth, **Electron Integration**: <https://better-auth.com/docs/integrations/electron>
- Better Auth, **Google**: <https://better-auth.com/docs/authentication/google>
- Better Auth, **Hono Integration / Cloudflare Workers notes**: <https://better-auth.com/docs/integrations/hono>
- Better Auth, **Database / programmatic migrations**: <https://better-auth.com/docs/concepts/database>
- Better Auth, **Options reference**: <https://better-auth.com/docs/reference/options>
- Better Auth, **1.5 release / first-class D1 support**: <https://better-auth.com/blog/1-5>
