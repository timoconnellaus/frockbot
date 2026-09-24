# @frockbot/app/web

The Web Package. It contributes two tools — **`web_fetch`** (`./agent`) and
**`web_search`** (`./brave`) — each behind its own Capability, and the
provider-neutral search contract (`./contract`) that Brave Search implements.
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

|                |                                                                             |
| -------------- | --------------------------------------------------------------------------- |
| Capability     | `web-search`, kind `tool`, `connectionTypes: []`                            |
| Provider       | Brave Search, `GET https://api.search.brave.com/res/v1/web/search`          |
| Key            | the deployment's `BRAVE_SEARCH_API_KEY`, sent as `X-Subscription-Token`     |
| Input          | `query` 1–400 chars, `max_results` 1–10 (default 5)                         |
| Response bound | 256 KiB, snippets trimmed to 1 000 characters                               |
| Durable result | `{"query", "results":[{"title","url","snippet"}]}`                          |
| Refusal        | `isError: true`, `{"error":"web-search-failed","query","message"}`          |
| Cost           | US$0.01 per search where the deployment bills, keyed by the search's effect |
| Effect class   | read-only, `idempotent: true`                                               |
| Turn types     | all four (manifest v4 `admission`)                                          |

Search is the platform's, so a User sets nothing up. The key is read
server-side when a Turn mounts and never reaches a tool argument, a tool
result, or the event log. A deployment without it mounts no `web_search` at all
— the model is never offered a search it cannot run — and `web_fetch` is
unaffected. Brave is asked for web results only, as plain text
(`result_filter=web`, `text_decorations=false`), and its answer is decoded into
the contract's shape at the seam: nothing else Brave sends reaches the model.

Where the deployment bills, one search's price is reserved under
`search:<effect id>` before the request goes out (`@frockbot/app/billing/search`).
An answer charges it, a refusal releases it, and a request with no answer at
all stays reserved for reconciliation. Recovery re-runs an idempotent tool, so
the key is what keeps a re-run from being billed twice.

## `./contract` — `WebSearchV1`

The `web_search` tool definition, its bounds, its DTO and its decoder live here
so that a search provider contributes the tool by supplying transport alone.
`./brave` is the implementation; the contract imports no transport and names
no provider.
