# Plan: Applets — Instance Contributions, the Applets Package, and the Applets SDK

## Status

Implemented 2026-09-03 on `worktree-applets`, one pull request. Design accepted the same day with [ADR 0022](../adr/0022-applets-as-instance-packages.md) and the matching `AGENTS.md` amendment. Every lane below landed; `docs/architecture.md` §Applets describes the shipped shape and `docs/architecture-checks.md` names the check behind each claim. The end-to-end proof is `apps/cloudflare/e2e/applets-publish.e2e.ts`: a Bot creates an Applet, the built template (produced by the published CLI under Node) is landed in the Workspace store where the Computer's sync would put it, the Bot publishes, the canvas slides the live Applet in, a second page sees a todo the first added, and the Applet's `add_todo` reaches the Bot as an ordinary tool. Screenshots from that run are under `docs/screenshots/applets/`.

Integration findings worth knowing: the loader binding digest now includes the Turn (a cached isolate otherwise served a stale per-Turn `CAPABILITIES` stub on the second Turn); `decodeV5` had dropped a manifest's `roots`; the SDK's health reports tool names and a separate `describe()` carries the declarations with `inputSchema`, matching the kernel; the Applet UI bound is 4 MB, not the Package page's 256 KB; the bridge's `applets` state carries no source (64 KB message bound); the viewer socket enters `AppletState` through `fetch`, not an RPC method; the fake model in e2e reads only the last user message. Still open: `manifest.contributions.instance` is decoded but nothing mounts it (Applets are directory entries, not Package instances, in this slice); the Skill ships through `plugin-skills`'s managed set rather than a `skills` Contribution kind; `applets-shell.e2e.ts` keeps its route stubs because its assertions need a published Applet with a live viewer at load.

## Decisions (accepted in conversation, 2026-09-03)

- **D1** The term is **Applet**. Not app, gadget, or application.
- **D2** Applets are account-wide: owned by the User, visible to every Bot of that User. There is no per-Bot Applet.
- **D3** Instance state is a Durable Object **facet** under the kernel-owned `AppletState` object. ADR 0011 is amended: facets are forbidden for Composition Packages only.
- **D4** Applet tools are ordinary tools in every Bot's catalog (progressive disclosure is handled elsewhere). They enter the Composition as `applet` members.
- **D5** **Versions, not branches.** Publish appends a generation and moves the current pointer; revert moves it back and is recorded. No per-chat proposed-changes branch. Preview is a local run on the Computer.
- **D6** The Applets Package itself must be buildable inside a Bot with identical functionality. It therefore uses only Bot-authorable Contribution kinds and ships as an artifact-backed member that loads through the loader path. The static resolution switches die.
- **D7** Applet source is TypeScript at a durable root on the Computer; typecheck, lint, bundle, and preview run there through the Applets SDK, which embeds Miniflare rather than shelling out to wrangler.
- **D8** React + TanStack DB inside the SDK, schema-first tables. Optimistic updates are per-mutation with rollback on rejection. Real-time by default over a hibernatable WebSocket.
- **D9** Design tokens are the contract; a small **precompiled** component kit on those tokens ships in the SDK, versioned once, never copied into an Applet. A template and a custom linter keep Applets aligned.
- **D10** One focused Applet per Session.
- **D11** Delete now. Quotas, export, public access, and sharing deferred (see ADR 0022 Consequences).
- **D12** The three workerd unknowns are spiked with tests before the build depends on them: (a) facet mount from a kernel DO through `getDurableObjectClass`, (b) WebSocket from a credentialless sandboxed iframe with a viewer token, (c) Miniflare embedded in a Node CLI running an Applet class as a SQLite DO with function service bindings.

## Where we are

| Seam          | Today                                                                                                                                                                | Needed                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Manifest      | `contributions.client` is one iframe page in `frockbot.bot-settings-sections` or `frockbot.tool-result:<tool>` (`packages/kernel-composition/src/manifest.ts:49-71`) | multi-page iframe client, declarative entries, `contributions.instance`                                                   |
| Iframe host   | `PackageIframeHost.vue`, bridge v1 (`init`, `state`, `callTool`, `resize`) (`packages/kernel-contracts/src/iframe-ui.ts`)                                            | bridge v2 adds `applets` state feed and viewer tokens; new slots `frockbot.right-panel`, `frockbot.surface:<id>`; entries |
| Resolution    | static `if/else` over specifier in `applications/foundation/src/runtime.ts:688+`, `user.ts:272-578`, `client.ts:19-40`, `apps/cloudflare/src/bot-state.ts:313+`      | manifest-driven: first-party artifact-backed members load like Bot-authored ones                                          |
| Isolate host  | `packages/kernel-composition/src/isolate-host.ts` mounts `BOT_PACKAGES` isolates; `CAPABILITIES` via `ctx.exports` loopback                                          | `APPLETS` loader binding; `AppletState` DO; `ctx.applets` capability in the isolate context catalog                       |
| Durable roots | `package-declared` roots, `plugin-image` pattern (`packages/plugin-image/src/root.ts`)                                                                               | `applets` root for `@frockbot/plugin-applets`, scope user, read-write                                                     |
| Computer      | Node on the base image, Playwright Chromium installed in the `browser` phase (`packages/computer-host-runtime/src/runtime.ts:1479`)                                  | `applets` provisioning phase: install `@frockbot/applet-sdk` + pinned `miniflare`/`workerd` under the runtime root        |
| Session state | Package-prefixed keys in the Bot DO (`shell:unread`)                                                                                                                 | `applets:focused` per Session, RPC pair, route, `FrockBotWebData` field                                                   |

## Vocabulary

See `CONTEXT.md`: Applet, Instance Contribution, Applet generation, Canvas, Focused Applet, Applets SDK.

## Architecture

### 1. Manifest (kernel-composition)

Manifest `schemaVersion: 5`. Migration of v2–v4 records at the decoder as the constitution requires.

```ts
export interface ClientIframePageV1 {
  id: string; // /^[a-z][a-z0-9-]{0,31}$/
  artifact: ClientIframeArtifactV1; // unchanged
  mounts: ClientMount[]; // allowed slots below
}
export interface ClientEntryV1 {
  id: string;
  slot: "frockbot.sidebar-actions"; // the only entry slot in this slice
  order?: number;
  label: string; // ≤ 32 chars
  icon: string; // a UiIcon name from client-ui
  opens: { kind: "surface"; page: string }; // page id; renders as overlay surface
}
export interface ClientIframeContribution {
  kind: "iframe";
  pages: ClientIframePageV1[]; // 1..8
  entries?: ClientEntryV1[]; // 0..4
}
export interface InstanceContributionV1 {
  contract: 1;
  server: ArtifactRefV1; // ESM module exporting `Applet`
  ui: ClientIframeArtifactV1; // one HTML page
  tools: ManifestToolDeclaration[]; // what the instance exposes to Bots
}
// FrockBotManifest gains `contributions.instance?: InstanceContributionV1`.
```

Allowed iframe page slots: `frockbot.bot-settings-sections`, `frockbot.tool-result:<declaredTool>`, `frockbot.right-panel`, `frockbot.surface:<pageId>` (a page reachable from an entry). The three allowlists (`manifest.ts`, `kernel-contracts/src/iframe-ui.ts`, `plugin-authoring/src/shared.ts`) collapse into one exported predicate in `kernel-contracts`.

The existing single-page shape (`artifact` + `mounts` at the top level) migrates to `pages: [{ id: "main", … }]`.

### 2. Kernel: `AppletState` and the directory

**Records (`packages/kernel-do/src/applets.ts`)**

```ts
export interface AppletDirectoryEntryV1 {
  // User DO, key `applets:entry:<appletId>`
  schemaVersion: 1;
  appletId: string; // `<publicUserId>.<random>` (ADR 0015 shape)
  displayName: string;
  currentGenerationId?: string; // absent until first publish
  tools: ManifestToolDeclaration[]; // copy of the current generation's declarations
  provenance:
    | { kind: "bot"; botId: string; sessionId: string; turnId: string }
    | { kind: "user" };
  createdAt: string;
  status: "draft" | "published" | "deleted";
}
export interface AppletGenerationV1 {
  // AppletState DO, key `applet:generation:<generationId>`
  schemaVersion: 1;
  generationId: string; // sortable, monotonic per Applet
  parentGenerationId?: string;
  server: ArtifactRefV1;
  ui: ClientIframeArtifactV1;
  tools: ManifestToolDeclaration[];
  contract: 1;
  origin: "publish" | "revert";
  provenance: {
    botId: string;
    sessionId: string;
    turnId: string;
    runId: string;
  };
  createdAt: string;
  status: "pending" | "active" | "superseded" | "failed";
}
// AppletState also stores `applet:current`, `applet:last-known-good`, `applet:failure:<gen>:<n>`.
```

**`AppletState` Durable Object (`apps/cloudflare/src/applet-state.ts`, binding `APPLET_STATES`, id `idFromName("<userId>:<appletId>")`)**

- `publish(request)`: intent → record generation `pending` → load server artifact from `APPLICATION_ARTIFACTS` (hash verified) → `env.APPLETS.get(loaderId, …)` with `globalOutbound: null`, `env: { IDENTITY, CAPABILITIES }`, limits → `ctx.facets.abort(prev)`; `ctx.facets.get("applet", () => ({ class: stub.getDurableObjectClass("Applet"), id: "applet" }))` → `health()` on the facet (contract version, tool list equals declaration, `migrate` completed) → `active`, previous `superseded`, last-known-good set. Failure: record `applet:failure`, keep the prior facet resident, return a visible failure.
- `revert(toGenerationId)`: same mount path with `origin: "revert"`; never sets last-known-good.
- `invokeTool(name, input, caller)`: forwards to the facet's `invokeTool`, bounded by the isolate limits.
- `connect(viewerTokenClaims, request)`: forwards a WebSocket upgrade to the facet's `fetch`. The facet uses the hibernation API.
- `delete()`: `ctx.facets.delete("applet")`, `deleteAll()` of its own records.
- Loader id: `sha256(contract + serverHash + bindingDigest)`; binding digest = `isolateBindingDigestV1` inputs for the _User_ (no Bot), since the instance is account-wide.

**User DO**: `applets:entry:*` directory plus `listApplets`, `createApplet`, `deleteApplet`, `recordAppletGeneration`. Deleting marks the entry `deleted`, calls `AppletState.delete()`, and bumps a `applets:directory-revision` so every Bot's next Composition resolution drops the tools.

**Composition (`packages/kernel-composition/src/generation.ts`)**: a new member kind:

```ts
export interface CompositionAppletMemberV1 {
  kind: "applet";
  appletId: string;
  generationId: string;
  tools: ManifestToolDeclaration[];
  provenance: PackageProvenanceV1;
}
```

Members are resolved at generation creation from the User directory; their tools register with an executor that calls `APPLET_STATES` → `invokeTool`. `artifactSetHash` covers them. A Bot cannot author, install, or remove an applet member directly; they follow the directory.

### 3. Isolate capability `ctx.applets`

Added to `BotCapabilities` (`apps/cloudflare/src/bot-capabilities.ts`) and the generated catalog (`scripts/generate-isolate-context-catalog.ts` must be re-run):

```ts
interface AppletsCapabilityV1 {
  list(): Promise<AppletSummaryV1[]>;
  create(input: { displayName: string }): Promise<AppletSummaryV1>; // creates the entry + scaffolds the root from the template
  publish(input: { appletId: string }): Promise<AppletPublishResultV1>; // reads `applets/<id>/dist/{server.js,ui.html,manifest.json}` from the durable root
  revert(input: {
    appletId: string;
    generationId: string;
  }): Promise<AppletPublishResultV1>;
  delete(input: { appletId: string }): Promise<void>;
  focus(input: { appletId: string | null }): Promise<void>; // per Session
  generations(input: {
    appletId: string;
  }): Promise<AppletGenerationSummaryV1[]>;
}
```

`publish` is the durable effect: the Bot DO records intent, reads the three files through the Workspace store (forcing a pull of the root first through the Computer Package's existing sync seam), verifies `manifest.json` (tools, contract), puts artifacts (`packages/<hash>.mjs`, `packages/<hash>.html`), records the generation on the User directory, and calls `AppletState.publish`. It then proposes a new Composition generation for the calling Bot (the others pick it up at their next resolution via the directory revision).

### 4. Viewer sessions

- Route `GET /api/applets/:appletId/token` (user application, session-authenticated) → `{ token, expiresAt, socketUrl }`. Token = HMAC-SHA-256 over `{ userId, appletId, generationId, exp }` with the deployment secret already used for share ids; 15 minutes.
- Route `GET /api/applets/:appletId/socket?token=…` on the **gateway** (the artifact origin must be allowed by CSP `connect-src`), verifies the token, forwards the upgrade to `AppletState.connect`.
- The applet page never sees a cookie. The Applets canvas page receives `{ appletId, token, socketUrl, uiUrl }` through the bridge's `applets` state and nests the applet UI iframe with those in its `init`.

### 5. Shell (plugin-shell client)

- Render `entries` from the iframe catalog: a `k-slot` filler for `frockbot.sidebar-actions` per entry, ordered, opening a surface that hosts the named page in `PackageIframeHost`. The Applets entry uses `order: 5` so it sits above Connectors (`order: 10`).
- `frockbot.right-panel` iframe pages render in the panel body when the Session has a focused Applet, otherwise the panel keeps today's content. On phone the panel stays closed until opened; a chip on the composer ("Applet: Todo · Open") opens it.
- Bridge v2: host message `state` name `applets` carries `{ focused, list, viewer: { token, socketUrl, uiUrl } | null }`; page message `focus` `{ appletId | null }` is allowed for pages of the Package that owns the Applets tools (checked server-side like `callTool`).
- Iframe artifact CSP gains `frame-src <artifactOrigin>` and `connect-src <gateway origin>` so the canvas page can nest the applet UI and the applet UI can open its socket.

### 5a. Canvas states and polish (added 2026-09-03 at the owner's request)

The canvas has two states, modelled on cloudflare-os's gadget editor (`packages/workshop-frontend/src/GadgetUI.tsx`, `GadgetEditor.tsx`, `GadgetCodeInterface.tsx`):

- **Building.** While the focused Applet has no active generation, or a Turn is editing it, the canvas shows the Applet's source as it is written: a file list and the current file's contents, refreshed from the Workspace store (route `GET /api/applets/:appletId/source` returning the files under `applets/<id>/` with their generation ids, ≤ 512 KB total, text only), plus the latest `applet check` / `applet build` outcome the Bot recorded. Nothing here waits on the Computer: the store is read, never the Sprite.
- **Ready.** When a generation is active the canvas slides the live Applet in over the code view with a real transition (translate + fade, ~240 ms, respecting `prefers-reduced-motion`); a small header carries the Applet name, a "Code" toggle back to the source view, the generation id, and the open-in-new-tab action. A publish that fails leaves the code view up with the failure inline.
- The panel itself slides out from the right edge on desktop and rises as a full-height sheet on the phone layout; opening and closing animate; the composer chip is the phone's entry.

Reference behaviours from cloudflare-os's `GadgetEditor.tsx` to carry over (verified in source 2026-09-03): the right pane has **App / Code** tabs (their third tab, Connections, has no equivalent here — Connections is its own surface); the tab follows the Turn unless the User picked one (`userSelectedTab`): a Turn that wrote applet code lands on App, one that wrote a file lands on Code, and the Code view follows the file currently being streamed; the pane animates `width, opacity` over 200 ms ease-out and has a drag handle whose width persists; a 2 px animated "thinking" bar runs across the top of the pane while a Turn is active; loading is a spinner with a caption, and a load that exceeds a timeout offers Retry instead of spinning forever; on phones the pane opens full-screen through `openMobilePane(tab)`; a full-screen preview mode exists with Escape forwarded from inside the iframe.

Before the pull request opens, the integrator (not a lane) runs the UI end to end with the screenshot harness at the GrokBot window size and the 390px phone size, compares against cloudflare-os's canvas, and fixes polish in place: spacing on the tokens, empty states, loading skeletons, focus rings, transition timing, and the code view's typography.

### 6. Focused Applet

Bot DO key `applets:focused` `{ schemaVersion: 1; appletId: string | null; changedAt: string }`. RPC `readFocusedApplet` / `setFocusedApplet`; route `/api/bots/:botId/applets/focus`; `FrockBotWebData.focusedApplet` + loader. `applet_create` and `applet_publish` set focus by default.

### 7. Durable root and Computer

- `packages/plugin-applets/src/root.ts`: `APPLETS_PACKAGE_ID_V1 = "applets"`, `APPLETS_SOURCE_ROOT_ID_V1 = "source"`; mount path `/home/box/agent-data/user-packages/applets/source/<appletId>/`, scope user, read-write (the `plugin-image` pattern).
- `computer-host-runtime` gains an `applets` provisioning phase after `browser`: `npm install --prefix ${RUNTIME_ROOT}/applets @frockbot/applet-sdk@<pinned> miniflare@<pinned>` and a `applet` shim on PATH. Pinned versions are constants in `runtime.ts` beside the Playwright pin. `UPDATE_PHASES` gets the counterpart.
- The Bot works in the root with ordinary Computer file tools and `applet check`, `applet dev`, `applet build`. A Skill shipped by the Applets Package (`skills/applets.md`) teaches the SDK; the Bot loads it through the existing catalog.

### 8. Applets SDK (`packages/applet-sdk`, published as `@frockbot/applet-sdk`)

```
applet-sdk/
  server/   Applet base class (DurableObject): tables → SQLite DDL, mutations, sync log, WS protocol v1,
            tools registration, migrate hook, health()
  client/   createApplet(): TanStack DB collections per table over the socket; useLiveQuery; useApplet()
  kit/      precompiled React components on --frockbot-* tokens: Button, Input, Textarea, Select, Checkbox,
            Card, List, ListItem, Dialog, Toolbar, Stack, Text, Badge, EmptyState
  cli/      applet new | check | lint | dev | build   (dev embeds Miniflare)
  lint/     eslint config + custom rules (no raw colours, no fetch, no external URLs, kit only, tables schema-first)
  template/ the `applet new` scaffold: applet.json, server.ts, ui.tsx, README
```

Server shape a Bot writes:

```ts
import { Applet, table, t } from "@frockbot/applet-sdk/server";

export class TodoApplet extends Applet {
  tables = {
    todos: table({
      id: t.id(),
      title: t.text(),
      done: t.boolean().default(false),
      createdAt: t.timestamp(),
    }),
  };
  tools = {
    add_todo: this.tool(
      { description: "Add a todo", input: { title: t.text() } },
      async ({ title }) => {
        await this.db.todos.insert({ title });
        return `Added "${title}"`;
      },
    ),
  };
}
```

Client shape:

```tsx
import { createApplet } from "@frockbot/applet-sdk/client";
import {
  Button,
  Checkbox,
  Input,
  List,
  ListItem,
  Stack,
} from "@frockbot/applet-sdk/kit";
import type { TodoApplet } from "./server";

const applet = createApplet<TodoApplet>(); // connects on mount, real-time by default
export default function App() {
  const { data: todos } = applet.useLiveQuery((q) =>
    q.from({ t: applet.tables.todos }).orderBy(({ t }) => t.createdAt),
  );
  return (
    <Stack>
      …{" "}
      <Checkbox
        checked={todo.done}
        onChange={(done) =>
          applet.tables.todos.update(todo.id, (d) => {
            d.done = done;
          })
        }
      />{" "}
      …
    </Stack>
  );
}
```

Wire protocol v1 (both directions JSON, ≤ 64 KB per frame): `hello` (contract, generationId, viewer), `snapshot` (per table rows), `changes` (txn id, per-row insert/update/delete), `mutate` (client txn: mutations), `ack` / `reject` (txn id, reason). TanStack DB's collection `sync` applies `snapshot` and `changes`; `onInsert/onUpdate/onDelete` send `mutate` and resolve on `ack`, throw on `reject` (which rolls the optimistic state back).

`applet build` produces `dist/server.js` (ESM, single file, no imports), `dist/ui.html` (single file: React, TanStack DB, kit, app inlined; token CSS variables read from `--frockbot-*`), and `dist/manifest.json` (`{ contract: 1, tools, hashes }`). `applet check` runs `tsc --noEmit` with the SDK's declaration files and the lint rules; diagnostics print in a form the Bot can act on.

`applet dev` starts Miniflare with the built server module as a SQLite DO class, serves `ui.html` on a local port with a local viewer token, and implements `CAPABILITIES` as function service bindings that return `unavailable` for models in this slice (the lease-backed proxy is a later slice). It opens nothing; the Bot opens the URL in the Computer's browser and screenshots.

### 9. The Applets Package (`packages/plugin-applets`)

Bot-shaped, no in-process code:

- `frockbot.json` v5: `runtime: { entry: "./package", host: "bot-isolate" }`, `tools: [applet_list, applet_create, applet_publish, applet_revert, applet_delete, applet_focus, applet_generations]`, `client: { kind: "iframe", pages: [{ id: "list", mounts: [{ slot: "frockbot.surface:list" }] }, { id: "canvas", mounts: [{ slot: "frockbot.right-panel" }] }], entries: [{ id: "open", slot: "frockbot.sidebar-actions", order: 5, label: "Applets", icon: "applets", opens: { kind: "surface", page: "list" } }] }`, and a declared root `source`.
- `src/package.ts`: the isolate-shaped module (`export const tools`, `export async function execute`) calling `ctx.applets.*` and `ctx.workspace.*`.
- `src/pages/list.html`, `src/pages/canvas.html`: inline pages on the bridge helper.
- `skills/applets.md`: the SDK reference Skill.
- Build: `scripts/build-applets-package.ts` bundles the module and pages, hashes them, and emits `applications/foundation/generated/applets-artifact.ts`; the foundation application lists the member with `provenance: first-party` **and** an `artifact`, so it loads through the loader.

### 10. Manifest-driven resolution (kills the switches)

`applications/foundation/src/runtime.ts`, `user.ts`, `client.ts`, and `apps/cloudflare/src/bot-state.ts` resolve contributions from a **registry keyed by specifier that the Package's own entry module populates**, not by identity in the application. Concretely each first-party package's entry exports `contribution` metadata (`{ specifier, host, create }`) and the foundation application imports the entries into a table at build time; the application code iterates the plan and looks up the table. Any specifier in the plan without a table entry **and** without an artifact is a compile error of the application. Artifact-backed members skip the table and go to the loader. This is a mechanical refactor with no behaviour change, proven by the existing suites.

## Lanes

Each lane is one subagent on this branch, in its own worktree off `worktree-applets`, merged back by the integrator. Lane order respects dependencies; lanes marked ∥ run concurrently.

| Lane                    | Scope                                                                                                                                                       | Depends on  | Proof                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **S1** spike            | facet mount through `getDurableObjectClass` from a kernel DO in workerd; abort/remount over same storage; `facets.delete`                                   | —           | `apps/cloudflare/test/applet-facet.spike.ts` green; findings appended to `docs/research/spike-applet-facets.md`                  |
| **S2** spike ∥          | Miniflare embedded in a Node script running a SQLite DO class with function service bindings and a WebSocket                                                | —           | `packages/applet-sdk/spike/miniflare.spike.test.ts` green                                                                        |
| **K1** manifest ∥       | v5 manifest, pages/entries/instance, migration, single slot predicate, `package_author` accepts pages + entries                                             | —           | kernel-composition + kernel-contracts + plugin-authoring tests                                                                   |
| **K2** resolution ∥     | manifest-driven resolution replacing the four switches                                                                                                      | —           | full suite green with no test edits; architecture check "no switch over Package identity"                                        |
| **K3** applet authority | `AppletState` DO, User directory, composition `applet` members, `ctx.applets`, viewer tokens + socket route, delete                                         | S1, K1      | workerd tests: publish/mount/health, remount keeps storage, revert, failure keeps prior facet, delete, tool routing, token scope |
| **U1** shell ∥          | entries, right-panel iframe slot, surfaces from pages, focused Applet state, bridge v2, CSP, phone chip                                                     | K1          | plugin-shell tests, e2e at desktop + 390px                                                                                       |
| **C1** computer ∥       | `applets` root, provisioning phase, `applet` shim, pull-before-publish seam                                                                                 | —           | computer-host-runtime tests; provisioning document renders                                                                       |
| **SDK** ∥               | `packages/applet-sdk` per §8 incl. kit, lint, template, CLI, dev runner                                                                                     | S2          | unit tests: DDL from tables, sync protocol round-trip, optimistic rollback, lint rules, `applet build` output shape              |
| **P1** package          | `packages/plugin-applets` per §9 + build script + foundation member + Skill                                                                                 | K1, K3, SDK | pressure test: the Package authored via `package_author` in workerd mounts and lists/creates/publishes identically               |
| **E2E**                 | Bot creates a todo Applet from the template, publishes, canvas shows it, a second browser sees a real-time insert, `add_todo` tool works, delete removes it | all         | `apps/cloudflare/e2e/applets.e2e.ts`                                                                                             |

## Out of scope (recorded so they are not mistaken for oversights)

Quotas and spend, SQLite export, collaborators and cross-User sharing, public unauthenticated access and hostnames, lease-backed model calls from `applet dev`, per-chat proposed-changes branches, more than one focused Applet per Session.
