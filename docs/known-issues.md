# Known issues

Findings from a source audit of the current tree. Each is verified against code
at the cited location. Items the re-orientation already removes are marked; see
[`plan.md`](plan.md).

1. ~~**CI `Validate` fails on `main`.**~~ **Fixed.** `ci.yml` ran `bun run proof:cordis`, a script removed with `apps/cordis-poc`. The step launched a real Electron app that no longer exists; it is deleted.

2. ~~**`README.md` is stale.**~~ **Fixed.** The Electron and Capacitor sections referenced deleted directories; removed.

3. ~~**`release.yml` omits a required secret.**~~ **Not a defect.** Verified against `release.yml`'s "Deploy Worker" env block: all eleven required names, including `APPLET_VIEWER_SECRET`, `DEBUG_TOKEN`, `OPENAI_API_KEY` and `FROCK_AI_GATEWAY_TOKEN`, are present. Production was fixed on 2026-09-05.

4. ~~**Staging omits two required secrets.**~~ **Fixed.** `APPLET_VIEWER_SECRET` and `FROCKBOT_AUTHORIZATION_STATE_SECRET` are both required by `production-secrets.ts` and were absent from the staging deploy, so staging answered 503 for every Applet. Both are now sent. Still open: staging runs no secrets gate.

5. **Staging `vars` differ from production silently.** `apps/cloudflare/wrangler.jsonc:377-384` omits `FROCK_AI_GATEWAY_ID`, `FROCK_AI_AUTO_ROUTE` and `NATIVE_SLICE_2_AUTH`; named environments do not inherit top-level vars.

6. **Two deploy paths rewrite `wrangler.jsonc` by regex** (`main.yml`'s "Configure staging D1 database" and "Configure application artifact", `release.yml`'s production counterparts). The checked-in placeholder `database_id` `00000000-0000-0000-0000-000000000000` and the string `foundation-v1` are load-bearing; reformatting the file breaks deployment.

7. ~~**Signups-closed does not prevent account creation.**~~ **Fixed.** `/api/auth/*` is served at `gateway.ts:753` ahead of the admission check, so any Google account could write `user`, `account` and `session` rows while signups were closed. `signupDatabaseHooksV1` (`apps/cloudflare/src/auth.ts`) now refuses the create unless signups are open or the email is a configured admin.

8. ~~**Admin is unreachable from the native app.**~~ **Fixed.** `gateway.ts` derives `isAdmin` from `session.user.email`, and `native-auth.ts` built a native session as `{user: {id}}` with no email, so a listed admin was ordinary on the phone while the same account was an admin in a browser. The native session now carries the email, looked up through the `profile` seam the same object already exposed — the lookup `canIssueSession` was already doing for the same user.

9. ~~**The Electron desktop shell is not in the repository**, yet `electron()` is an enabled better-auth plugin and `com.frockbot.desktop:/` is a trusted origin.~~ **Fixed.** The better-auth plugin, the trusted origin, the `electronProxyClient`, the `window.frockbotDesktop` branches, the `frockbot://localhost` client origin, `app/auth`'s abstract `DesktopAuthCapability`, the `DesktopApiResponseV1` DTO and the Electron-only `agent-runtime` entry point are gone. Still there: the `"desktop"` client vocabulary the backends and Subagent roles carry, and the `desktop` contributions of `computer/fly` and `app/machine`.

10. ~~**The Capacitor path is dead.**~~ **Fixed.** `FrockBotGoogleAuth`, the `AuthGate` id-token branch, the `@capacitor/core` dependency and the server's `verifyIdToken` are removed. Google sign-in is the OAuth redirect the client uses, in the browser and on the phone.

11. **`apple-app-site-association` is served unconditionally**, but `nativeReturnUris("android")` omits the macOS URI, so a macOS app following it reaches a 404.

12. **`production-secrets.ts:171-173` states that native auth is not enabled in production**, while `wrangler.jsonc:146` sets `NATIVE_SLICE_2_AUTH` to `"android"` in production vars.

13. **Two better-auth instances are constructed per request** (`apps/cloudflare/src/index.ts:2235`, `:2252`).

14. ~~**The Flutter app is not the shipping client.**~~ **Half gone with step 9.** It is the shipping client on the web: `bot.frockbot.com` serves its browser build, which `ci.yml`'s required `Validate` job compiles. What survives is the device half. `apps/native/qualification.json:2` still records `unqualified-prototype`; `native.yml` is advisory with no APK, IPA, sign or publish job; `apps/native/android/app/build.gradle.kts:12-13` hard-errors unless an `installedCode` value derived from a connected device is supplied, so the Android build cannot run unattended; and there is no iOS directory.

15. ~~**The `genui` / `a2ui_core` dependency is inert.**~~ **Fixed.** The A2UI path is gone: both packages, the vendored `0.9.1` schemas, the catalog adapter, `FormPreview`, the three `A2ui*` wire types and the qualification-form route the preview posted to. The `ViewNode` renderer (`apps/native/lib/view/`) replaces it.

16. **The dynamic Package system has no dynamic member.** No Composition member carries an `artifact`. The isolate host, the `BOT_PACKAGES` loader and the capability contract are all still here; nothing produces a Package artifact until the step 8 build service.

17. **Applet members carry a `provenance: PackageProvenanceV1` field** (`core/durable/composition/generation.ts`) whose variants describe Packages, two lines below a comment stating that an Applet is not a Package member.

18. **A first-party Package's installation row still carries a `version`.** Its definition has none — a first-party Package's version is the deploy — so every row carries the single `FOUNDATION_PACKAGE_VERSION_V1` constant and every version comparison in the configuration resolvers is a tautology. The field survives because it is durable User state; removing it belongs with step 7.

19. **`AppletCapabilities.invokeModel()` is a stub.** It always returns `{status: "unavailable"}` with `TODO(model access)` (`apps/cloudflare/src/applet-state.ts:207-226`), while `APPLET_CAPABILITY_NAMES_V1` (`:67`) advertises it.

20. **Applet capabilities are unreachable from authored code.** The SDK's `Applet extends DurableObject<unknown>` and never surfaces `env.CAPABILITIES` or `env.IDENTITY`. The alarm mechanism (`scheduleAlarm`, `AppletFacetStub.onAlarm`) has no SDK API.

21. **Applet `canWrite` is inert.** _Verified._ `applet-sdk/src/server/applet.ts:287-293` reads `x-applet-viewer` and `x-applet-can-write`, defaulting to `canWrite: true`; neither the gateway nor `AppletState` ever sets them. Not an active hole — Applets are account-wide with no cross-User sharing, so every viewer is the owner and `true` is the right answer today. The defect is that an Applet author can write `if (!peer.viewer.canWrite)` and that guard can never fire. Either derive it from the viewer token or drop the concept until sharing exists; shipping a knob nothing populates is the thing to avoid.

22. ~~**`apps/cloudflare/src/native-fallback.ts:1` hardcodes `ARTIFACT_ORIGIN`**, so staging cannot serve the native Applet page.~~ **Gone with step 9.** The bootstrap page, its gateway route, the `/api/native/applets/:id/bootstrap` route and the `FallbackBootstrap` wire type are deleted: the phone frames the Applet's own page on the origin the `/api/applets/:id/ui` read names, which is derived from the request rather than hardcoded.

23. ~~**`@frockbot/applet-sdk` is not published to npm**; the Computer installs dist-tag `latest` and writes `.sdk-unavailable` on failure.~~ **Gone with step 8.** No Computer installs the SDK: the build service's image copies it out of the repository, and the Sprite's `applets` provisioning phase, its `applet` shim and its two doctor checks are deleted.

24. ~~**`computer_screenshot` captures the whole 5120×720 root window.**~~ **Fixed.** The capture was a bare `scrot` with no `-a` clip, so one Bot's screenshot contained its siblings' windows. It now clips to the Bot's slot, read from the same `bots/<key>/slot` file the VNC viewer clips by.

25. **Bots of one User share a browser on the Fly host.** One profile, one process and one CDP port, so a login made by one Bot is available to all of them (`computer/fly/runtime.ts`). It follows from Chromium's per-`user-data-dir` singleton lock and is a fact about that host, not about the Computer: `ComputerHostV1` says nothing about sharing, `capabilities.desktop` is descriptive (slots and geometry) and promises nothing, and a host with a container per Bot would isolate better. Narrowing the interface did not fix this; it stopped it from spreading.

26. **`credentialRef` is decoded and length-limited but never read.** It is `computer:user:<userId>` on the wire; one account-wide `SPRITES_TOKEN` serves every User. The comment at `apps/computer-host/src/index.ts` stating that the container resolves the reference does not describe the code.

27. **No Computer teardown exists.** `ComputerHostV1.teardown?(identity)` names the operation and `computer/fake` implements it — the contract suite holds it to being idempotent — but the Fly host does not, and nothing calls it. `deleteSprite` is still called only from `live-test.ts`. There is no reaper, and no account-deletion or Computer-deletion surface anywhere in the repo to hang one on, so orphaned Computers accumulate for abandoned accounts. **Needs a decision before it can be fixed:** a Computer holds the User's files and browser logins, so any automatic reaper destroys real data on a schedule someone has to choose. The options are an explicit "delete my Computer" action, deletion on account deletion (which does not exist yet), or an idle reaper with a stated retention period.

28. ~~**A superseded computer-host seam remains deployed**: `/v1/effects`, `ComputerEffectJournal`, the `FLY_HOST` binding and `shared-provider.ts` have no production callers.~~ **Gone with step 10.** The route, the journal and its test, `computer/shared-provider.ts`, `computer/core/host-protocol.ts` and the `FLY_HOST`/`COMPUTER_EFFECTS` bindings are deleted, and migration `v5` carries `deleted_classes: ["ComputerEffectJournal"]`. `FlyHostContainer` keeps its legacy name: the v3/v4 rename pair stays in the list because it is what production has applied, and the container application is bound to that class for its lifetime. `ContainerProxy` is still exported — it is a `@cloudflare/containers` class the live tests use, not a FrockBot one.

29. **`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`** misreports the platform to Playwright's detector. Inside `computer/fly` only; no other host is affected.

30. **The GUI-shell refusal is a regex plus a PATH shim**, defeatable with one `export`. It is a policy control, not a security boundary. It is now declared rather than assumed: `capabilities.refuseGuiCommand` is the host's own sentence, `computer_exec` asks before it runs anything and answers in those words, and a host with no such policy simply refuses nothing.

31. ~~**The provider set is closed.**~~ **Fixed.** It was a two-entry map. A third provider (`providers/anthropic`) now ships, built on `@ai-sdk/anthropic`, which demonstrates the registration path takes an arbitrary provider. It has no `user` backend contribution yet, so its Connection cannot be created through the UI.

32. **The default provider is an echo stub.** Any path that fails to apply `modelSelection` answers `"Built-in model: <message>"` rather than raising an error. Still true, and now more visible: with three providers registered, a selection that silently falls through is harder to spot than when there were two.

33. **Frock AI's catalog is one model plus Auto** (`providers/frock-ai/catalog.ts:49-56`).

34. **Tool calls never stream incrementally** (`providers/openai-compatible/index.ts:696-708`), so a long tool-argument generation displays nothing until `finish`.

35. **Manifest schema versions are inconsistent**: `core/models` and `providers/foundation` declare `schemaVersion: 2`; the other providers declare `4`.

36. **The `flock` to `frock` rename is partial.** Code reads `FROCK_AI_*` with `FLOCK_AI_*` fallbacks (`apps/cloudflare/src/index.ts:249-256`), while the Cloudflare resources (`FROCK_AI_GATEWAY_ID: "flock"`, `FROCK_AI_AUTO_ROUTE: "flock-auto"`), the package `@frockbot/app/flock` and every stored id remain `flock`.

37. ~~**`release.yml` publishes test fixtures to npm.** All of `packages/*` is published by flipping `private: false`, including `plugin-testkit`.~~ **Fixed.** The app cut moved the test doubles into `app/testkit`, and step 9 deleted `packages/` altogether with the Vue client the last two libraries in it served. See 43 for what publishes now.

38. **`APPLET_STATES` is typed inconsistently.** It is optional in `UserConfigurationEnv` (`apps/cloudflare/src/user-configuration.ts:210`, guarded at `:1826`) but non-optional and dereferenced unguarded in the gateway (`apps/cloudflare/src/index.ts:1060`, `:2339`).

39. ~~**Voice dictation is not eviction-safe.**~~ **Gone.** Voice is removed.

40. **`app/audit/store.ts:478-503` performs `DROP TABLE` and `ALTER TABLE ... RENAME` shadow-swaps** on the User Durable Object's SQL surface, which it shares with the FTS5 search index.

41. ~~**Dangling directory references.**~~ **Fixed.** `apps/cloudflare/index.html` referenced `apps/mobile` and the computer-host README referenced `apps/fly-host-prototype`; both are removed.

42. ~~**An auto-merged pull request never deploys to staging.**~~ **Fixed.** Auto-merge is gone; the merge queue's merge is a real push to `main`, and `main.yml` deploys staging from it. The related trap — a tag created with `GITHUB_TOKEN` fires no `push` event — is handled by `main.yml` starting `release.yml` through `workflow_dispatch`, the one trigger that token may raise.

43. ~~**The npm publish step fails every release for packages npm does not trust.**~~ **Fixed.** `release.yml` published every directory under `packages/`, so a package whose trusted publisher was not configured on npmjs.com failed the token exchange with an `E404` and reddened a release whose production deploy had already succeeded — the worst shape for a signal, because it trains you to ignore it. Publication is now opt-in through `frockbot.npm` in a package's own manifest, and exactly one package declares it: `@frockbot/applet-sdk`, published for Applet authors rather than for anything this repository installs. It has no `@frockbot` dependencies, so it publishes alone. Nothing else has a consumer off this repository.

44. **`chat.e2e.ts` "a send the server refuses for size keeps the draft and says why" is intermittently flaky.** It failed once in the full browser suite and passed immediately on its own, and passed in the four other full runs on 2026-09-06/07. The suite runs `fullyParallel: false` with one worker, so this is timing under load rather than interference. Not yet diagnosed; recorded so a red shard is not assumed to be a regression.
