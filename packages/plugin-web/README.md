# @frockbot/plugin-web

The Web Package. It contributes one runtime Contribution (`./agent`) carrying
one tool, **`web_fetch`**, and one provider-neutral contract (`./contract`) that
a search provider Package implements.

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

`web_fetch` needs no Connection: reading a public page needs no credential. An
installed and enabled Web Package contributes it directly to the Bot's current
Composition.

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

## `./contract` — `WebSearchV1`

The `web_search` tool definition, its bounds, its DTO and its decoder live here
so that a provider Package contributes the tool by supplying transport alone.
`@frockbot/plugin-provider-ollama-cloud` is the first implementation
(`POST {apiBaseUrl}/api/web_search`); this Package holds no transport and
depends on no provider.
