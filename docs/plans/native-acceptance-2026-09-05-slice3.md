# Native acceptance — 2026-09-05, Slice 3 milestones

This ledger continues the [Slice 2 gap list](native-acceptance-2026-09-05.md). Android sign-in transport can be deployed independently of native renderer qualification. Slice 2 exit, supported native distribution, full Applet isolation, eviction and performance budgets are not yet accepted.

## A — production Android sign-in

The deployment switch is account-wide, not per-User: `NATIVE_SLICE_2_AUTH=android`. Better Auth remains the identity source; the User DO owns one-use session admission/revocation. Browser and native admission share `accountIsAdmitted`: a closed signup gate cannot be bypassed by the native session's first User write. Failure to record issuance returns no bearer. Exact PKCE returns, replay refusal and compatibility binding remain mandatory. No new authority, setting, grant, secret, Computer call or kernel behavior is introduced. [Delivery](../architecture/delivery.md#native-sign-in-rollout) records activation and rollback.

Physical Pixel 9a (Android 17, `CP2A.260805.005`) was connected and unlocked. The actual installed APK was inventoried and pulled. Its SHA-256 signer, the candidate's signer and the existing keystore all match `61:E6:47:9F:9C:57:55:15:4C:1F:93:9C:DE:48:E8:A7:57:EF:F3:13:6E:54:ED:1D:DA:5F:61:E7:8B:3C:1E:37`. Release-mode **1.1.0+3** replaced **1.1.0+2** with `adb install -r` after a fresh greater-version check. No uninstall or key replacement occurred. Authenticated continuity awaits A's production release.

The Apple Silicon macOS release compiled with the exact pinned SDK and ran locally with ad-hoc signing. Its real window was 800 × 632. Build/cache outputs remained inside this worktree. Xcode's nested manifest sandbox was disabled for this build inside the existing execution sandbox; no application sandbox entitlement was changed. Launch/window capture required the execution tool's approved access to Launch Services/WindowServer. The sole installed provisioning profile is for `com.nookk.app` on iOS, not FrockBot/macOS; the Apple association is published for later use, but macOS auth remains closed pending a matching signed target. No iOS work or store submission was attempted.

### Design review

The native theme derives from `plugin-ui-theme/src/client/theme.css` and the shell styles: bundled Manrope/Archivo Black with their licenses, sheep artwork already used by the app icon, pink action color, dark semantic surfaces, grouped labels, 10/14/20 px corner vocabulary, tabular small numerals and platform touch sizes. A light palette is defined and widget-tested; the current product defaults to its existing dark theme. Sign-in scrolls under large text and narrow windows, uses safe insets and live status announcements, has explicit retry/browser-handoff copy, finite skeletons and reduced-motion-aware feedback. Qualification form navigation exists only after authentication in `NATIVE_ACCEPTANCE` builds, never on sign-in.

Actual release-window captures: [Pixel sign-in](native-evidence-2026-09-05-slice3/pixel-sign-in.png), [Pixel request failure before A deployment](native-evidence-2026-09-05-slice3/pixel-sign-in-failure.png), [macOS sign-in](native-evidence-2026-09-05-slice3/macos-sign-in.png). These show the production widgets, not a mock or form fixture. Loading/browser handoff/offline/unavailable states pass at 200% text scaling in both palettes; physical screenshots of the authenticated handoff and those transient states remain part of B. No frame-rate, IME, screen-reader or interaction-latency claim follows from screenshots.

### Verification and constitutional review

- Forced dependency installation passed with worktree-local temp/cache directories. Playwright remains exactly 1.62.1; Applets and generated foundation artifacts were not edited.
- Repo-wide typecheck: all 82 packages. Bun: 4,644 passed, one existing skip. Flutter: 209 passed, analyzer clean. Formatting, UI-style, kernel-import, Computer-host-import, protocol freshness, generated-artifact and native pin/digest checks pass.
- Gateway tests cover concurrent replay, null durable issuance, signup refusal before provisioning, exact Android/macOS return gating, public non-redirecting association responses, disabled-route refusal without application loading, browser auth preservation, callback ambiguity, PKCE mismatches/expiry and unsafe Google redirect origins. Existing production User-DO workerd tests cover persistent issuance, revocation and cross-User refusal.
- Production integration suite after the final shared account-policy extraction: 128 tests passed across 51 files. Device and full release-budget gates stay below rather than being inferred from those tests.

| Constitutional rule family                          | Review of this milestone                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product intent, constitutional gate, feature rule   | Beyond-parity renderer/auth work under ADR 0039 and Slice 2/3 plan. Android transport activation is bounded; renderer/catalog/support promotion is not claimed. No amendment.               |
| Authorities, durable effects, migrations            | Existing User session schema and atomic issuance/revocation preserved. Refusal before reply on failed admission; callback replay cannot create a second session. No stored shape changes.   |
| One production path, minimal kernel, explicit seams | Same identity and account admission policy; gateway routes to existing owners. Dart remains a projection/command client. Kernel and provider adapters untouched; import checks pass.        |
| Configuration, settings surfaces, integrations      | No new product control or per-Bot configuration. Rollout is a deployment switch. Auth and its Google credentials remain backend-owned. Existing Vue/Capacitor auth tests pass.              |
| Composition, self-modification, contributions       | No executable extension, Package authority, generation, catalog advertisement, or trust-chrome seam is added. Form fixture remains build-gated. Unqualified fallback gates remain explicit. |
| Computer, Workspace, Memory                         | No Computer invocation or durable-root/Memory behavior change. Applet-with-hibernated-Computer evidence is still required in B.                                                             |
| Architecture checks, documentation, landing         | Mandatory checks and actual release builds recorded; existing plan/acceptance gaps retained. This milestone requests integration only; the orchestrator tags/releases.                      |

### A follow-up — verification hostname

PR #263 merged as `86d8f5fe`; the orchestrator deployed v0.3.32. The canonical association URL returned 200 at 13:05 AEST. On the real Pixel, Google sign-in reached the HTTPS return, but Android still reported domain-verification error 1024. Google's Digital Asset Links response reported a cached 401 from `https://bot.frockbot.com./.well-known/assetlinks.json` and a 600-second cache window. A direct probe reproduced a current **403 for the root-dot hostname versus 200 for the canonical hostname**.

[PR #267](https://github.com/timoconnellaus/frockbot/pull/267), opened by the concurrent production QA session, normalizes the fully qualified hostname at the gateway and supplies HEAD for both association files. The exact return-URI allowlist and PKCE binding remain in force. This is a gateway correction with no durable-state, authority, credential, settings or UI change. The physical verification and authenticated flow must be repeated after its release and verifier cache refresh; HTTP 200 alone does not prove Android verification.

## B — authenticated devices and budget ledger

Canonical association delivery passed; Android verification currently awaits the A hostname follow-up and Google's cache refresh. The Pixel is currently unlocked; do not wait on a future locked device or bypass keyguard. macOS verified return requires a FrockBot provisioning/signing profile. All unchanged Slice 2 budgets remain unaccepted until measured against the specified fixture.

Outstanding: sign-in/selection/paged chat/send/Stop/uncertain delivery/reconnect; durable deterministic save; the published Todo Applet `vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG.e1f813c4b3398e3ee947b323b9996491` with hibernated Computer; physical fallback isolation; client kill plus forced DO eviction; 10,000-Turn performance, 30 editable cold/warm launches, three five-minute runs and 20 Applet/lifecycle cycles; IME, accessibility and remaining native platform gates.

### B preparation before authenticated qualification

The dedicated `Native QA Sep 5` Bot (`native-qa-20260905`) was created through the production directory command with receipt `native-qa-create-20260905-codexnative3`, revision 14. Browser identity matches Tim's User, and the original Bots remain present. Android release **1.1.0+6** upgraded in place through greater version codes 4, 5 and 6 with the original signer. Chat now uses themed message surfaces, finite insertion motion, explicit empty/loading states, pull-to-refresh, keyboard dismissal and send/Stop haptics. Applet directory/fallback regions have explicit loading, empty and retry states. WebView inspection is enabled only in `NATIVE_ACCEPTANCE` builds for the pending physical isolation checks. The runner checks for an unlocked phone before UI/launch loops and refuses an offline or locked device promptly.

Flutter analyzer and 210 widget/contract tests passed, including all six chat states at 200% text with reduced motion. These tests and the Android/macOS release builds establish preparation only; none substitutes for the still-open authenticated, isolation and budget rows. [Actual Pixel browser-handoff state](native-evidence-2026-09-05-slice3/pixel-sign-in-handoff.png) is captured in release mode. The shared Pixel is also being used by a concurrent QA session; further input awaits coordination.

The production QA session's PR #265 identifies a missing `APPLET_VIEWER_SECRET` in the GitHub `production` environment, confirmed by reading secret names. That secret must persist in release configuration for the real Applet flow; its value is never requested from or passed into Dart.
