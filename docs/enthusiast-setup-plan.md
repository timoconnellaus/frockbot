# Enthusiast setup plan

**Status:** proposed. Nothing here is built yet, and the open questions at the end need answers before the first cut starts.

**Why:** FrockBot's differentiator is being the most useful Bot for people who like to tinker. The zero-configuration default stays exactly as it is. Configuration that extends reach is what this plan adds, in three places:

1. **Where the Computer runs.** Today every account gets FrockBot's own cloud Computer. A User may instead run it on their own Sprites account, their own VPS, or a virtual machine on the desktop the app runs on.
2. **How each model is connected.** Today a User can choose one thing: the Bot's conversational model. Every other model use (summaries, specialists, Jev, voice, image) is fixed. A User should see every model FrockBot uses, and choose how each one is connected.
3. **A setup chooser on the marketing site.** A visitor picks how they'd like FrockBot set up and sees what they get, what it costs and how to start.

Parts 1 and 2 are independent and can be built in either order. Part 3 can ship first, as long as it marks what is not built yet.

---

## 1. Where your Computer runs

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
| **This computer**                 | A Linux VM the desktop app runs on the User's own Mac                                   | While the Mac is awake and the app is running | Nobody                   |

All four present the same Computer to the Bot: a shell, files, a browser, and (where the host has one) a desktop the User can watch and take over. The Bot does not know which one it has, apart from what the capabilities say.

### Shape

Two host implementations cover all four choices, not four.

**A. Fly, with the account's own token.** `FlyComputerHostV1` gains a per-assignment credential. The User's Fly token is an account secret, stored encrypted like a model API key. On `open`, the app passes the computer-host Worker a short-lived lease that resolves to the token server-side. The container builds a `SpritesClient` per assignment rather than once at boot. Nothing else about the Fly host changes.

**B. A tethered host, `computer/tether`.** A small agent program, `frockbot-computer`, is installed on the User's machine. It dials **out** to FrockBot over a WebSocket, so it works behind NAT and needs no open ports, DNS or TLS certificate. It serves the same primitives the on-Sprite runtime does today: exec, files, processes, browser, screenshot and, when installed with a desktop, the viewer and control. The cloud side is a `ComputerHostV1` whose session calls travel over that socket.

- **Your server:** a one-line installer (`curl … | sh`) installs the agent and its packages (Chromium, and optionally Xvfb, a window manager and a VNC server for the desktop), then prints a pairing code. It runs as its own unprivileged user under systemd.
- **This computer:** the Mac app creates a Linux VM with Apple's Virtualization framework, from an image FrockBot publishes, and runs the same agent inside it. Pairing is automatic because the app is already signed in. The Bot's commands run inside the VM, never on the Mac itself, so untrusted code still gets its own boundary.

Pairing reuses `app/machine`'s pairing and socket transport, not its tool semantics. A tethered Computer is the Bot's machine; there is no approval per command, exactly as on FrockBot's own Computer.

The on-Sprite runtime (`computer/fly/runtime.ts`, about 2,500 lines of layout and scripts) is mostly plain Linux. It moves to a shared `computer/linux-runtime` that both the Fly host and the tether agent run, so both stay one implementation of "what a Computer is".

### What changes above the host

- **The choice becomes account-shaped.** The User object stores `computerHost: { kind: "frockbot" } | { kind: "sprites", credentialId } | { kind: "tether", machineId }`. The runtime reads it and calls `assign` with that provider and configuration, instead of the hardcoded default. Every Bot the User owns gets the same Computer, as today.
- **Capabilities move from the deployment to the session.** `viewerFrameOrigins`, `desktop` and a new `availability: "always" | "while-connected"` come from the assigned host. A tethered viewer is relayed through the app origin, so it adds no frame origin. The deployment-wide CSP keeps the Sprites origin only while any account can choose Sprites.
- **Offline is a normal state.** When a tethered Computer is not connected, a Computer tool call fails fast with "Your computer is offline". The model sees that as the tool result; nothing waits. A Routine whose work needs the Computer reports the same thing in its run. The Computer settings page shows the connection state and when the machine was last seen.
- **Switching host is a replace, not a migration.** Switching tears down the old assignment (with the existing "Delete my Computer" path where the old host supports it) and provisions the new one fresh. The settings page says clearly what is lost. Carrying files between hosts is a possible later step, not this plan.
- **Connected accounts still never touch the machine.** The egress proxy that attaches connected-account credentials stays in the cloud. The tether agent routes proxied commands back through the socket, so a User's own VPS never holds a connected-app secret either.
- **Billing.** Computer time on a User's own machine or own Sprites does not draw from the FrockBot balance. Pricing copy changes with it.

### Settings UI

The Computer page (`computer/settings.dart`) gains a **Where it runs** section at the top: the four choices as cards, each with its current state. Choosing one opens its setup:

- **FrockBot's Computer:** nothing to set up.
- **Your Sprites:** paste a Fly token, test it, done.
- **Your server:** shows the install command and waits for the pairing, then shows the machine's name, OS and whether it has a desktop.
- **This computer:** desktop app only. It shows the disk and memory the VM will use, downloads the image, and starts it.

### Cuts

Each cut leaves `main` shippable.

1. **Per-account host choice.** The `computerHost` record on the User, `assign` driven by it, capabilities per session, and the Where it runs section with only FrockBot's Computer enabled. No behaviour changes.
2. **Your Sprites.** The per-assignment credential in the Fly host and computer-host container, the Fly-token secret, and its setup card.
3. **Shared Linux runtime.** `computer/fly/runtime.ts` moves to `computer/linux-runtime`, with no behaviour change, proven by the existing Fly tests.
4. **Tether host and agent, headless.** `computer/tether`, the `frockbot-computer` agent and the installer, running exec, files, processes, browser and screenshot. It must pass `computer/host-contract.test.ts`. Offline handling ships here.
5. **Tether desktop.** The viewer relay and control on a tethered host installed with a desktop.
6. **This computer.** The Mac app's VM on the Virtualization framework, running the cut 4–5 agent.

---

## 2. How each model is connected

### Today

- **Connections** are per account (`providers/model-connections/user.ts`): 28 catalog providers with an API key, OAuth sign-in for some, Ollama Cloud, Frock AI built in, and DeepSeek served by a Plugin.
- **The conversational model** is the only choice a User makes. It resolves Bot override → account default (`user.accountModel`) → platform model, in `resolveEffectiveBotModelV1` (`core/configuration/index.ts`).
- **Everything else is fixed:** compaction uses the first provider with a `summaryModel` (Frock AI's `@frock/structured`); the writing, coding, thinking and vision specialists are Frock AI gateway routes; Jev is a hosted client on a pinned model with a deployment key (`app/supervision/jev.ts`); voice, dictation and image are wired directly to their vendors.
- **Setting up a model** is split across three screens: Marketplace (add a provider), Provider accounts (key or sign-in), and Models (one default-model select).

### Model roles

A **Model role** is one job FrockBot uses a model for. Each role has a default, a set of capabilities a model must have to fill it, and a binding the User may set.

| Role                    | Used for                                                         | Must support                                 | Selectable in this plan                      |
| ----------------------- | ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Chat                    | The Bot's own conversation                                       | Tools, streaming                             | Yes (as today, now one row among the others) |
| Writing                 | The writing specialist                                           | Streaming                                    | Yes                                          |
| Coding                  | The coding specialist                                            | Tools                                        | Yes                                          |
| Thinking                | The thinking specialist                                          | Tools                                        | Yes                                          |
| Vision                  | The vision specialist, and reading images                        | Image input                                  | Yes                                          |
| Summary                 | Compaction and summaries                                         | Structured output                            | Yes                                          |
| Jev                     | Supervision: reviewing responses and calls, choosing who replies | Structured output, and passing the Jev evals | Open question 1                              |
| Voice, dictation, image | Their own vendor protocols                                       | —                                            | No. Shown read-only, with what serves them   |

Roles are account-shaped: every Bot uses the account's roles. A Bot may still override its own Chat model, which is the one per-Bot exception that exists today.

### Shape

- **One record.** `user.modelRoles: Partial<Record<ModelRoleId, ModelBindingV1>>` replaces `user.accountModel`; `accountModel` is deleted, not migrated, with a scoped cleanup of stored test data. An unset role uses the platform default for that role.
- **One resolver.** `resolveModelRoleV1(role, bot)` generalises `resolveEffectiveBotModelV1`: Bot override (Chat only) → account role → platform default. A binding whose connection is gone, or whose model lacks the role's capabilities, falls back to the default and records `fallback.from`, exactly as Chat does today.
- **The callers use it.** Compaction reads the Summary role instead of scanning for a `summaryModel`. A specialist Task reads its role instead of a fixed gateway route; Frock AI's routes become those roles' platform defaults.
- **Capability checks use the catalog's existing flags** (`vision`, `structuredOutput`, tool support). The model picker filters by the role it is choosing for, and says why a model is missing rather than hiding it silently.
- **A local model** (Ollama or LM Studio) running on a tethered Computer from part 1 can serve any role. The request travels over the tether socket to `localhost` on the User's machine. It is still a model call carrying a `requestId` idempotency key, and costs nothing. This is the one place parts 1 and 2 meet; it waits until the tether host exists.

### Settings UI: AI setup

One screen replaces the Models page. It is where a User answers "which model does what, and how is it connected".

- **At the top, three presets:** _FrockBot handles it_ (every role on Frock AI; the default), _Use my own keys_ (every role on the User's connected providers, with the best available model per role), and _Everything local_ (every role on a local model, once part 1 cut 4 exists). A preset fills the roles; the User can still change any row after.
- **One row per role:** the role's name, what it is for in a few words, and what serves it now, for example "Writing — Claude Sonnet via your Anthropic key". A row that fell back says so, with the reason.
- **Tapping a row** opens one sheet with two steps: _How it's connected_ (Frock AI, one of the User's connections, a new provider, or a local model), then _Which model_, filtered to models that can fill the role. Adding a provider from here runs the existing key or sign-in form inline, so a User never leaves the sheet to set up a connection.
- **Below the roles,** the connected provider accounts, as the Provider accounts page lists them today.

It stays a projection in the settings-document family: the `modelsSettingsFrame` in `app/settings/settings-frame.ts` grows a section per role, and `modelsSettingsCommand` accepts `role.<id>` keys alongside a `preset` command. The options query (`/api/settings/models/options`) takes a `role` to filter by.

### Cuts

1. **Roles and resolver, Chat only.** `modelRoles` replaces `accountModel` (with its cleanup), `resolveModelRoleV1` replaces the Chat resolver, and the Models page shows the Chat row from the new frame. No visible behaviour change.
2. **Summary and specialists.** The Summary, Writing, Coding, Thinking and Vision roles, their capability checks and their callers.
3. **AI setup screen.** The role rows, the two-step sheet with inline provider setup, the read-only rows, and the presets that exist so far.
4. **Jev,** if open question 1 says yes.
5. **Local models,** after part 1 cut 4.

`docs/architecture.md` §7 still describes the account model as a User-scoped Package setting; cut 1 corrects it.

---

## 3. The setup chooser on the marketing site

### What it is

An interactive section, _Set up FrockBot your way_, on the homepage, with a full version at `/setup`. The visitor answers four questions and a diagram and summary update as they go:

1. **Where FrockBot runs:** frockbot.com, or your own Cloudflare account ([ADR 0028](adr/0028-open-deployment.md)).
2. **Where your Computer runs:** the four choices from part 1.
3. **How your models are connected:** FrockBot handles it, your own keys, local models, or a mix, with a per-role view for anyone who opens it.
4. **Which apps you'll use it from:** phone, desktop, web.

The result shows:

- **A diagram** of the chosen setup, drawn in the site's product style: the apps, FrockBot, the Computer and the models, with each part labelled by where it runs.
- **What it costs:** the FrockBot plan, plus what the visitor pays elsewhere (their VPS, their Fly account, their model provider), in plain words rather than a calculator.
- **What you give up or gain,** in a sentence each: for example "This computer" is free but only works while your Mac is awake.
- **How to start:** the real steps for that setup, with the right call to action (download, sign up, or `bun run setup`).

### Constraints

- **Plain static site.** `apps/marketing` is hand-written HTML, CSS and vanilla JS under a strict CSP (`script-src 'self'`, no inline script or style). The chooser is one `setup.js` and markup in the page, following `how-it-works/capabilities.js`.
- **Driven by data, and honest.** The options, their costs and their **status** (`available`, `coming-soon`) live in `content/setup-options.json`, rendered into the page the way `content/capabilities.json` is, with a `--check` step in the build. A `coming-soon` option is shown and labelled, never offered as a step to follow. A test asserts that, following the store-badge rule. The chooser can therefore ship before parts 1 and 2 finish, and each cut that lands flips its option to `available`.
- **Works without JavaScript:** the default setup is rendered in the HTML, and the questions are ordinary radio inputs.
- **Pricing copy stays true.** The homepage pricing says every plan's Computer time draws from the balance. That copy, and its test, change in the same cut that lets a Computer run elsewhere.

### Cuts

1. The section on `/setup` with every choice from today's product available and every planned choice marked coming soon, plus a teaser on the homepage linking to it.
2. Each part 1 and part 2 cut that lands updates `setup-options.json` in the same pull request.

---

## Suggested order

1. **Part 3, cut 1:** the chooser, with coming-soon labels. It is small, self-contained, and puts the direction in front of people early.
2. **Part 2, cuts 1–3:** model roles and the AI setup screen. Mostly app and settings code on existing machinery.
3. **Part 1, cuts 1–2:** per-account host choice and Your Sprites. Small, because the Fly host exists.
4. **Part 1, cuts 3–5:** the tether host, which is the largest piece of new work here.
5. **Part 1, cut 6, and part 2, cut 5:** this computer and local models.

## Open questions

1. **Can a User choose Jev's model?** Jev runs on a pinned, evaluated model through its own hosted client, and the supervision plan gives it no permissive failure mode. Letting a User swap it means routing Jev through the normal connection layer and gating a choice on passing the Jev evals. Recommendation: not in the first pass; show Jev as a read-only row.
2. **What does BYO Computer do to pricing?** Is there a cheaper plan for someone who brings their own Computer and their own keys, or is the plan price unchanged and only the balance draw goes away?
3. **Does "This computer" need Windows and Linux desktops at launch,** or is macOS (Virtualization framework) enough for the first release?
4. **Must a server Computer have a desktop?** Recommendation: the installer offers both, and a headless Computer simply has no viewer, which the capabilities already express.
5. **Should the chooser also cover self-hosting FrockBot itself,** or stay about the hosted product? Recommendation: include it, since the enthusiasts this is aimed at are the self-hosting audience.
