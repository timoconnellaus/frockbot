# Local client UI for the desktop and mobile shells (`local-client-ui`)

## Status

Code read 2026-09-02, read-only. No production code changed. Answers the question: can the desktop
and mobile shells serve the FrockBot UI from local disk rather than fetching it over the network, and
if they do, can plugin-driven UI changes still reach the client?

Findings in one paragraph. **Local delivery is feasible on desktop and cheap; on mobile it directly
contradicts ADR 0008 and costs an ADR.** The plugin-update worry is misplaced: plugin UI is not
dynamically loaded at all, so one `applicationHash` identifies the entire UI and "sync plugin changes"
reduces to "swap one cached bundle". Before any of that, there is a plain defect worth fixing on its
own — immutable content-addressed UI bytes are served at unversioned URLs with `cache-control:
no-cache`, so nothing at any layer caches the UI and every launch re-downloads all of it.

Read at `88c11b1` (`origin/main`). **Note for future readers:** an earlier pass of this research read
`feat/ollama-user-connections` (`18b7809`), which is 257 commits behind `main`. Several conclusions
differed materially — mobile in particular. Everything below is verified against `main`.

Sources read (`node_modules` excluded):

- `apps/desktop/src/main/{cordis-host,hosted-application,desktop-api,auth-client}.ts`,
  `apps/desktop/electron.vite.config.ts`
- `apps/mobile/capacitor.config.ts`, `apps/mobile/src/host/{config,hosted,index,adapters}.ts`
- `apps/cloudflare/src/{user-application,gateway,index,package-publication}.ts`,
  `apps/cloudflare/src/client/index.ts`, `apps/cloudflare/{vite.config.ts,build-artifact.ts,wrangler.jsonc}`
- `applications/foundation/src/client.ts`, `packages/client-core/src/index.ts`
- `packages/kernel-composition/src/{manifest,compiler}.ts`
- `docs/architecture.md`, `docs/adr/000{2,5,7}-*.md`,
  `docs/adr/0008-direct-hosted-mobile-with-optional-contributions.md`

External docs via context7: Electron `protocol`/`net`; Capacitor configuration; Capgo
`capacitor-updater`.

## 1. What ships today

### Desktop is a pure thin shell

`apps/desktop/src` contains only `main/` and `preload/` — there is **no `renderer/` directory**. The
window is one call (`apps/desktop/src/main/cordis-host.ts:71`):

```ts
await window.loadURL(this.config.baseUrl);
```

`baseUrl` is `FROCKBOT_APPLICATION_URL` (`cordis-host.ts:182`), validated in
`hosted-application.ts` (HTTPS or loopback HTTP; bare origin; no credentials) and **required** —
startup fails and the app quits if it is unset. There is no local fallback by design. The window is
origin-pinned with window-open denied (`cordis-host.ts:62-63`) under `contextIsolation: true`,
`sandbox: true` (`cordis-host.ts:54-56`).

No `protocol.registerSchemesAsPrivileged`, no `protocol.handle`, no `loadFile` anywhere in
`apps/desktop`. The only custom scheme is the OAuth deep link `com.frockbot.desktop:`.

### Mobile navigates directly to the hosted origin

This changed recently and is the single most important correction to make. ADR 0005 (local shell +
hosted iframe + `postMessage` proxy) is **superseded** by
`docs/adr/0008-direct-hosted-mobile-with-optional-contributions.md`. Capacitor now sets `server.url`
to the hosted origin (`apps/mobile/capacitor.config.ts:61-66`), so the hosted application is the
**WebView's top-level origin**. There is no `apps/mobile/src/client/` any more — only `src/host/` —
and the CSP has correspondingly tightened to `frame-ancestors 'none'`
(`apps/cloudflare/src/user-application.ts:108`).

So mobile is currently _more_ remote than desktop, not less.

A local Cordis root may mount only mobile Contributions declared by the immutable application, and it
gates that on the loaded document — `apps/mobile/src/host/hosted.ts:345` reads
`meta[name="frockbot-application"]` and refuses to mount unless the origin and hash match
(`hosted.ts:298-301`). **This is a working precedent for hash-based gating in a shell** and is
directly reusable for cache revalidation.

### The whole UI is one bundle, inlined into a per-User Worker artifact

`applications/foundation/src/client.ts:18` is a **hardcoded array** — no dynamic import, no registry
lookup. It now holds 13 client plugins (`ui-theme`, `auth`, `shell`, `admin`, `computer`, `flock`,
`search`, `settings`, `routines`, `bot-template`, `audit`, `package-publisher`, `user-machine`), with
inline comments pinning the order because later plugins mount into slots earlier ones declare.

`apps/cloudflare/vite.config.ts:39,42` sets `cssCodeSplit: false` and
`assetsInlineLimit: Number.POSITIVE_INFINITY` so exactly one JS and one CSS payload exist. Both are
read as text and injected as string constants into the Worker module
(`apps/cloudflare/build-artifact.ts:48-49`), then read back at `user-application.ts:31-46`.

The gateway resolves the User's active `applicationHash` per request and loads a distinct dynamic
Worker per `(userId, applicationHash)` (`apps/cloudflare/src/gateway.ts:515-516,525-526`), reading
artifact bytes from R2.

**One `applicationHash` therefore identifies the entire UI**, every plugin included.

## 2. The defect worth fixing regardless

### 2.1 Immutable bytes at mutable URLs with caching disabled

`apps/cloudflare/src/user-application.ts:182-211` serves all three assets identically:

```ts
if (request.method === "GET" && url.pathname === "/app.js") {
  return withSecurityHeaders(new Response(APP_JS, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
  }));
```

`/app.js`, `/app.css` and `/favicon.ico` are **unversioned paths**, all `no-cache`. There is no
`ETag`, no `max-age`, no `immutable` and no conditional-request handling on any of them, nor on `/`
or `/app-manifest`. Every launch re-downloads the entire UI.

This is almost certainly the dominant cause of the app feeling slow, and it is independent of where
the shell lives. It should be measured and fixed before any shell work is scoped.

### 2.2 The precedent already exists in the same file

Workspace file reads are already served content-addressed with a validator
(`user-application.ts:469-473`):

```ts
headers: {
  "content-type": "application/octet-stream",
  "cache-control": "private, max-age=60",
  etag: `"${answer.contentHash}"`,
},
```

So the house pattern for cacheable content-addressed responses is established; the app bundle simply
does not use it.

## 3. Does local delivery reopen an accepted decision?

Desktop and mobile answer differently, which is why they should be sequenced separately.

**Desktop: no real conflict.** The relevant statements are `docs/architecture.md` describing Electron
main as a hosted-URL window with no local WebUI, and requiring the hosted origin. Both remain true
under a local _cache_: the hosted origin stays authoritative and still required, and the cache is a
delivery optimisation with network fallback, not an alternate runtime or a second implementation.
Worth an amendment to the wording, not a reversal.

**Mobile: a genuine conflict.** ADR 0008 states "the hosted origin is required at build time and is
the WebView's top-level origin", and it explicitly rejected "retain a local frame and API proxy"
because it "adds a second authentication and transport path around the hosted application". Serving
the bundle locally means the top-level origin is no longer the hosted one, which is the load-bearing
clause. A pure byte cache does _not_ add a second auth or transport path — the objection ADR 0008
actually raises — so the case is arguable, but it requires a new ADR superseding 0008 rather than an
amendment.

The older ADR 0005 reasoning is worth preserving in whatever replaces it: what was rejected there was
a _second implementation of the product_, not local delivery of identical bytes. Local caching
duplicates no product code and keeps one UI implementation, so it does not revive that problem.

## 4. Plugin-driven UI updates

The premise of the original question does not hold yet, and that is good news.

### There is no dynamic plugin UI, in remote or local delivery

A plugin's client contribution is a Vue 3 `ClientPlugin` function (`packages/client-core/src/index.ts`)
registering components into named slots declared in `frockbot.json`
(`contributions.client.{entry,mounts,outlets}`, validated in `packages/kernel-composition/src/manifest.ts`
and `compiler.ts`). It mounts **directly into the host page** — same origin, one Vue app at `#app`, no
iframe, no shadow DOM, no sandbox.

Because `applications/foundation/src/client.ts` is a hardcoded list, **adding a plugin's UI requires
rebuilding and republishing the whole application artifact.** Bot-authored packages — the Worker
Loader isolate path — contribute tools and backend behaviour only; they have no client contribution.

Consequences:

1. "Plugins change the UI, so the client must sync them" reduces to **"the hash changed, swap one
   cached bundle."** There is no per-plugin sync protocol to design, and no partial-update problem.
2. Local delivery does **not** block a future dynamic plugin UI, and is not what stands in its way.
3. `docs/architecture.md:152` requires untrusted or generated rich UI to use a "sandbox-view
   contribution rendered in a separately permissioned frame". **That contribution does not exist** —
   grep finds the phrase only on that one doc line. Genuinely dynamic third-party UI needs it first.

### There is no push channel

No `WebSocketPair`, no `EventSource`, no `text/event-stream` in `apps/cloudflare/src` or the client
packages. A "your UI changed" signal has no existing transport to borrow. It almost certainly does not
need one: revalidating on launch and on window focus is sufficient for a bundle that changes at
publish frequency.

There is also no cheap version ping. The hash is reachable via `GET /` (HTML meta at
`user-application.ts:89,95`), `/app-manifest` (`:214`), or `GET /api/package-revisions` — none
designed for polling, and `/app-manifest` compiles the plan on every call.

### The dormant per-plugin mechanism

`bun run build:webui` (`package.json:16`) runs `vite build` across eight packages, emitting ESM
library bundles at `packages/<plugin>/dist/assets/<name>-<hash>.js` plus `dist/manifest.json`.
**Nothing imports or serves these** in the hosted path; the only consumer is the Cordis WebUI
`ctx.webui.addEntry` path, whose registrar is never called, and in the hosted build `useRpc` is
aliased to a throwing stub.

So `bun run dev` and `bun run build` both execute an effectively dead step today. It is also the
closest ready-made shape for dynamic per-plugin UI — hash-named files plus a manifest — should that
ever be wanted.

## 5. Feasibility of the mechanisms

### Desktop: privileged `app://` scheme

Electron's `protocol.handle`, with a scheme registered `standard: true, secure: true,
supportFetchAPI: true`, can serve local bytes and proxy remote requests **from the same handler**,
switching on host (`app://bundle/...` vs `app://api/...`). Electron's security guidance recommends a
custom protocol over `file://`, since `file://` pages get unilateral filesystem read access.
Path-traversal checking is the caller's responsibility.

The usual blocker — CSP `connect-src 'self'` breaking API calls from a new origin — is unusually
cheap here:

- **Desktop API traffic already bypasses page `fetch`.** The client branches on `window.frockbotDesktop`
  and routes over Electron IPC (`apps/cloudflare/src/client/index.ts:66,125,307`); the main process
  makes the real call against `FROCKBOT_AUTH_BASE_URL` behind an exact route allowlist
  (`apps/desktop/src/main/desktop-api.ts`, `auth-client.ts`).
- Session cookies live in the main process, not renderer storage, so an origin change does not lose
  the session.
- `frame-ancestors` is now `'none'` (`user-application.ts:108`) and would need revisiting only if
  something is framed.

### Mobile: harder than it looks

With `server.url` in force, Capgo `capacitor-updater` does **not** apply as-is — it swaps the local
`webDir` bundle, which `server.url` overrides. Going local on mobile means reverting to a local bundle
and thereby changing the top-level origin, which is precisely what ADR 0008 fixed. Capgo's mechanics
(self-hosted `updateUrl`, `download()` + `set()`, `getLatest()`, and `notifyAppReady()` rollback that
reverts to last-known-good on failed init) map well onto the codebase's existing supersede-never-edit
and last-known-good semantics — but the ADR question has to be settled first.

## 6. Recommended sequencing

**Stage 0 — version the asset URLs. No architecture change, no ADR.** Serve `/app.<hash>.js` and
`/app.<hash>.css` with `cache-control: public, max-age=31536000, immutable`; keep `GET /` at
`no-cache` pointing at the hashed URLs. The hash is already in scope at the generation site
(`user-application.ts:89`), and the ETag pattern already exists in the same file. This benefits
browser, Electron and mobile simultaneously with no shell changes. **Do this first and measure** — it
may be most of the win, and it makes Stages 1-2 much smaller.

**Stage 1 — desktop local cache.** Register a privileged `app://` scheme; `protocol.handle` serves
hashed assets from an on-disk cache keyed by **`(userId, applicationHash)`**, falling through to the
network on miss. Boot from cache, revalidate `GET /` in the background, adopt a new hash on next
launch. Reuse the hash-comparison logic already proven in `apps/mobile/src/host/hosted.ts:298-301`.

**Stage 2 — mobile, only if Stage 0 proves insufficient.** Requires a new ADR superseding 0008.
Weigh honestly against simply keeping `server.url` plus Stage 0 caching, which preserves the current
decision and may well be enough.

**Stage 3 — dynamic per-plugin UI. Separate project, not required by any of the above.** Would revive
the dormant `dist/` ESM + `manifest.json` path, replace the hardcoded client list, and — for anything
untrusted — first implement the `sandbox-view` contribution that `docs/architecture.md:152` requires
and does not have.

## 7. Open risks

- **Cache key must include `userId`.** Artifacts are per-User (`gateway.ts:515-516`); a hash-only
  cache would serve one User's UI to another on a shared machine.
- **Rollback moves the hash backwards.** Content-addressed caching handles this by construction, but
  any "newer wins" comparison would not. Compare for _inequality_, never ordering.
- **Stage 0 changes a verified contract.** Publication health checks fetch the literal paths `/`,
  `/app.js`, `/app.css` (`apps/cloudflare/src/package-publication.ts:155-157`); renaming assets
  without updating that check fails every publish. This is the single most likely way to break
  production with an otherwise safe change.
- **Anonymous asset access.** `/`, `/app.js`, `/app.css` and `/favicon.ico` are public under a
  synthetic `anonymous` user (`gateway.ts:24-30,311-312`), which allows pre-authentication prefetch — but the
  anonymous artifact is the default, not the User's, so prefetched bytes must never be cached under a
  real User's key.
- **Mobile needs an ADR, not an amendment.** See §3.
- **This research read `main` at `88c11b1`.** The active feature branch is 257 commits behind; do not
  re-derive these line numbers from it.
