# ADR 0039: The desktop app can be its own server

Status: accepted, 2026-09-29. Decisions are Tim's from the 2026-09-29
discussion.

- The macOS desktop app offers two ways to run on first launch: **FrockBot
  Cloud**, the hosted deployment, or **Run on this Mac**, where the app starts
  and owns a local server.
- Local is a third deployment profile, `local`, beside `hosted` and `simple`
  ([ADR 0028](0028-open-deployment.md)). It runs the same app Worker on the
  open-source workerd runtime, and its differences are build-time Packages,
  not branches in the app.
- Local mode needs two things from the person before a Bot can reply: a model
  Connection and a Jev API key. There is no platform to pay for either.
- No switching between modes yet. The choice holds for that install, and the
  chooser says so.
- No extra sandbox around workerd for now. Plugins run in its isolates as
  they do in the cloud.

## Context

The hosted product needs an account, Frock AI and a Fly Sprite. Someone who
wants to try FrockBot privately, or pay nothing, has to install the simple
deployment into their own Cloudflare account, which is a developer's path.

Most of the seams a local build needs already exist. The Computer host,
sign-in and storage are chosen at build time. The fully local `e2e` wrangler
environment already runs the app Worker with no Cloudflare account. The
desktop app already starts and supervises one background process, the Deno
device host (`apps/native/macos/Runner/DeviceHostBridge.swift`).

What does not exist: a runtime choice of server in the client (its origin is
a `--dart-define` today), a sign-in that needs no identity provider, a
Computer that runs on the Mac, and local replacements for the Cloudflare-only
bindings.

## Decision

### The first-run chooser

The desktop's sign-in page becomes a choice between two cards. Cloud is the
recommended one, and its card lists what the person gets for signing up:

- Bots keep working when the Mac is asleep or off: Routines and webhooks
  always fire.
- The same Bots on their phone.
- Frock AI included, so there is no API key to find.
- A managed Computer for every Bot.
- Voice, dictation and memory extraction work out of the box.

The Local card says what it is and its honest limit:

- Everything stays on this Mac. No account.
- Free. Bring a model key (Anthropic, OpenAI, Ollama or any catalog provider)
  and a Jev key.
- Bots only run while FrockBot is open.

Cloud continues into the existing Google sign-in. Local continues into a
setup step that asks for the model Connection and the Jev key, starts the
server, and opens the app.

Android and web clients keep connecting to the hosted deployment only.

### The client picks its server at runtime

`hostedOrigin` (`packages/frockbot_client/lib/client/transport.dart`) stops
being compile-time only on macOS. The chosen mode is stored with the app's
settings: Cloud uses the origin the build names, Local uses
`http://127.0.0.1:<port>` of the server the app started. The sign-in check
that the authorize URL matches `hostedOrigin` applies only to Cloud.

### The `local` profile

`bun run deployment:config local` writes a workerd config for the app Worker
with every binding local: Durable Objects, D1 and R2 persisted under
`~/Library/Application Support/FrockBot`. Its Packages:

- **Sign-in:** `app/auth/local`. One owner, no identity provider. The desktop
  app generates a token when it starts workerd and passes it in; the server
  admits only that token and listens only on localhost.
- **Model:** no Frock AI and no ambient Connection. The Connection added at
  setup becomes the User's model through the existing
  `providers/model-connections` path.
- **Jev:** the person's own key, stored server-side like any other secret.
  Without it the server refuses Turns and says why, rather than running
  unsupervised.
- **Memory index:** a SQLite table searched by brute force in place of
  Vectorize, which is enough for one person's memories.
- **Memory extraction, dictation, voice:** extraction uses the person's model
  Connection. Dictation and voice are off until they can use a key the person
  supplies.
- **Computer:** `computer/local`, a `ComputerHostV1` over Apple's
  Virtualization framework, in a later stage. Until then a Local Bot has no
  Computer and says so.
- **Plugin builds:** later stage. The build service needs Docker today.

### The app runs the server

The macOS app bundles the workerd binary and the built `local` Worker. It
starts workerd on launch and stops it on quit, the way it already runs the
Deno device host. The device host connects to the local origin in Local mode.

A Routine due while the app was closed runs once when the app next starts,
not once per missed firing.

## Order

1. **Local without a Computer.** The chooser, the runtime origin, the `local`
   profile and its sign-in, the app starting workerd, the model and Jev keys.
   A Local Bot can chat, remember and run Routines while the app is open.
2. **Local Computer.** `computer/local` on the Virtualization framework.
3. **Local Plugin builds.** Replace the Docker build service for this profile.

## Consequences

- AGENTS.md's invariants say "the server" where they said "the cloud", and
  zero configuration is a promise of the hosted product, not of Local.
- A Local install ships its client and server together, so it has no protocol
  compatibility gap to manage.
- Moving Bots between Local and Cloud is a later decision. Nothing here should
  make it harder: a Local install's state is the same stored shapes.
