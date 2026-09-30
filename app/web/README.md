# @frockbot/app/web

The Web Package. It contributes two tools — **`web_fetch`** (`./agent`) and
**`web_search`** (`./search`) — each behind its own Capability, and the
provider-neutral search contract (`./contract`) that every search provider
implements.
Both need no Connection and one per-Bot switch covers both: the Web row on a
Bot's Plugins page.

Row 47 of the parity register (`docs/research/grokbot-computer.md`) names web
search, web fetch and image generation as first-class tools, but cites a section
that is not in the register: **no input schema, bound, or error shape was ever
measured** for any of them. Everything here is FrockBot's own contract, defined
from first principles. No schema parity is claimed.

## `web_fetch`

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| Capability     | `web-fetch`, kind `tool`, `connectionTypes: []`                        |
| Input          | `url`, `max_bytes` ≤ 1 MiB, `format: "text" \| "markdown"`             |
| Durable result | `{"url","finalUrl","status","contentType","bytes","truncated","text"}` |
| Refusal        | `isError: true` with a stable reason code                              |
| Effect class   | read-only, `idempotent: true`                                          |
| Turn types     | all four (manifest v4 `admission`)                                     |

`web_fetch` needs no Connection: reading a public page needs no credential. The
Account-wide Package enablement is the fence — the Contribution mounts nothing
unless `web-fetch` is in the User's enabled capability set.

It is a plain outbound request, so it works while the User's Computer is
hibernated and never wakes it. A page that needs a real browser is the
Computer's job, not this tool's.

## The outbound trust boundary

The Bot's Durable Object can reach anything workerd can reach. `./ssrf.ts` is a
pure classifier — a string in, a verdict out — and it runs before every hop and
again on every redirect target:

1. `https:` only. No `http:`, `data:`, `file:`, `blob:`, `ftp:`.
2. The default port, or `443` stated explicitly.
3. No `localhost`, `*.localhost`, `*.internal`, or bare label with no dot.
4. No IP literal outside the public ranges. Literals are **normalized first**,
   so `0177.0.0.1`, `2130706433`, `0x7f000001`, `127.1` and `::ffff:127.0.0.1`
   are the same refusal as `127.0.0.1`. `169.254.169.254` — the cloud metadata
   address — is inside `169.254.0.0/16`.
5. No credentials in the URL. A fixed `User-Agent` and `Accept`; no `Cookie`,
   no `Authorization`, and no header the model chose.
6. `redirect: "manual"`, at most three hops, rules 1–5 re-run on each one.
7. The response must declare a media type on the allow list (`text/html`,
   `text/plain`, `text/markdown`, `application/json`,
   `application/xhtml+xml`), and a declared length over `max_bytes` is refused
   outright; the body is then read under a streaming cap and reports
   `truncated` when it was cut short.
8. A refusal carries a stable reason code — `ssrf-blocked-private-address`,
   `web-fetch-blocked-content-type`, … — and **never names what a host resolved
   to**.

### Known limitation: DNS rebinding

workerd exposes no resolve-then-connect hook, so a hostname cannot be pinned to
the address the request will actually reach. A name that resolves to a public
address at classification time and to `127.0.0.1` at connection time defeats
every rule above. Classification is therefore exact for IP literals and for the
known-internal name shapes, and best-effort for everything else. Closing the gap
needs a platform primitive FrockBot does not have; it is recorded here rather
than papered over.

## `web_search`

|                |                                                                           |
| -------------- | ------------------------------------------------------------------------- |
| Capability     | `web-search`, kind `tool`, `connectionTypes: []`                          |
| Provider       | the account's choice: FrockBot's Brave (default), or one it brings        |
| Input          | `query` 1–400 chars, `max_results` 1–10 (default 5)                       |
| Response bound | 256 KiB, snippets trimmed to 1 000 characters                             |
| Durable result | `{"query", "results":[{"title","url","snippet"}]}`                        |
| Refusal        | `isError: true`, `{"error":"web-search-failed","query","message"}`        |
| Cost           | US$0.01 per search on FrockBot's Brave only, keyed by the search's effect |
| Effect class   | read-only, `idempotent: true`                                             |
| Turn types     | all four (manifest v4 `admission`)                                        |

### Providers

| Choice     | Transport                                                               | Secret                                  |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `frockbot` | Brave, `GET https://api.search.brave.com/res/v1/web/search` (`./brave`) | the deployment's `BRAVE_SEARCH_API_KEY` |
| `brave`    | the same, on the person's key                                           | `X-Subscription-Token`                  |
| `exa`      | `POST https://api.exa.ai/search` (`./account-providers`)                | `x-api-key`                             |
| `tavily`   | `POST https://api.tavily.com/search`                                    | `Authorization: Bearer`                 |
| `searxng`  | `GET <instance>/search?format=json`                                     | the instance's address                  |

FrockBot's search needs nothing set up. The deployment's key is read
server-side when a Turn mounts; a deployment without it mounts no `web_search`
for an account on FrockBot's search — the model is never offered a search it
cannot run — and `web_fetch` is unaffected. Brave is asked for web results only,
as plain text (`result_filter=web`, `text_decorations=false`).

A person may bring their own (`GET`/`PUT /api/web-search`, `{"provider":"exa","apiKey":"…"}`,
`{"provider":"searxng","url":"https://…"}` or `{"provider":"frockbot"}`). The
User Durable Object seals the key or address as a credential generation, as
it does a model API key, and keeps only which provider it is for
(`./search-choice-user`). The Turn mounts with that choice and its generation;
each search leases the secret under its own effect id, opens it in the Bot's
Durable Object for the one request, and settles the lease after. A choice
changed mid-Turn refuses rather than handing one provider's key to another,
and takes effect from the next Turn. A SearXNG address passes the same public
internet rules as `web_fetch` except the port, when saved and again on every
search, and a redirect is a failure; the instance must list `json` under
`search.formats`, and a 403 says so.

There is no fallback. When the person's provider refuses, fails or runs out,
the tool returns that error — "Your Exa search …" — and FrockBot's Brave is
never asked. Every answer is decoded into the contract's shape at the seam:
nothing else a provider sends reaches the model.

Where the deployment bills, one search on FrockBot's Brave reserves its price
under `search:<effect id>` before the request goes out
(`@frockbot/app/billing/search`). An answer charges it, a refusal releases it,
and a request with no answer at all stays reserved for reconciliation.
Recovery re-runs an idempotent tool, so the key is what keeps a re-run from
being billed twice. A personal provider is never metered, and a re-run takes a
fresh lease under the same effect, clearing whatever the evicted attempt held.

## `./contract` — `WebSearchV1`

The `web_search` tool definition, its bounds, its DTO and its decoder live here
so that a search provider contributes the tool by supplying transport alone.
`./brave` and `./account-providers` are the implementations; the contract
imports no transport and names no provider.
