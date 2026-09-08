# Local Pixel development app

`FrockBot (Dev)` is the native renderer installed as `com.frockbot.mobile.dev`.
It has separate Android storage and does not replace `com.frockbot.mobile`.
The single compile-time `FROCKBOT_LOCAL_DEV=true` switch selects that identity,
label, local transport and automatic `development` identity. Normal builds retain
production authentication, HTTPS and the production app identity.

From a checkout with locked dependencies installed:

```sh
bun run dev:phone
```

This starts the existing dogfood Worker stack, forwards the Pixel's loopback
port 8787 to the Mac over wireless ADB, builds a release APK, verifies its
application ID, and installs it without uninstalling either app. The existing
Android keystore is required. The default device is Tim's paired Pixel 9a;
`FROCKBOT_PHONE_SERIAL` overrides the ADB serial. `ANDROID_HOME` and
`NATIVE_FLUTTER_ROOT` override the local tool locations. Use the pinned SDK
in `apps/native/README.md`.

On an empty development account the script creates a Dev Bot through the
normal durable Bot creation command, so chat is immediately available.

Open the dev app and it loads the development User directly, without Google.
The Worker must have `ALLOW_DEVELOPMENT_AUTH=true` (the stack supplies it).
The app sends the existing development identity header for HTTP and WebSocket
requests, with the same client compatibility metadata as production. No
synthetic native session or client-owned authority is created. Sign out is
absent because this build always uses the development account.

After another PR merges, in your clean main checkout:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run dev:phone
```

This rebuilds both the backend artifact and native APK. Backend-only restarts
can use `bun run dogfood:dev`. To restore forwarding after wireless ADB
reconnects, without rebuilding: `scripts/phone-dev.sh connect`. To rebuild and
install while the stack is already running: `scripts/phone-dev.sh install`.
Stop the server with `bun run dogfood:stop`.

Keep the Mac awake and the phone connected to wireless debugging. No public
listener, tunnel, deployment or Google configuration is needed. The app cannot
reach the local Mac when ADB is disconnected; Refresh retries after reconnect.
Local Durable Object state belongs to this checkout's `.wrangler` storage;
keep using the same checkout for persistent dev conversations. Never copy
that storage between worktrees. Real model calls still use remote Cloudflare
AI and can incur normal model usage. Computer and external integration limits
are those of [the dogfood stack](dev-stack.md).

## Constitutional review

This is beyond-parity development tooling, not a second product runtime.
The existing User and Bot Durable Objects own all state, admission, events,
retry, cancellation and recovery. Disconnect only detaches the observer;
Computer hibernation and effect reconciliation are unchanged. No kernel,
Composition, Memory, Package grant, secret, configuration surface or schema
changes are introduced. The fixed identity exists only in an explicit local
build and is accepted only by the existing development-enabled backend seam.
Normal builds retain production auth and Android upgrade/signing gates.
The APK identity check protects the installed production app before mutation.
Native transport tests cover both build modes and actual local HTTP/WebSocket
requests; device acceptance must additionally prove startup, chat and separate
installation before opening the PR.

## Device acceptance — 2026-09-08

On Tim's Pixel 9a through its paired wireless ADB transport:

- Release APK inspected before installation: `com.frockbot.mobile.dev`, label
  `FrockBot (Dev)`, versionCode 1. Wireless installation succeeded.
- First launch opened the Bot directory without a Google or native-session
  exchange. `/api/identity` returned `development` from the local Worker.
- Selected Dev Bot and sent `Please reply with: Local phone test passed.`
  from the native composer. The phone displayed `Local phone test passed.`
  from the real model through the local Worker.
- Production `com.frockbot.mobile` remained versionCode 27 with
  `lastUpdateTime=2026-09-08 09:04:47`, unchanged before and after installation.
- Native analyzer clean; all 274 existing native tests passed; two new
  transport checks passed under both normal and local defines (the local
  mode performs real HTTP and WebSocket requests); six dogfood stack tests
  passed; all 82 TypeScript packages typechecked. Repeated bootstrap preserved
  the existing Bot directory.

This proves the local phone workflow, not native release qualification or
Computer availability. The test stack had no `COMPUTER_HOST_TOKEN`.
