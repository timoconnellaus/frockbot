# Ollama Cloud endpoint authentication matrix

## Status

Primary-source measurement of which `https://ollama.com` endpoints actually authenticate an API key, taken on **2026-08-31** against the live service with three request identities: a valid Ollama Cloud API key, a syntactically plausible but invalid key, and no `Authorization` header at all. No key material is recorded here.

This exists because `@frockbot/plugin-provider-ollama-cloud` validated a new or rotated key by listing models, and the model list turned out not to be authenticated: every key validated, the Connection reached `ready` with a full model catalog, and the User only discovered the key was bad when a Turn ended `model-error` in production.

## Measured matrix (2026-08-31, https://ollama.com)

| Endpoint               | Method | Valid key | Garbage key | No key |
| ---------------------- | ------ | --------- | ----------- | ------ |
| `/api/tags`            | GET    | 200       | 200         | 200    |
| `/v1/models`           | GET    | 200       | 200         | 200    |
| `/api/show`            | POST   | 200       | 200         | 200    |
| `/api/chat`            | POST   | 200       | 401         | 401    |
| `/v1/chat/completions` | POST   | 200       | 401         | 401    |
| `/api/web_search`      | POST   | 200       | 401         | 401    |
| `/api/ps`              | GET    | 401       | 401         | 401    |
| `/api/embed`           | POST   | 401       | 401         | 401    |

- The 401 body is `{"error":"Unauthorized"}`.
- `/api/ps` and `/api/embed` return 401 even for a valid key: they are not supported on Ollama Cloud, so they cannot be used as a probe either — a valid key would be reported as bad.
- The catalog endpoints are public. No amount of catalog reading distinguishes a valid key from an absent one.

## The probe

The cheapest call that genuinely authenticates is a one-token native chat completion:

```
POST https://ollama.com/api/chat
{"model":"gpt-oss:20b","messages":[{"role":"user","content":"hi"}],"stream":false,"options":{"num_predict":1}}
```

Measured result with a valid key: **200**, with `prompt_eval_count: 68`, `eval_count: 1`, `done_reason: "length"` — roughly 70 tokens of usage per probe. With a garbage key or no key: **401 `{"error":"Unauthorized"}`**.

## Model naming

Cloud model names returned by `/api/tags` are bare — `glm-5.1`, `gpt-oss:20b`, `glm-5.3-flash`, … — with no `:cloud` or `-cloud` suffix. `gpt-oss:20b` is the smallest routinely present model and is therefore the preferred probe target; the provider falls back to the first discovered model when it is absent.

## How FrockBot uses this

- `OllamaCloudClient.probeInference` (`packages/plugin-provider-ollama-cloud/src/client.ts`) issues exactly the request above. 401/403 becomes a definitive "key is not authorized for inference" failure carrying Ollama's own error text; any other non-2xx carries the status and the reported text. The assistant content is never parsed or retained.
- `validateAndActivate` (`packages/plugin-provider-ollama-cloud/src/user.ts`) validates a `connection/create-api-key` or `connection/rotate-api-key` with `listModels` (still needed for the catalog) **and** `probeInference`. A probe failure sets `validationStatus: "failed"` with the reason, which surfaces as the Connection's `failure` and as "Connection validation failed" in the client.
- The periodic model-catalog refresh (`connection/refresh-models`) is metadata only and does **not** probe: it must not spend inference on a schedule.
