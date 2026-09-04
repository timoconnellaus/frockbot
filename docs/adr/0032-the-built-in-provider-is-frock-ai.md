---
status: accepted
---

# The Built-In Provider Is Frock AI

The platform's built-in model provider is named **Frock AI**, after the product.
It was called Flock AI, which was a mistake: the Flock is the Bots — a flock of
sheep — and the provider is not part of it. Every name a person can read now
says Frock AI, and the model ids it mints are `@frock/auto`,
`@frock/deepseek-ai/...` and the rest of the manual catalog.

## What moved and what did not

Three kinds of name were tangled together, and only two of them moved.

**Names people read, and names in code, moved.** The display name, the composer
line, the settings copy, the docs, the package directory
(`packages/plugin-provider-frock-ai`), the types (`FrockAi*`), the file names
(`frock-ai.ts`), and the model-id prefix are all Frock now.

**Names already written into a User's durable state did not.** The Package id
`provider-flock-ai`, the Connection type `flock-ai-account`, the model
capability `flock-ai-models`, the ambient Connection `flock-ai-ambient` and its
generation, the provider type `flock-ai`, and the bootstrap storage keys are
stored identifiers, not labels. Every existing User has them in their settings
record and their Connection; renaming one is a data migration, and a data
migration buys nothing here because no person ever sees these strings.

**Names of Cloudflare resources did not.** The AI Gateway is still `flock`, its
dynamic route is still `flock-auto`, and the deployed end-to-end stand-in
Worker is still `frockbot-flock-ai-e2e`. Those values name resources in the
Cloudflare dashboard; the repo cannot rename them, so it records what they are
and says so where they appear.

## The model-id alias

Model ids are the one identifier that is both stored and shown, so they had to
move — and Bots created before the rename have `@flock/auto` written into their
model binding.

A stored `@flock/…` id is read as the `@frock/…` id it has always meant.
`decodeModelBindingV1` in `@frockbot/configuration-core` performs that
translation, and it is the only place that does: every model binding crosses
that decoder on its way out of storage, so binding resolution, catalog lookup,
the composer's model line, and the provider's gateway request all see one
spelling. `@frockbot/plugin-provider-frock-ai/catalog` accepts the legacy prefix
too (`normalizeFrockModelIdV1`), so a request that reaches it by another path
still resolves. Nothing writes `@flock/` back, and the catalog offers only
`@frock/` ids, so the alias drains as Bots are re-bound.

The alternative — migrating every stored binding — was rejected. It needs a
write pass over every User's Durable Object to change a string that already has
an unambiguous meaning, and a read-side alias costs one comparison.

## Environment variables

`FROCK_AI_GATEWAY_ID`, `FROCK_AI_AUTO_ROUTE`, `FROCK_AI_ACCOUNT_ID` and
`FROCK_AI_GATEWAY_TOKEN` are the names in code, `wrangler.jsonc`, CI, and the
docs. Each falls back to its `FLOCK_AI_*` twin, because the vars ship with the
repo but the secrets do not: they live in Cloudflare, in GitHub repository
secrets, and in each developer's gitignored `.dev.vars`. Without the fallback
the rename would take Frock AI Auto down in production between merging and
re-adding the secrets. The fallback is temporary and should be deleted once
every environment names them `FROCK_AI_*`.

## Consequences

- [ADR 0025](0025-frock-ai-reaches-the-gateway-over-http.md) describes the same
  provider and now reads Frock AI throughout; its decision is unchanged.
- The following still carry the old name and are Tim's to rename, outside the
  repo: the Cloudflare AI Gateway `flock`, its dynamic route `flock-auto`, the
  deployed Worker `frockbot-flock-ai-e2e`, the Cloudflare Worker secret
  `FLOCK_AI_GATEWAY_TOKEN` (on both the production and e2e environments), and
  the GitHub repository secret `FLOCK_AI_GATEWAY_TOKEN`. Renaming a Cloudflare
  resource means updating the matching value in `wrangler.jsonc`; renaming a
  secret means adding it under the new name, after which the `FLOCK_AI_*`
  fallback and the workflow's `||` expression can go.
