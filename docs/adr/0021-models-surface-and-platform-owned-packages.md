---
status: proposed
amends: 0019-account-wide-enablement
---

# The Models Surface Owns Model Choice; Platform-Owned Packages Are Not User Controls

FrockBot will show one Models surface to every User: a provider, defaulting to FrockBot, and a model, defaulting to Auto. Choosing another provider, connecting it, and picking one of its models all happen on that surface, and picking a non-default provider is itself the opt-in. The separate act of switching on a "Custom models" Package before a model can be chosen is removed.

Alongside this, the constitution names a category it already relies on but never wrote down: platform-owned Packages. The application root, a Package that offers no User- or Bot-scoped control, and the Package that owns the platform's ambient model Connection are installed for every User, cannot be disabled or uninstalled, and are repaired to that state on every configuration read. They are not listed where Packages are enabled.

This amends [ADR 0019](0019-account-wide-enablement.md), which made model choice an opt-in Package, and the `AGENTS.md` Configuration shape rule that "choosing a model at all, at account or Bot level, is a Package a User switches on."

## What went wrong under the current rule

On 2026-09-03 the owner's account showed "Model unavailable" and could not enable Custom models (PRs #143 and #147, releases v0.2.3 and v0.2.5). Two of the three causes were structural rather than bugs:

- The platform's own model Package could be uninstalled, and its bootstrap ran once behind a marker. Once the row or the platform binding was gone, no read repaired it, so the zero-configuration promise silently stopped holding.
- The model-choice Package depended on the shell, the shell's installation row had been disabled by a migration, and the shell is not listed among enablement choices. Every Package depending on it was refused on Enable with nothing the User could act on. A dependency on something the User cannot see is a dead end by construction.

The remaining cause — a refusal rendered where the click could not see it — was ordinary and is fixed.

The gate itself was a control with no reason to exist. A User who wants Ollama has to (1) enable Custom models, (2) enable Ollama Cloud, (3) connect an Ollama account under Connectors, (4) pick the model under Models. Step 1 carries no information the other three do not, and steps 2–4 live on three surfaces for one decision.

## Considered options

- **Keep the gate, fix the bugs:** the self-healing bootstrap and platform-owned repair land (they have), Custom models stays a Package the User enables first. Rejected: the enable step remains a control with no choice behind it, the dependency edge from every provider Package to the model-choice Package remains, and the four-surface path stays.
- **Always-visible picker, keep Custom models as the durable home of the values:** the Models surface is always shown, but writes still land in the Custom models Package's `account-model` and per-Bot `model` settings, and choosing a non-default provider enables that Package implicitly. Rejected as the end state: it keeps a Package whose only remaining job is to hold two values, and "implicitly enabled" is the kind of hidden state this constitution avoids. Acceptable as the migration path (below).
- **Models surface owns the choice; provider selection installs and enables:** chosen. The account-level model binding is platform settings state. Choosing a provider installs and enables that provider's Package and its dependency closure as part of the same command; connecting it happens on the same surface; a Bot override stays a Bot setting that defaults to inherit.

## The decision

1. **One Models surface for every User.** It shows provider → (connection, only when the provider allows more than one) → model. The default reads FrockBot / Auto. "Auto" means the platform picks the model and may change it over time; pinning a specific FrockBot model is a distinct choice.
2. **Choosing is the opt-in.** Selecting a provider other than FrockBot installs and enables that provider's Package and its declared dependency closure in the same configuration command. No separate enable step exists for model choice.
3. **Connecting happens where choosing happens.** A provider that needs a credential is connected from the Models surface, using the same Connection flow the Connectors surface uses. Model-provider Connections are then no longer offered on Connectors: every control has exactly one home.
4. **A broken choice fails visibly and is repairable in place.** When the chosen provider stops resolving (credential revoked, Package disabled, model gone from the catalog), the Models surface shows the resolver's failure sentence and a one-click return to FrockBot / Auto. The platform never falls back silently: a User on Ollama must not be billed against FrockBot without knowing.
5. **Per-Bot override stays a Bot setting**, rendered with the same picker, defaulting to inherit. It exists because a Bot's task genuinely may need a different model; that is the stated reason ADR 0019's rule requires.
6. **Hand-typed models are allowed.** A model id the provider's catalog does not list (a local Ollama model, a model newer than the catalog) is selectable with a visible "not in the catalog" note; it resolves at the next Turn or fails visibly there.
7. **Platform-owned Packages are not controls.** The application root, any Package with no User- or Bot-scoped setting, Connection Type, or Capability, and the Package that owns the ambient model Connection are installed for every User, cannot be disabled or uninstalled, are repaired on every configuration read, and are not listed on the Plugins surface. The predicate is derived from manifest facts, never from Package ids.
8. **Subagent models stay separate.** The Subagents Package's model slugs name enabled provider bindings and remain on that Package's own surface; the Models surface does not merge them.

## Migration

- Existing `account-model` and per-Bot `model` values under the Custom models Package are read as the account and Bot choices; the first write through the new surface stores them in their new home and drops the Package's values. An account with no value reads as FrockBot / Auto.
- Provider Packages drop their dependency on `custom-models`. The Custom models Package is retired; its rows are dropped by the same catalog-relative migration that retires any Package absent from the Catalog.
- Ollama Cloud remains disabled by default; it becomes enabled the first time a User chooses it.

## Consequences

- One decision, one surface, one durable record — the same shape ADR 0019 chose for enablement, now applied to model choice.
- The "enable a Package to get a control" pattern in the constitution survives for configuration only some Users need. Model choice is not that: every User is on some model, and the control exists whether they change it or not. The rule is narrowed, not removed.
- The naming must be settled once: the platform provider is presented as "FrockBot" everywhere in the product, and the Flock AI Package name stays internal.
- Platform-owned repair on every read means the product recovers from any path that loses platform state, at the cost of a small pure computation per read and of the User never being able to switch the platform provider off. That is the intended trade: zero configuration is a promise the platform keeps, not one the User maintains.
- Hiding platform-owned Packages from Plugins means a dependency on one of them is always satisfiable, so the dead end that motivated this ADR cannot recur.

## Constitution amendment

Replace the Configuration shape rule

> The product works out of the box. The platform chooses the model a Bot runs on, and a User who has configured nothing has a working Bot. Choosing a model at all, at account or Bot level, is a Package a User switches on.

with

> The product works out of the box. The platform chooses the model a Bot runs on, and a User who has configured nothing has a working Bot. Model choice is a platform control on one Models surface: the default reads as the platform provider on Auto, choosing another provider is itself the opt-in and installs what that provider needs, and connecting a provider happens where it is chosen.

and add

> Platform-owned Packages — the application root, a Package that offers no User- or Bot-scoped control, and the Package that owns the platform's ambient model Connection — are installed for every User, cannot be disabled or uninstalled, are repaired on every configuration read, and are not offered where Packages are enabled. Which Packages are platform-owned is derived from manifest facts, never from a list of ids.
