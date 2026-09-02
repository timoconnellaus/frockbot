# @frockbot/plugin-provider-ollama-cloud

The Ollama model provider Package. It contributes:

- a **User backend Contribution** (`./user`) that owns the `ollama-cloud-account`
  Connection type: it admits `connection/*` commands durably, validates and
  stores the API key, discovers the account's model catalog, refreshes that
  catalog on a durable alarm, resolves models the catalog does not list, and
  leases the credential for a Turn;
- a **runtime Contribution** (`./runtime`) that registers the `ollama-cloud`
  provider behind the kernel's model interface, translating a normalized model
  request onto Ollama's OpenAI-compatible `/v1/chat/completions` endpoint;
- the **`web_search` tool** (`./web-search`), a second Capability over the same
  Connection.

## The `ollama-cloud-web-search` Capability

`POST /api/web_search` authenticates with the _same_ key as `/api/chat` — see
`docs/research/ollama-cloud-auth.md` — and a credential is openable only by the
Package that owns its Connection. So the search transport lives here, beside the
model provider, rather than in a Package that would have to be handed a key it
does not own. `plugin-composio` is the precedent for a Connection-backed tool
Capability.

The _contract_ is not provider-specific. `@frockbot/plugin-web/contract` owns the
`WebSearchV1` interface, the result DTO, its decoder and the `web_search` tool
definition; this Package supplies transport and the credential, and a second
search provider satisfies the same contract with no change here and none in the
kernel.

|                |                                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| Capability     | `ollama-cloud-web-search`, kind `tool`, `connectionTypes: ["ollama-cloud-account"]` |
| Endpoint       | `POST {apiBaseUrl}/api/web_search` — the same resolved root chat uses               |
| Input          | `query` 1–400 chars, `max_results` 1–10 (default 5)                                 |
| Response bound | 256 KiB, snippets trimmed to 1 000 characters                                       |
| Durable result | `{"query", "results":[{"title","url","snippet"}]}`                                  |
| Effect class   | read-only, `idempotent: true`                                                       |
| Turn types     | all four (manifest v4 `admission`)                                                  |

**Authority.** The tool mounts only while `ollama-cloud-web-search` is enabled
account-wide and resolves a ready Connection. There is no unauthenticated
fallback: without that capability the Bot is never offered the tool. The key
is leased per durable `effectId`, opened inside this Package, used
and settled, so it never reaches a tool argument, a tool result, or the event
log.

## The `api-base-url` Connection setting

A Connection is not pinned to `https://ollama.com`. Its User may point it at any
Ollama-compatible endpoint — a self-hosted gateway, a colleague's GPU box, or a
local Ollama server at `http://127.0.0.1:11434`.

The endpoint is a **Connection-scoped setting**: it belongs to one Connection,
not to the User or the Bot, so a User may hold a Cloud Connection and a local
Connection side by side and assign either to a Bot.

The manifest declares it in `configuration.settings` as `api-base-url` — the
kernel requires lowercase kebab-case Contribution ids — and it is carried on the
Connection settings bag under the key **`api-base-url`**:

```json
{
  "id": "api-base-url",
  "schemaVersion": 1,
  "scopes": ["connection"],
  "schema": { "type": "string", "minLength": 1, "maxLength": 2048 }
}
```

### Setting it

Supply it when the Connection is created, on the
`connection/create-api-key` command:

```jsonc
POST /api/connections
{
  "schemaVersion": 1,
  "type": "connection/create-api-key",
  "commandId": "<idempotency key>",
  "packageId": "provider-ollama-cloud",
  "connectionTypeId": "ollama-cloud-account",
  "label": "Workstation Ollama",
  "apiKey": "<key>",
  "settings": { "api-base-url": "http://127.0.0.1:11434" }
}
```

Omit `settings` entirely for Ollama Cloud. In the WebUI the same value is the
optional **API base URL** field on the Connect form; leaving it empty sends no
`settings` field at all.

The value is the **endpoint root**, with no `/api` or `/v1` path segment: the
Package appends `/api/...` for catalog and probe calls and `/v1` for chat
completions. It must be an absolute `http:` or `https:` URL carrying no
credentials, query, or fragment; a trailing slash is stripped. Anything else is
refused at the seam, and the command fails with a visible reason on the
Connection rather than silently falling back to the default.

Every provider call for a Connection uses that Connection's endpoint: the
creation catalog read, the key-validation probe, the periodic catalog refresh,
exact model resolution, and chat completions.

The setting is durable state on the Connection and is visible in
`GET /api/settings` under the Connection's `settings` bag.

### The key is still proven

Pointing a Connection elsewhere does not relax key validation. Measured against
`https://ollama.com` and recorded in `docs/research/ollama-cloud-auth.md`,
`GET /api/tags`, `GET /v1/models`, and `POST /api/show` all answer 200 for a
valid key, a garbage key, and no key at all — so no catalog read can validate a
key. `POST /api/chat` does authenticate. Creating or rotating a key therefore
runs a real one-token inference probe against **whatever endpoint the Connection
is configured with**, and a Connection whose endpoint rejects the key ends
`failed` with the provider's reason, never `ready`.
