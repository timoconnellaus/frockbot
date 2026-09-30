# Enthusiast setup plan

**Status:** proposed and discussed, not built. The decisions below were settled on 30 September 2026; the open questions at the end are what is left.

**Why:** FrockBot's differentiator is being the most useful Bot for people who like to tinker, and a product organisations can run themselves. The zero-configuration default stays exactly as it is. What this plan adds is the ability to replace any part of FrockBot with your own, and pay only for what you use of ours.

---

## 1. The model

**A FrockBot account is an identity and a credit wallet.** Every service a Bot uses is either **FrockBot's**, paid from credit, or **yours**: your key, your account or your machine. The person chooses per service.

| Service                                  | FrockBot's                                                                      | Yours                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **App** (conversation, memory, Routines) | frockbot.com                                                                    | Self-hosted in your Cloudflare account ([§6](#6-self-hosting))                                                                                 |
| **Computer**                             | FrockBot's Computer                                                             | Your Sprites, Your server, Your Mac ([§3](#3-where-your-computer-runs))                                                                        |
| **Models**                               | Frock AI                                                                        | Any connected provider, Cloudflare, or a local model ([§4](#4-models-and-services))                                                            |
| **Jev**                                  | FrockBot's Jev                                                                  | Cloudflare Workers AI (`typesafe/jev`), TypeSafe's API, OpenRouter (Jev or Jev Router), or a custom model behind TypeSafe's System One adapter |
| **Voice calls**                          | Gemini Live on our key                                                          | Google (Gemini Live) on your key; ChatGPT Realtime later                                                                                       |
| **Dictation**                            | Our transcription                                                               | On your device (Parakeet or whisper.cpp in the Mac app, Apple's speech on iPhone), Cloudflare Whisper, OpenAI, Groq, Deepgram or ElevenLabs    |
| **Web search**                           | Brave on our key                                                                | Your search key                                                                                                                                |
| **Images**                               | Our image model                                                                 | Cloudflare (Flux), OpenAI, Google, OpenRouter, or local (Draw Things, ComfyUI)                                                                 |
| **Connected apps**                       | Our Composio, which needs at least the BYO plan, also for a self-hosted install | Your Composio key                                                                                                                              |

Rules that hold across every service:

- **Never a silent fallback.** When your own provider, key or machine fails or runs out, the Bot says so and stops that piece of work. It never switches to FrockBot's service and spends credit the person did not choose to spend.
- **Secrets stay server-side,** as today. Your keys are stored encrypted and attached to the one call that needs them.
- **Self-hosted installs can still use FrockBot's services** by linking a FrockBot account ([§6](#6-self-hosting)), paying from credit alone.

---

## 2. Plans and billing

| Plan         | Price         | Includes                                                                                                                | Trial                  |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **BYO**      | US$5 a month  | Hosting, FrockBot's Jev (fair use up to US$2 of Jev a month), and connected apps through our Composio. No usage credit. | None                   |
| **Standard** | US$20 a month | As today: US$20 of usage credit a month                                                                                 | 7 days, US$3 of credit |
| **Plus**     | US$50 a month | As today: US$60 of usage credit a month                                                                                 | 7 days, US$3 of credit |

- **Anything else of ours is pay as you go.** A BYO account that uses FrockBot's Computer, Frock AI, voice or search pays from top-ups, at the same rates as today.
- **Standard and Plus people can bring their own too.** Their included credit then simply goes further.
- **The setup suggests a plan; the person picks.** The marketing chooser and the app recommend a plan from the setup (all yours → BYO; any of our Computer or models → Standard). Changing setup later suggests a change of plan but never makes one.
- **Jev fair use on BYO.** Past US$2 of Jev in a month, Jev use draws from credit like any other service. With no credit, Turns that need Jev are refused with a message saying why, which follows from Jev having no permissive failure mode.
- **Connected apps through FrockBot need at least the BYO plan,** on frockbot.com and on a linked self-hosted install alike.
- **Otherwise a linked self-hosted install needs credit, not a plan.** Top-ups must become spendable without a subscription for these accounts. Today purchased credit needs a paid subscription (`docs/billing.md`).
- **Payments stay in `PaymentsPackageV1`.** The BYO plan is one more entry in `STRIPE_PLAN_V1`'s `subscriptions`, with no trial and no included credit. Included Jev and Composio are overhead the plan covers, as memory embeddings are today.

---

## 3. Where your Computer runs

### Today

- `ComputerHostV1` (`computer/core/host.ts`) is the interface everything above the Computer speaks. `FlyComputerHostV1` (`computer/fly/provider.ts`) is the one production implementation, and `computer/fake` is an in-memory one that proves the interface by passing the same contract suite (`computer/host-contract.test.ts`).
- The host is chosen **once per deployment**, in `apps/cloudflare/src/computer-host.ts`. `app/runtime.ts` hardcodes `defaultProviderId: "computer-host"`.
- The Fly host reaches Sprites through the `apps/computer-host` Worker and container, which is the only thing that holds `SPRITES_TOKEN`. One Sprite per User.
- `ComputerRegistry.assign(identity, providerId, configuration?)` already takes a per-User `configuration`, which nothing passes today.
- `ComputerHostCapabilitiesV1` is also deployment-wide. The app's CSP `frame-src` is built from its `viewerFrameOrigins` (`https://*.sprites.app`).
- Separately, `app/machine` pairs a User's own machines and runs `machine_*` tools on them. Each effectful call needs the User's approval. That is "reach into my own computer", not "the Bot's Computer", and stays as it is.

### The four choices

| Choice                            | What it is                                                                              | Always on?                                    | Who pays for the machine |
| --------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| **FrockBot's Computer** (default) | Today's hosted Computer: Sprites now, Incus later ([plan](incus-computer-host-plan.md)) | Yes                                           | FrockBot balance         |
| **Your Sprites**                  | The same Fly host, but calling Sprites with the User's own Fly API token                | As Sprites is                                 | The User's Fly account   |
| **Your server**                   | Any Linux VPS or home server the User controls                                          | While the server is up                        | The User                 |
| **Your Mac**                      | A Linux VM the desktop app runs on the User's own Mac                                   | While the Mac is awake and the app is running | Nobody                   |

All four present the same Computer to the Bot: a shell, files, a browser, and (where the host has one) a desktop the User can watch and take over. The Bot does not know which one it has, apart from what the capabilities say.

### Shape

Two host implementations cover all four choices, not four.

**A. Fly, with the account's own token.** `FlyComputerHostV1` gains a per-assignment credential. The User's Fly token is an account secret, stored encrypted like a model API key. On `open`, the app passes the computer-host Worker a short-lived lease that resolves to the token server-side. The container builds a `SpritesClient` per assignment rather than once at boot. Nothing else about the Fly host changes.

**B. A tethered host, `computer/tether`.** A small agent program, `frockbot-computer`, is installed on the User's machine. It dials **out** to FrockBot over a WebSocket, so it works behind NAT and needs no open ports, DNS or TLS certificate. It serves the same primitives the on-Sprite runtime does today: exec, files, processes, browser, screenshot and, when installed with a desktop, the viewer and control. The cloud side is a `ComputerHostV1` whose session calls travel over that socket.

- **Your server:** a one-line installer (`curl … | sh`) installs the agent and its packages (Chromium, and optionally Xvfb, a window manager and a VNC server for the desktop), then prints a pairing code. It runs as its own unprivileged user under systemd.
- **Your Mac:** the Mac app creates a Linux VM with Apple's Virtualization framework, from an image FrockBot publishes, and runs the same agent inside it. Pairing is automatic because the app is already signed in. The Bot's commands run inside the VM, never on the Mac itself, so untrusted code still gets its own boundary.

The same socket carries local model calls ([§4](#local-models)): the agent on Your server, and the Mac app itself, can pass a model request to a local OpenAI-compatible endpoint.

Pairing reuses `app/machine`'s pairing and socket transport, not its tool semantics. A tethered Computer is the Bot's machine; there is no approval per command, exactly as on FrockBot's own Computer.

The on-Sprite runtime (`computer/fly/runtime.ts`, about 2,500 lines of layout and scripts) is mostly plain Linux. It moves to a shared `computer/linux-runtime` that both the Fly host and the tether agent run, so both stay one implementation of "what a Computer is".

### What changes above the host

- **The choice becomes account-shaped.** The User object stores `computerHost: { kind: "frockbot" } | { kind: "sprites", credentialId } | { kind: "tether", machineId }`. The runtime reads it and calls `assign` with that provider and configuration, instead of the hardcoded default. Every Bot the User owns gets the same Computer, as today.
- **Capabilities move from the deployment to the session.** `viewerFrameOrigins`, `desktop` and a new `availability: "always" | "while-connected"` come from the assigned host. A tethered viewer is relayed through the app origin, so it adds no frame origin. The deployment-wide CSP keeps the Sprites origin only while any account can choose Sprites.
- **Offline is a normal state.** When a tethered Computer is not connected, a Computer tool call fails fast with "Your computer is offline". The model sees that as the tool result; nothing waits. A Routine whose work needs the Computer reports the same thing in its run. The Computer settings page shows the connection state and when the machine was last seen.
- **Switching host is a replace, not a migration.** Switching tears down the old assignment (with the existing "Delete my Computer" path where the old host supports it) and provisions the new one fresh. The settings page says clearly what is lost. Carrying files between hosts is a possible later step, not this plan.
- **Connected accounts still never touch the machine.** The egress proxy that attaches connected-account credentials stays in the cloud. The tether agent routes proxied commands back through the socket, so a User's own VPS never holds a connected-app secret either.
- **Billing.** Computer time on a User's own machine or own Sprites does not draw from FrockBot credit. See [Plans and billing](#2-plans-and-billing).

### Settings UI

The Computer page (`computer/settings.dart`) gains a **Where it runs** section at the top: the four choices as cards, each with its current state. Choosing one opens its setup:

- **FrockBot's Computer:** nothing to set up.
- **Your Sprites:** paste a Fly token, test it, done.
- **Your server:** shows the install command and waits for the pairing, then shows the machine's name, OS and whether it has a desktop.
- **Your Mac:** desktop app only. It shows the disk and memory the VM will use, downloads the image, and starts it.

### Cuts

Each cut leaves `main` shippable.

1. **Per-account host choice.** The `computerHost` record on the User, `assign` driven by it, capabilities per session, and the Where it runs section with only FrockBot's Computer enabled. No behaviour changes.
2. **Your Sprites.** The per-assignment credential in the Fly host and computer-host container, the Fly-token secret, and its setup card.
3. **Shared Linux runtime.** `computer/fly/runtime.ts` moves to `computer/linux-runtime`, with no behaviour change, proven by the existing Fly tests.
4. **Tether host and agent, headless.** `computer/tether`, the `frockbot-computer` agent and the installer, running exec, files, processes, browser and screenshot. It must pass `computer/host-contract.test.ts`. Offline handling ships here.
5. **Tether desktop.** The viewer relay and control on a tethered host installed with a desktop.
6. **Your Mac.** The Mac app's VM on the Virtualization framework, running the cut 4–5 agent.

---

---

## 4. Models and services

### Today

- **Connections** are per account (`providers/model-connections/user.ts`): 28 catalog providers with an API key, OAuth sign-in for some, Ollama Cloud, Frock AI built in, and DeepSeek served by a Plugin.
- **The conversational model** is the only choice a User makes: Bot override → account default (`user.accountModel`) → platform model, in `resolveEffectiveBotModelV1` (`core/configuration/index.ts`).
- **Everything else is fixed.** Compaction uses Frock AI's `@frock/structured`. The writing, coding, thinking and vision specialists are Frock AI gateway routes. Jev is TypeSafe's hosted API on a deployment key (`app/supervision/jev.ts`). Voice uses Gemini Live, dictation OpenAI's transcription, image Workers AI Flux, search Brave.
- **Setting up a model** is split across three screens: Marketplace, Provider accounts and Models.

### Providers first, then jobs

A person chooses **which providers they use**, and FrockBot chooses the model for each job from those providers. They can **pin a model for any job** when they care.

The choosing is Jev's. Jev already classifies a Turn's work; it picks the job (chat, writing, coding, thinking, vision, summary) and the model for it from the person's enabled providers. On an install whose Jev is its own Cloudflare account's, that choosing runs on the person's own Jev too.

| Job         | Used for                         | Must support                |
| ----------- | -------------------------------- | --------------------------- |
| Chat        | The Bot's own conversation       | Tools, streaming            |
| Writing     | Drafts, emails, long text        | Streaming                   |
| Coding      | Scripts and code on the Computer | Tools                       |
| Thinking    | Hard problems                    | Tools                       |
| Vision      | Reading images                   | Image input                 |
| Summaries   | Compaction and memory extraction | Structured output           |
| Voice calls | Live spoken conversation         | A real-time speech protocol |
| Dictation   | Speech to text in the composer   | Transcription               |

Image generation and web search are services rather than jobs: one provider each, chosen on the same screen.

- **One record.** `user.modelProviders` (the enabled providers, in preference order) and `user.jobPins: Partial<Record<JobId, ModelBindingV1>>` replace `user.accountModel`, which is deleted with a scoped cleanup of test data. A Bot may still pin its own Chat model, the one per-Bot exception that exists today.
- **One resolver.** `resolveJobModelV1(job, bot)`: Bot pin (Chat only) → account pin → Jev's pick among enabled providers that meet the job's needs. A pin whose connection is gone or whose model lacks the job's capabilities is reported to the person, never replaced by a Frock AI model unless Frock AI is one of their enabled providers.
- **Capability checks use the catalog's existing flags** (`vision`, `structuredOutput`, tools). The picker says why a model cannot do a job rather than hiding it.

### Cloudflare as a provider

Jev is available on Workers AI as `typesafe/jev`, through an account's AI binding, with no API key, billed to that Cloudflare account.

- **FrockBot's own deployment moves Jev to Workers AI.** `hostedJevClientV1` gains a Workers AI transport beside TypeSafe's API; the deployment's AI binding replaces `JEV_API_KEY`. A self-hosted install gets Jev from its own account with nothing to configure.
- **A person on frockbot.com can Connect Cloudflare,** following Cloudflare OS's AI Gateway billing flow: sign in with Cloudflare over OAuth, choose the account, and FrockBot routes that person's Jev, Workers AI models and AI Gateway providers through their account's default AI Gateway. Usage bills their Cloudflare credits; FrockBot never holds that money. This is how "bring your own Jev" works on frockbot.com.

### Local models

A local model runs on the person's own hardware and is reached through something of theirs that already holds a socket to FrockBot:

- **The Mac app** passes a model request to a local OpenAI-compatible endpoint on the Mac: Ollama, LM Studio or [mesh-llm](https://github.com/Mesh-LLM/mesh-llm)'s `localhost:9337`.
- **Your server's agent** ([§3](#3-where-your-computer-runs)) does the same on the server.

It is still a model call carrying a `requestId` idempotency key, and it costs nothing. While the Mac or server is offline, a job pinned to it is reported as unavailable. mesh-llm is what lets a person pool several of their own machines into one endpoint, the technique [Buzz](https://github.com/block/buzz) uses for community compute; FrockBot needs nothing extra for it beyond speaking to the endpoint.

### Voice and dictation

- **Voice calls** become a job with its own provider: Gemini Live today, OpenAI Realtime beside it, each on FrockBot's key or the person's.
- **Dictation** gains an on-device option in the Mac app, following [OpenWhispr](https://github.com/OpenWhispr/openwhispr): a bundled whisper.cpp or Parakeet model, downloaded on first use, so speech never leaves the Mac. Cloud dictation stays for the phone and the web.

### Each service is its own choice

Chat, Jev, voice calls, dictation and images are separate sections, each with its own providers, because their providers differ: Jev has four ways to reach it, voice needs a realtime speech protocol, and dictation has a long tail of transcription services. A person's accounts are shared across sections: connecting Google once serves chat and voice.

On a self-hosted install, Jev, dictation and images default to the account's own Workers AI (Jev, Whisper, Flux), and chat adds Cloudflare Workers AI, so a fresh install needs nothing configured.

### Settings UI: AI setup

One screen replaces the Models page.

- **At the top, three presets:** _FrockBot handles it_ (every job on Frock AI; the default), _Use my own providers_, and _Everything local_ (once local models exist).
- **Your providers:** the connected providers as a reorderable list, each with its state. Adding one runs the existing key or sign-in form inline; Cloudflare is one of them.
- **Jobs:** one row per job, showing what serves it now ("Writing — chosen by Jev from your providers", or a pinned model). Tapping a row pins or unpins a model, filtered to models that can do the job.
- **Services:** Jev, web search, image generation, voice, dictation and connected apps, each FrockBot's or yours.

It stays a projection in the settings-document family: `modelsSettingsFrame` grows the provider list, the job rows and the service rows, and `/api/settings/models/options` takes a `job` to filter by.

### Cuts

1. **Providers and jobs, Chat only.** `modelProviders` and `jobPins` replace `accountModel` with its cleanup; `resolveJobModelV1` replaces the Chat resolver. No visible change.
2. **Jev on Workers AI** for FrockBot's own deployment.
3. **The remaining jobs,** their capability checks and their callers: summaries, the specialists, then voice and dictation.
4. **AI setup screen,** with presets, providers, jobs and services.
5. **Connect Cloudflare.**
6. **Your own search, image and Composio keys.**
7. **Local models** through the Mac app, then Your server.
8. **On-device dictation** in the Mac app.

`docs/architecture.md` §7 still describes the account model as a User-scoped Package setting; cut 1 corrects it.

---

## 5. The setup chooser on the marketing site

A `/setup` page, with a homepage section linking to it. The visitor answers four questions and the result updates as they go:

1. **Where FrockBot runs:** frockbot.com, or your own Cloudflare account (coming soon until [§6](#6-self-hosting) ships).
2. **Where your computer runs:** FrockBot's, Your Sprites, Your server, Your Mac.
3. **Which model providers you use:** Frock AI, and any of the providers people connect most (Anthropic, OpenAI, OpenRouter, Google, Cloudflare, local), with a per-job view for anyone who opens it.
4. **Your other services:** Jev, voice, dictation, web search, image generation and connected apps, each FrockBot's or yours.

The result shows a diagram of who runs what, **the suggested plan and its price**, what is paid elsewhere, what the person gains and gives up, and the steps to start. A coming-soon choice is labelled and its steps greyed, and the result suggests starting on FrockBot's service today.

The page is static HTML with one script under the site's CSP, rendered from `content/setup-options.json`, which carries each option's status (`available` or `coming-soon`). A test asserts a coming-soon option is never offered as a step to follow. Each cut that lands updates that file in the same pull request. The design is the Setup Chooser canvas.

---

## 6. Self-hosting

Modelled on how Cloudflare OS deploys ([repo](https://github.com/cloudflare/cloudflare-os), [starter](https://github.com/cloudflare/cloudflare-os-starter)).

- **A Deploy button at frockbot.com/deploy.** A hosted flow signs in to Cloudflare, deploys a pinned FrockBot release into the person's account from prebuilt artifacts (nothing built locally), creates the Cloudflare Access application, sets the person as the first admin, and hands them the address. It runs on `workers.dev` by default.
- **Sign-in is Cloudflare Access.** The Access policy decides who gets in, as the simple deployment already does ([ADR 0028](adr/0028-open-deployment.md)).
- **Onboarding happens in the app.** The first visit walks through the same choices as the marketing chooser: link a FrockBot account (optional), then Computer, providers and services. Branding and admin settings are changed in the app without a redeploy.
- **Jev comes from the account's own Workers AI.** Nothing to configure.
- **Linking a FrockBot account** is an OAuth sign-in to frockbot.com from the self-hosted install. It grants that install use of FrockBot's services (Computer, Frock AI, voice, search, image, Composio), billed to that account's credit. No plan is needed.
- **Updates** are offered by the deploy flow: "A new release is available", one click to deploy it over the same Workers.
- **The repository stays the advanced path:** `bun run setup` for a custom domain, code changes or reusing existing resources, with a checklist for moving an install made by the Deploy button into it.

### Cuts

1. **Jev on Workers AI** (shared with §4 cut 2).
2. **Prebuilt release artifacts** a deploy can use without a build.
3. **frockbot.com/deploy** and its Access setup.
4. **In-app onboarding** for a fresh install.
5. **Linking a FrockBot account,** and credit spendable without a plan.
6. **One-click updates.**

---

## 7. Enterprise

The code stays MIT. Organisations pay for what surrounds it:

1. **FrockBot for Teams, a commercially licensed add-on.** The features only organisations need live in a separately licensed package beside the MIT core: organisations and teams (today a tenant is one User, so this is new product), SSO and SCIM, organisation admin and policy, audit export and retention, and shared Bots and Group Chats across people.
2. **Support and an SLA:** a named contact, response times, early security advisories and long-term-support releases to pin.
3. **Managed deployment in their Cloudflare account:** FrockBot installs, upgrades and monitors it; they own the data.
4. **A white-label and trademark licence** on request. MIT grants no right to the FrockBot name; [ADR 0038](adr/0038-white-label-deployments.md) already supports white-label deployments.
5. **A managed custom installation:** a repository for that organisation, built on the white-label path, with its own characters and avatars, branding, extra bindings and custom Packages, which FrockBot maintains and deploys for them.

Before dual licensing anything, contributions need a contributor licence agreement; that is easiest to add before outside contributions arrive.

---

## Suggested order

1. **The marketing chooser,** with coming-soon labels ([§5](#5-the-setup-chooser-on-the-marketing-site)).
2. **Jev on Workers AI** (§4 cut 2), which unblocks self-hosting and Connect Cloudflare.
3. **Providers and jobs, and the AI setup screen** (§4 cuts 1, 3, 4).
4. **The BYO plan** ([§2](#2-plans-and-billing)).
5. **Per-account Computer choice and Your Sprites** (§3 cuts 1–2).
6. **Self-hosting with the Deploy button** ([§6](#6-self-hosting)).
7. **The tethered host, Your Mac and local models** (§3 cuts 3–6, §4 cuts 7–8).
8. **FrockBot for Teams,** starting with organisations as a concept.

## Open questions

1. **Composio for self-hosters.** Does a linked self-hosted install get our Composio from credit, or does it need the BYO plan, as frockbot.com does?
2. **What "your Composio key" means for the connected-apps catalog,** which today is curated against the deployment's key.
3. **Voice on your own key:** Gemini Live only at first, or OpenAI Realtime too?
4. **How Jev picks a model per job:** a new Jev judgment on each Turn, or one pick per job cached until providers change?
5. **Teams pricing,** and whether support, managed deployment and custom installations are priced per seat, per deployment or per contract.
