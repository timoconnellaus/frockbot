# Package-authored UI

Exploration of how a Package that FrockBot did not write — User-installed from
the catalog, or authored by a Bot for itself — contributes user interface.

This is a prerequisite for the spend-tracking work in
`docs/plans/spend-tracking.md`: the Usage & Billing panel that plan ends at is
itself a UI surface, and building it as hardcoded first-party chrome would be
building the wrong thing if Packages are meant to own UI.

## Where the code actually stands

Four separate gaps sit between here and a Bot changing what a User sees. Only
the fourth is hard.

**1. Authoring does not offer the host.** `authoredManifestV1` in
`packages/plugin-authoring/src/shared.ts` synthesizes a Bot-authored Package's
manifest rather than accepting one, and says why in its own comment:

> The manifest an authored Package is content-addressed by. It is synthesized
> rather than authored **so a Bot cannot declare a Contribution host the kernel
> did not offer it**: exactly one Bot isolate runtime Contribution, plus the
> declared model binding when the Package asked for one.

So a Bot today authors exactly one thing: a tool, in an isolate, optionally with
a model binding. The absence of UI is not an oversight to be patched; it is a
deliberate closed door, and opening it is the decision this document is about.

**2. There is no browser build path.** `apps/cloudflare-bundler` compiles a
Package to a single Worker module and fails closed on any specifier it could
not inline. It emits Worker code for a Dynamic Worker, not a browser bundle.
Nothing in the repo compiles Package-supplied Vue, JSX, or templates.

**3. There is no runtime load path.** `apps/cloudflare/src/client/index.ts`
installs `foundationClientPlugins` — a compile-time array imported from
`@frockbot/application-foundation/client`. The hosted client's plugin set is
fixed when the client bundle is built. Nothing loads a client Contribution at
runtime.

**4. There is no trust model for untrusted code in the page.** This is the one
that matters.

What does exist, and is worth keeping: `ClientContribution` in
`kernel-composition/src/manifest.ts` already declares `mounts: ClientMount[]`
and `outlets`, `ClientApplication` already resolves named slots, and the
composition machinery already dispatches by Contribution kind through a
registered `ContributionHost` with `prepare`/`commit`. The seam for a client
host is cut. It has no implementation on the browser side.

## Why gap 4 is the whole problem

`ClientPluginContext` in `packages/client-core/src/index.ts` hands every
installed plugin:

```ts
export interface ClientPluginContext {
  transport: AgentTransport;
  slot(registration: ClientSlotRegistration): () => void;
  provide<T>(key: InjectionKey<T>, value: T): () => void;
  inject<T>(key: InjectionKey<T>): T;
}
```

`transport` is the authenticated transport — every backend command, as the
User. `inject<T>(key)` reaches anything any other plugin provided, which
includes the Connections and credentials surfaces. And a registered Vue
component runs in the WebUI origin with full DOM access, against a better-auth
cookie session (`apps/cloudflare/src/auth.ts`), so it can also make credentialed
same-origin requests that never touch `transport` at all.

Set that beside what the same Bot's backend code gets. From the constitution:

> Every Package whose recorded provenance is not first-party executes in a
> Dynamic Worker isolate the Bot's Durable Object loads for it, with
> `globalOutbound` disabled, only the capability bindings the Bot's Assignments
> grant, and no access to secrets, the keyring, or any Durable Object state
> other than the bindings expose.

A Bot's tool cannot reach the network. Its UI, shipped the way client plugins
work today, would hold the User's entire browser session. That is not a
loophole to be closed later; it inverts the authority model. It also breaks a
rule directly:

> Self-modification never widens authority. Bot-authored code runs with the
> capabilities the Bot already holds; a request for more becomes a durable
> pending decision for the User, never a grant.

**Constitutional gate.** The isolate rule names one host — a Dynamic Worker —
because when it was written, non-first-party code only ran there. Browser-hosted
non-first-party code is not covered by it, in either direction: not permitted,
not forbidden, not addressed. Per the constitutional gate, implementation waits
on an explicit amendment naming what host non-first-party UI runs in and with
what authority. Option B below is the one path that needs no such amendment,
which is a substantial part of why it is the recommendation.

## Option A — install Bot code as an in-page plugin

Extend `authoredManifestV1` to offer a client Contribution, build the Package's
component, load it at runtime, call `ClientApplication.install`.

Cheapest to build and the only option with no fidelity ceiling. It is also the
authority inversion described above, on a session cookie, in the origin that
renders the Connections UI. **Rejected**, and worth recording as rejected so it
is not rediscovered as an obvious shortcut.

## Option B — a declarative view vocabulary

The Package returns a versioned description of a view. First-party components
render it. No Package-authored code ever runs in the browser.

**This repo already does this, and so does GrokBot.**
`packages/plugin-shell/src/client/SendPayloadView.vue` renders a closed union —
`text`, `widget`, `attachment`, `connect-card`, `approval` — with first-party
components, and states the degradation rule in its header comment:

> Anything this client cannot draw — a payload shape newer than this bundle, or
> one the decoder refused — becomes a plain line saying so. A Turn's history has
> to render on a client older than the Bot that produced it.

And the parity register's row 57c records GrokBot's own choice: "A question
widget is a **send payload, not a tool**, and sending one ends the turn." The
system FrockBot is matching already decided that Bot-driven UI is described
data, not shipped code. Option B is the parity-aligned path, not a compromise
against it.

**Shape.** A `BotViewV1` DTO: a tree of nodes drawn from a closed set — stack,
text, field, button, table, badge, progress — each mapping to a component that
already exists or belongs in `@frockbot/client-ui` beside `UiButton`,
`UiField`, `UiMarkdown`, `UiSkeleton`.

**Actions are declared, not called.** A button carries an intent
(`{action: "tool", name, input}`), not a callback. The shell submits it through
the existing transport, and it runs under the Bot's existing Assignments. No
new authority path is created, which is precisely why no amendment is needed.

**Mounting reuses what exists.** `ClientMount { slot, order }` and
`ClientSurfaceRegistration` are already the vocabulary for where a Contribution
appears. A Package-authored view registers into a slot the shell offers, never
an arbitrary DOM position.

**"Updating the UI" becomes writing durable state.** The constitution already
says "The hosted client renders backend state and submits commands. It does not
become an alternate authority." So a Bot updates its UI by changing durable
state whose projection changes, and the view re-renders on the turn events the
client already consumes. That is not a restriction working around the design —
it is what makes a Package-authored view survive Durable Object eviction, client
disconnect and reload, and reconstruct from the event log, for free.

**The honest cost.** A fidelity ceiling. Every genuinely new visual affordance
is a first-party vocabulary addition and a client release, so a Package cannot
invent a novel interaction on its own. For a Bot that wants a settings panel, a
status readout, a form, or a table, that ceiling is nowhere near. For a Bot that
wants a diagram editor, it is a wall.

**What it buys.** The design system, theming, keyboard handling and
accessibility come out correct by construction. It works identically in the
browser, the Electron shell and the mobile webview, satisfying One production
path without a per-shell sandbox story. There is no second origin, no CSP work,
no bundler, and no Vue compiler on the server.

## Option C — a sandboxed cross-origin frame

Package UI runs in an iframe on a separate, content-addressed origin, speaking
a narrow postMessage protocol to the shell.

The appeal is that it maps onto the rule the constitution already has, almost
term for term: a separate origin is the browser's `globalOutbound: null`, the
postMessage message set is the bindings an Assignment grants, and an origin
keyed by artifact hash mirrors "an isolate's loader identity is derived only
from that artifact set and the digest of the bindings it was granted". It is
the escape hatch with no fidelity ceiling, and it is where every platform that
ships genuinely third-party UI ends up.

The costs are real and mostly presentational: sizing, theming, focus, keyboard
routing and z-index across a frame boundary; the design system has to be shipped
inside the frame or duplicated; a second origin to serve, secure and version;
mobile webview behaviour to prove separately.

And one structural point worth being clear about: **every capability the frame
needs becomes an explicit postMessage message type**. So Option C does not avoid
designing a vocabulary — it designs a lower-level one, and then still needs
components on top of it. The vocabulary work is not the part C saves.

## Recommendation

**Build B now. Declare C as the escape hatch, and build it when a real case
exceeds the vocabulary — not before.**

Four reasons, in the order they matter:

1. B needs no constitutional amendment, because no non-first-party code reaches
   the browser. C cannot start until the amendment is written and accepted. B
   ships while that conversation happens rather than waiting on it.
2. B is what the parity target does (row 57c), so it is the shorter path to
   parity, not a detour from it.
3. The vocabulary B requires is most of the postMessage protocol C would need.
   Doing B first is not throwaway work if C follows; doing C first still leaves
   the vocabulary to design.
4. C's cost is concentrated in presentation fidelity, which is exactly what a
   vocabulary handles worst. That argues for introducing C at the point of
   demonstrated need, where the fidelity gap is concrete and can be designed
   against, rather than speculatively.

The risk of being wrong is that B's ceiling is discovered to be much lower than
expected. That is cheap to detect: the first three Package-authored views will
say so, and C remains available.

## Sequencing

1. **`BotViewV1` and the renderer.** The DTO in `kernel-contracts`, decoded at
   its seam; a first-party renderer beside `SendPayloadView.vue` reusing its
   degradation rule verbatim; the node set kept deliberately small.
2. **The client Contribution host.** Implement the `client` kind against the
   existing `ContributionHost` `prepare`/`commit` seam, so a view mounts and
   unmounts on the same Composition lifecycle as everything else and a bad view
   fails closed like any other generation.
3. **Offer the host to authoring.** Extend `authoredManifestV1` to synthesize a
   view Contribution alongside the isolate runtime one — still synthesized, so
   the Bot declares what it wants drawn and never which host draws it.
4. **Actions.** Wire declared intents through the transport under existing
   Assignment authority, including the refusal path when the Assignment is
   absent.
5. **Rebuild one first-party surface on it.** The strongest proof the
   vocabulary is real is a first-party panel that stops being special-cased.
   The Usage & Billing panel from the spend plan is the natural candidate,
   which is where these two plans rejoin.
6. **Option C**, if and when a case demands it, behind the amendment.

## What this changes about spend tracking

Two things, both small.

The Usage & Billing panel becomes step 5 above rather than bespoke chrome, so
the spend plan's slice 1 should ship its numbers through whatever the renderer
is by then, or accept being the thing rebuilt in step 5.

And a Package-authored view is a spend surface in its own right: a button that
declares a tool intent can trigger a model call, so `MeterReadingV1` must carry
a view-initiated action's attribution as cleanly as a Turn-initiated one. The
`effectId` idempotency in that plan already covers the mechanics; it is the
attribution fields that need to name the originating view.
