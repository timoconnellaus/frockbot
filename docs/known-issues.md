# Known issues

Findings from a source audit of the current tree. Each is verified against code
at the cited location. Items the re-orientation already removes are marked; see
[`plan.md`](plan.md).

1. ~~**CI `Validate` fails on `main`.**~~ **Fixed.** `ci.yml` ran `bun run proof:cordis`, a script removed with `apps/cordis-poc`. The step launched a real Electron app that no longer exists; it is deleted.

2. ~~**`README.md` is stale.**~~ **Fixed.** The Electron and Capacitor sections referenced deleted directories; removed.

3. ~~**`release.yml` omits a required secret.**~~ **Not a defect.** Verified against `release.yml`'s "Deploy Worker" env block: all eleven required names, including `APPLET_VIEWER_SECRET`, `DEBUG_TOKEN`, `OPENAI_API_KEY` and `FROCK_AI_GATEWAY_TOKEN`, are present. Production was fixed on 2026-09-05.

4. ~~**Staging omits two required secrets.**~~ **Fixed.** `APPLET_VIEWER_SECRET` and `FROCKBOT_AUTHORIZATION_STATE_SECRET` are both required by `production-secrets.ts` and were absent from the staging deploy, so staging answered 503 for every Applet. Both are now sent. Still open: staging runs no secrets gate.

5. **Staging `vars` differ from production silently.** Staging is a profile rather than a named environment now, but the difference moved rather than closing: `deployments/staging.json` gives `aiGateway` an account id and no `id` or `autoRoute`, and names no `nativeAuth`, so `identityVarsV1` writes it neither `FROCK_AI_GATEWAY_ID`, `FROCK_AI_AUTO_ROUTE` nor `NATIVE_SLICE_2_AUTH`. Nothing reports the omission.

6. ~~**Two deploy paths rewrite `wrangler.jsonc` by regex.**~~ **Mostly fixed.** Deployment identity left the tracked files ([ADR 0028](adr/0028-open-deployment.md) stage 3): the D1 identifier is in `deployments/<profile>.json`, or resolved at deploy time and passed as `bun run deployment:config staging --d1-database-id <uuid>`, and no tracked file is rewritten at all. One rewrite is left, in both workflows' "Configure application artifact" step, and it edits the generated config under `.deployment/`: the placeholder `foundation-v1` becomes the artifact's own sha256, and the step fails loudly if the placeholder is absent.

7. ~~**Closed admission does not prevent account creation.**~~ **Fixed.** Identity creation now consults the [beta-access authority](beta-access.md#where-it-is-asked), through `identityCreationHooksV1` (`app/auth/better-auth/index.ts`).

8. ~~**Admin is unreachable from the native app.**~~ **Fixed.** `gateway.ts` derives `isAdmin` from `session.user.email`, and `native-auth.ts` built a native session as `{user: {id}}` with no email, so a listed admin was ordinary on the phone while the same account was an admin in a browser. The native session now carries the email, looked up through the `profile` seam the same object already exposed — the lookup native admission was already doing for the same user.

9. ~~**The Electron desktop shell is not in the repository**, yet `electron()` is an enabled better-auth plugin and `com.frockbot.desktop:/` is a trusted origin.~~ **Fixed.** The better-auth plugin, the trusted origin, the `electronProxyClient`, the `window.frockbotDesktop` branches, the `frockbot://localhost` client origin, `app/auth`'s abstract `DesktopAuthCapability`, the `DesktopApiResponseV1` DTO and the Electron-only `agent-runtime` entry point are gone. Still there: the `"desktop"` client vocabulary the backends and Subagent roles carry, and the `desktop` contributions of `computer/fly` and `app/machine`.

10. ~~**The Capacitor path is dead.**~~ **Fixed.** `FrockBotGoogleAuth`, the `AuthGate` id-token branch, the `@capacitor/core` dependency and the server's `verifyIdToken` are removed. Google sign-in is the OAuth redirect the client uses, in the browser and on the phone.

11. **`apple-app-site-association` is served unconditionally**, but `nativeReturnUris("android")` omits the macOS URI, so a macOS app following it reaches a 404.

12. ~~**`production-secrets.ts` states that native auth is not enabled in production**, while the tracked `wrangler.jsonc` sets `NATIVE_SLICE_2_AUTH` to `"android"` in production vars.~~ **Fixed.** `NATIVE_SLICE_2_AUTH` is an identity var the generator writes from a profile's `nativeAuth`, `deployments/hosted.json` names `android,macos`, and `NON_SECRET_WORKER_SETTINGS_V1` in `production-secrets.ts` says the same.

13. **Two better-auth instances are constructed per request** (`apps/cloudflare/src/index.ts:2235`, `:2252`).

14. ~~**The Flutter app is not the shipping client.**~~ **Half gone with step 9.** It is the shipping client on the web: `bot.frockbot.com` serves its browser build, which `ci.yml`'s required `Validate` job compiles. What survives is the device half. `apps/native/qualification.json:2` still records `unqualified-prototype`; `native.yml` is advisory with no APK, IPA, sign or publish job; `apps/native/android/app/build.gradle.kts:12-13` hard-errors unless an `installedCode` value derived from a connected device is supplied, so the Android build cannot run unattended; and there is no iOS directory.

15. ~~**The `genui` / `a2ui_core` dependency is inert.**~~ **Fixed.** The A2UI path is gone: both packages, the vendored `0.9.1` schemas, the catalog adapter, `FormPreview`, the three `A2ui*` wire types and the qualification-form route the preview posted to. The `ViewNode` renderer (`apps/native/lib/view/`) replaces it. A2UI is back as of ADR 0030, this time with a caller: `genui` draws Cards in the transcript (`apps/native/lib/cards/`), and `ViewNode` keeps the settings pages.

16. ~~**The dynamic Package system has no dynamic member.**~~ **Fixed.** Bot authoring landed with [ADR 0026](adr/0026-plugins.md) step 7: a Bot publishes a Plugin, the User approves the card, and the generation the User Durable Object records carries a member with an `artifact` ([architecture.md, "Built-in versus dynamic"](architecture.md#built-in-versus-dynamic)). The deployment catalog is no longer empty either: step 6 seeds the `email` Plugin ([architecture.md, §5 Composition](architecture.md#5-composition)).

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

31. **Provider connections:** the 28 providers in the pinned Harness catalog (all with API keys, three also with OAuth sign-in) have a shared connection lifecycle, encrypted credentials, model catalogs, and runtime adapters — except DeepSeek, which this deployment serves only through an account-installed Plugin and so has no compiled adapter ([ADR 0032](adr/0032-plugin-model-providers.md)). See [model providers](model-providers.md) for setup and provider-specific limitations.

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

42. ~~**An auto-merged pull request never deploys to staging.**~~ **Fixed.** Auto-merge is gone; a maintainer's merge is a real push to `main`, and `main.yml` deploys staging from it. The related trap — a tag created with `GITHUB_TOKEN` fires no `push` event — is handled by `main.yml` starting `release.yml` through `workflow_dispatch`, the one trigger that token may raise.

43. ~~**The npm publish step fails every release for packages npm does not trust.**~~ **Fixed.** `release.yml` published every directory under `packages/`, so a package whose trusted publisher was not configured on npmjs.com failed the token exchange with an `E404` and reddened a release whose production deploy had already succeeded — the worst shape for a signal, because it trains you to ignore it. Publication is now opt-in through `frockbot.npm` in a package's own manifest, and exactly one package declares it: `@frockbot/applet-sdk`, published for Applet authors rather than for anything this repository installs. It has no `@frockbot` dependencies, so it publishes alone. Nothing else has a consumer off this repository.

44. **`chat.e2e.ts` "a send the server refuses for size keeps the draft and says why" is intermittently flaky.** It failed once in the full browser suite and passed immediately on its own, and passed in the four other full runs on 2026-09-06/07. The suite runs `fullyParallel: false` with one worker, so this is timing under load rather than interference. Not yet diagnosed; recorded so a red shard is not assumed to be a regression.

45. **Voice is still almost entirely unexercised against real microphones and clients.** `docs/voice.md` and `docs/voice-live-checklist.md` say exactly what was verified: the Worker paths, the ledger, the sleep/wake ordering and the gateway are covered with fakes, and since ADR 0031 the workerd suite drives a whole call against a stand-in Live upstream. Two things have run against a real provider. The dictation relay went end to end against OpenAI on 2026-09-11 with synthesized speech rather than a microphone (`docs/voice.md`, "The live endpoint", now historical). The Gemini Live API was probed frame by frame on 2026-09-17 (`docs/voice-gemini-probe.md`), which proves the wire and nothing about a microphone, a speaker or a person. What remains unobserved is a real call of any kind: every microphone, every client, the delivery presets — whose effect on a Live model Google does not document — and the model that tidies a dictated transcript. Both keys are required production secrets; a release stops until they exist.

46. ~~**The Flutter voice player pulls the macOS project onto CocoaPods and the Android build onto a compileSdk hook.**~~ **Fixed.** `flutter_pcm_sound` 3.3.3 is gone: playback is the app's own `com.frockbot/pcm` channel (Android `AudioTrack`, macOS `AVAudioPlayerNode`), which is also what makes the speaker's playing report mean samples are actually sounding rather than merely handed over. No third-party pod remains — `apps/native/macos/Podfile.lock` holds only `FlutterMacOS` and the embed-frameworks phase is out of the Xcode project — but the CocoaPods scaffolding itself (the `Podfile` and the Check Pods Manifest phase) is still carried for the next plugin that needs it. `android/build.gradle.kts` still lifts every Android subproject's `compileSdk` to the app's, now as a general guard rather than for a specific plugin.
