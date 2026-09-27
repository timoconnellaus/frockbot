# ADR 0038: White-label deployments build FrockBot from published packages

Status: accepted, 2026-09-27. Decisions are Tim's from the 2026-09-27
discussion. This is the "customised deployments come later, through published
packages" that [ADR 0028](0028-open-deployment.md) left open.

- A white-label product is its own repository. It is not a fork, a submodule
  or a branch of this one: it installs FrockBot's packages at a release version
  and adds its own profile, brand and client shell.
- The first one is a crypto product. It signs people in with Privy, themes
  differently and uses its own Bot characters.
- Privy stays out of this repository. The white-label writes its own auth
  Package against the published contract, and requires an email at sign-in, so
  every User it admits has one.
- Everything a white-label needs to differ in is a build-time seam here, chosen
  the way the auth Package and the Computer host already are. Nothing is chosen
  at runtime, and no white-label code runs inside this repository's builds.

## Context

ADR 0028 made the deployment a profile and sign-in a Package, and kept one rule
open for this: every deployment choice goes through a build-time seam, never an
`env` read scattered through the app. What stops a second product today:

- **Nothing is importable.** `@frockbot/applet-sdk` is the only workspace a
  release publishes. `core`, `app`, `providers`, `computer`, `frock-compose`,
  `applets` and the Worker itself (`apps/cloudflare`) are `private`, and depend
  on each other as `workspace:*`.
- **The Worker's seams point into this repository.** `#auth-package` is a
  subpath import whose other build is a generated wrangler `alias` to a second
  file beside it. A consumer cannot name a file of its own, and the generator
  that writes the alias is a script under `scripts/`.
- **The brand is written in.** The server names FrockBot in about 85 files
  (`displayName: "FrockBot"` in `app/shell/definition.ts`, Frock AI as the
  built-in model's name, email senders, page titles); `build-artifact.ts` reads
  the FrockBot icon from `assets/marketing`; `native-auth.ts` serves
  `assetlinks.json` and `apple-app-site-association` naming
  `com.frockbot.mobile`, its signing fingerprint and Apple team.
- **The client is one application.** `apps/native` is `publish_to: none`, its
  characters are ten Rive and PNG pairs enumerated in `lib/flock/avatar.dart`
  and `lib/voice/appearance.dart`, and its user-visible strings say FrockBot.
- **An auth Package can only come from here.** The profile's `authPackage` is
  an enum of the two choosers in `apps/cloudflare/src`.

## Decision

### 1. The Worker is a published package, and its seams are module specifiers

`apps/cloudflare` is published as `@frockbot/cloudflare`, TypeScript source as
the other workspaces are, because wrangler bundles it. A white-label's wrangler
config sets `main` to `@frockbot/cloudflare/src/index.ts` and resolves the
Worker's seams with `alias`, which is exactly how the Access build already
works. Two seams exist, and adding a third is a change to this ADR:

- `#auth-package` — the auth Package chooser. The profile's `authPackage`
  names one of the two this repository ships, or a path (relative to the
  profile) to a chooser module the white-label wrote (§3).
- `#brand` — a module exporting `BRAND_V1: BrandV1` (§2). The tracked default
  is `apps/cloudflare/src/brand.ts`, FrockBot's brand, which is what
  `wrangler dev`, every suite and the hosted deploy resolve. A profile names a
  different module with `brand: "<path relative to the profile>"`.

The Durable Object classes, their migrations and the `AdminEntrypoint` are the
package's, so a white-label declares the same classes under the same names. Its
namespaces are its own because its account is.

### 2. A brand is words, pictures and looks; a profile is where and who

`BrandV1` lives in `core/contracts` and holds what a person sees:

- the product name, the built-in model's display name and the name email is
  sent from;
- the icon the web document and email use, as bytes the artifact build embeds;
- the palettes behind the named looks (`ink`, `paper`, `studio`), each a
  `ThemeDocument` the existing decoder and contrast floor validate at build
  time, so a brand cannot ship an unreadable look;
- whether What's New is shown. Its entries are FrockBot's release notes, so a
  white-label turns it off rather than inheriting them.

What belongs to a deployment rather than a product goes in the profile: the
native apps it signs in (`nativeApps`: Android package names and signing
fingerprints, Apple app ids), which replaces the hard-coded identities in
`native-auth.ts`. The hosted profile states FrockBot's own, and the equivalence
gate proves its generated config is unchanged.

Trust chrome stays out of a brand exactly as it stays out of a theme:
`THEME_FORBIDDEN_KEYS_V1` applies, and a brand names no approval, billing or
Stop surface.

### 3. A white-label brings its own auth Package

`AuthPackageV1`, `AuthPackageBuildV1` and the types they name in
`core/contracts/auth-package.ts` are published API. A white-label implements
them in its own repository and names its chooser module in its profile; this
repository ships no Privy code and names no Privy variable.

- **The chooser contract is what the in-repo choosers already export:**
  `AUTH_PACKAGE_V1` and the `AuthPackageEnvironmentV1` type the Worker's `env`
  is checked against. The generator aliases `#auth-package` to the named file
  exactly as it aliases the Access chooser today.
- **The Worker's `env` type is widened by the chooser, not by this
  repository.** A white-label's Package declares the vars and secrets it reads
  through `AuthPackageEnvironmentV1`; the profile lists which of them are
  required so the production-secrets check covers them.
- **Email is present.** The crypto white-label requires an email at sign-in, so
  its Package always returns a verified email and the existing admission
  paths, keyed on email, work unchanged for it. Whether its Package stores
  identities, and so whether it uses the hosted admission modes or decides
  admission itself as Access does, is its choice through the optional members
  `AuthPackageV1` already has.
- **Sign-in routes are the Package's.** `handler` serves `/api/auth/*` and
  `startSignIn` sends a browser that is nobody to sign in, which is all the
  gateway and the native authorize door ask of any Package. A Package that
  needs its own sign-in page serves it from those routes.
- `scripts/check-auth-package-imports.ts` keeps policing this repository's two
  Packages. A white-label's is outside its reach and inside the fixture's (§5).

### 4. The client is a Flutter package and a thin application

`apps/native/lib` and its assets move into a Flutter package,
`apps/native/packages/frockbot_client`, and `apps/native` becomes a thin
application that calls `runFrockbot(frockbotBrand)`. A white-label is another
thin application that depends on `frockbot_client` by git URL, path and release
tag, and passes its own `ClientBrand`:

- product name and icons for user-visible strings and the sign-in page;
- the character catalog — each id with its Rive file, still and ink — and the
  default character. The server stores a character id as an opaque string, so
  a white-label's ids need no server change;
- extra font families, registered by the application that bundles them;
- the release channel, if any. A white-label without Shorebird gets the plain
  build's inert updater, as the simple profile already does.

The application owns its Android, iOS and macOS projects, its package name,
signing, and its `--dart-define` origin (ADR 0028 step 3). The web client is
built from the white-label's application too, so its bundle carries its brand;
`build-flutter-web.ts` and `build-artifact.ts` take the application directory
and brand as arguments instead of assuming `apps/native`.

Moving every asset path is a native change: the first release after it is a
full APK through `release.yml`, not a Shorebird patch.

### 5. Publishing

Every workspace the Worker's graph reaches is published at the release version
by the existing `publish-npm` job, which already rewrites `workspace:*` to that
version for any manifest marked `frockbot.npm: true`. Versions move in
lockstep with the tag. A white-label pins an exact version of every
`@frockbot/*` package and of `frockbot_client`.

The deployment-config generator and its profile schema move from `scripts/` into
`@frockbot/cloudflare`, with a `frockbot-deployment-config` bin, so a
white-label writes `deployments/<name>.json` and generates its wrangler files
the way the hosted and simple profiles do.

A white-label fixture in this repository — a minimal consumer that installs the
packed tarballs, names its own `#brand` and its own stub auth Package, and runs
`wrangler deploy --dry-run` — is the gate that proves the packages are
consumable. It runs with the build category.

### 6. Compatibility

"Nothing is kept for compatibility" still governs this repository's own stored
data. A white-label does not change that until it admits a real user; the
moment it does, the tested forward migrations the constitution promises are due,
as ADR 0028 already said of the simple profile. What does change now: a
breaking change to `BrandV1`, `ClientBrand`, `AuthPackageV1`, the profile
schema or the seam specifiers is called out in the release's notes, because a
consumer reads them at upgrade time.

## Plan

Each step is its own pull request and leaves `main` shippable, with the hosted
deployment unchanged in behaviour.

1. **This ADR.**
2. **Server brand.** `BrandV1`, the `#brand` seam and FrockBot's brand; the
   server's user-visible brand strings and the document icon read from it; the
   profile's `nativeApps` replaces the identities in `native-auth.ts`, with the
   hosted equivalence gate unchanged.

   **Built.** `BrandV1` also carries `homepage` (the outbound user agent names
   it) and `pageLogo`, the inline logo on the pages a browser lands on, since a
   Worker cannot read the icon file at runtime. Every server string a person,
   a Bot or a third party reads takes the product or model name from the
   brand: pages, Settings, billing, admission, MCP and Connect sign-ins, tool
   and prompt text, runtime-note labels, Jev's turn-start rubric and managed
   Skills (whose sources write `{{product}}`, spelled before hashing). The
   artifact build takes `--brand <module>`, since wrangler's alias never
   reaches the bundle it builds. The files provisioned into a Computer come
   from the container image every deployment shares, so they name no product
   at all. Left as identifiers: package and module names, storage keys, the
   `frockbot` tool namespace and `window.frockbot` Plugin page API, the A2UI
   catalog URIs, the stored "unset" profile-name sentinel, and What's New,
   which a brand turns off. The one hosted-visible change is that neutral
   Computer wording, which each Computer applies with one update run. An auth
   Package is now given the product's name as the required
   `AuthPackageDependenciesV1.productName`, a breaking change to that published
   contract.

3. **External auth Packages.** §3: `authPackage` accepts a chooser path, the
   generator aliases it, and the profile names the chooser's required
   secrets. Rides with step 5, whose fixture is what proves it.

   **Built.** `AuthPackageIdV1` is open: `BuiltInAuthPackageIdV1` is the two
   names this repository ships, reserved, and any other string is an external
   Package's. The profile's `authEnvironment` names where each setting the
   chooser's `required` lists comes from — `secrets` the deploy carries and the
   production-secrets check requires, `vars` the config carries — and the
   generator imports the chooser and refuses a profile that names more or
   fewer, or a chooser that calls itself `better-auth` or `access`. The
   manifest in `production-secrets.ts` takes the Package it checks as an
   argument, and `frockbot-deployment-config secrets <profile>` hands it the
   profile's, since the manifest cannot import a chooser it was not built with.
   An external Package gets `AUTH_DB` only when its profile names a
   `d1DatabaseId`. The chooser needs nothing but `@frockbot/core/contracts`: the
   fixture's stub typechecks against the published package with stock
   TypeScript and no shim.

4. **Client package.** §4. Ships as a full APK.
5. **Publishing and the consumer path.** §5: manifests, the release job, the
   generator's move, the build scripts' arguments and the fixture gate. After
   step 2, which it wires.

   **Built.** `scripts/npm-publish.ts` is the one list of published workspaces,
   read by `publish-npm`, `bootstrap-npm-trust.ts` and the fixture, and the one
   manifest rewrite. Each package's `files` publishes its sources without tests;
   `@frockbot/cloudflare` adds the tracked `wrangler.jsonc`, `migrations/`, the
   generator and the two build scripts, and its default brand's icon now lives
   in `src/brand-icon.png`, a copy of the marketing icon held to the same bytes,
   because the package cannot reach `assets/`. The generator and
   `profile.schema.json` are `apps/cloudflare/deployment-config/`, reading the
   app template from the package and the other Workers' from beside it, which
   only a FrockBot checkout has: a white-label deploys the Computer host and the
   build service from a FrockBot checkout of the same release, whose profile may
   pull the published images. A profile's
   `webClient` names the directory its own staged client is uploaded from.
   `build-flutter-web.ts` takes `--app` and `--dist` and `build-artifact.ts`
   takes `--brand` and `--dist`; the client brand itself is step 4's. The
   fixture is `scripts/white-label-fixture/`, run by
   `bun run build:white-label` in the build category and `main.yml`'s
   `Validate` job, and it installs the tarballs with npm, not Bun.

6. **By hand, by Tim.** `bun run bootstrap:npm-trust` for the newly published
   names, which needs an interactive npm session; then the white-label
   repository itself, from the fixture.

## Consequences

- The white-label product's code, secrets and releases live outside this
  repository. This one gains a brand seam, an auth seam a consumer can fill, a
  client package and a larger publish job, and nothing that only the
  white-label runs.
- `AuthPackageV1` becomes a contract another repository compiles against, so
  changing it is a breaking change in the §6 sense, not a local refactor.
- Brand strings and characters become data. A pull request that adds a
  user-visible "FrockBot" to the client or the server is a bug.
- Crypto features — wallets, signing, chain reads — are not part of any of
  this. They arrive as Plugins with the grants they need, and a signing key is a
  secret like any other: server-side, crossing an interface only as a lease.
- Out: runtime brand switching, a brand per Bot, white-label code in this
  repository, a private fork.
