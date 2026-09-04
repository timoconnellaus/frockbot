---
status: proposed
---

# Frock AI Reaches the AI Gateway Over HTTP, Not Through the `AI` Binding

Frock AI will send chat completions to Cloudflare AI Gateway's `compat/chat/completions` endpoint over `fetch`, authorized by a `cf-aig-authorization` bearer held as a Worker secret. The `AI` binding's `gateway(...).run()` remains as the fallback transport wherever that account id and token are absent.

## Why the binding stopped working

The platform default model is `@frock/auto`, which [ADR 0021](0021-models-surface-and-platform-owned-packages.md)'s Models surface resolves to the AI Gateway dynamic route `dynamic/<FROCK_AI_AUTO_ROUTE>`, so the target model is chosen in the Gateway dashboard rather than in code. Every Turn on a default Bot takes that path.

The `AI` binding's `gateway(id).run({ provider: "compat", ... })` does not reach the compat endpoint. It reaches the Gateway's _universal_ endpoint, whose request-shape translation rejects a `dynamic/<route>` model before inference runs, with `AiError` internal code 5006 naming a missing `/audio` object and a crash reading `parallel_tool_calls`. This is [cloudflare/ai#617](https://github.com/cloudflare/ai/issues/617), an upstream defect, and Cloudflare's own dynamic-routing documentation states that dynamic routes are available only on the compat endpoint.

Measured against the production account, the split is clean. Through the binding, `dynamic/flock-auto` fails identically with tools, without tools, and without streaming, while a concrete `workers-ai/@cf/...` id succeeds with the same bodies. A route name that does not exist fails differently, which proves the configured route resolves and forwards. The request body FrockBot builds is four fields and touches nothing the error names.

## Considered options

- **Retarget the dynamic route:** rejected, because the route is correct. It targets the intended model, and the failure is in translation before any model is consulted.
- **Resolve Auto to a concrete model id in code:** the binding accepts `workers-ai/@cf/...` today, so Auto could compile to one. Rejected: it moves the platform model choice out of the Gateway dashboard and into a deploy, which is the property the Models surface exists to avoid.
- **Wait for the upstream fix:** rejected as the only action. It leaves every default Bot unable to complete a Turn for an unbounded period, and the workaround is small and reversible.
- **Send to `compat/chat/completions` over HTTP:** chosen. It is the transport Cloudflare documents for dynamic routes, and it keeps the model choice in the dashboard.

## Consequences

- Frock AI is no longer credential-free at the deployment seam. `FROCK_AI_ACCOUNT_ID` is a var and `FROCK_AI_GATEWAY_TOKEN` is a Worker secret, provisioned like `SPRITES_TOKEN` and `COMPUTER_HOST_TOKEN`. The property that matters is unchanged and restated in the README: no account id, API token, or User secret enters _FrockBot state_, and no User supplies a credential to use the platform model.
- The token is optional, and its absence is a working configuration rather than a boot failure. Without it the host falls back to the binding, which still serves manual `@frock/...` ids and fails Auto. Every local, unit, integration, and browser end-to-end environment binds a stand-in for `AI` and sets no token, so all of them keep the fallback and none of them acquire a Cloudflare credential.
- A deploy that forgets the secret degrades rather than breaks: manual models keep working and Auto fails visibly at the Turn. `--secrets-file` replaces the Worker's whole secret set, so the release workflow carries the token in its optional list or a deploy would delete it.
- The Gateway must have authentication enabled for the token to be meaningful. An unauthenticated Gateway rejects the compat endpoint outright, which is what made this failure reachable only in production.
- The fallback is deliberate dead weight once the upstream defect is fixed. When `dynamic/` survives the universal endpoint, the compat transport and its two settings can be deleted and Frock AI returns to the binding unchanged.

## Addendum, 2026-09-04: the provider is Frock AI

This ADR was written when the provider was called Flock AI. The name was a
mistake — the Flock is the Bots — and it is Frock AI now, along with the model
ids (`@frock/…`) and the settings above (`FROCK_AI_*`). The decision here is
unchanged; only the names in it moved. [ADR 0032](0032-the-built-in-provider-is-frock-ai.md)
records the rename, the read-side alias for stored `@flock/…` model bindings,
and the Cloudflare resources that still read `flock`.
