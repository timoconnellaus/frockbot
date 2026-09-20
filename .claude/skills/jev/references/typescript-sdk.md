# TypeScript and JavaScript SDK

Snapshot: 2026-09-19, `@typesafe-ai/sdk` 0.6.0. Primary sources:
[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript),
[TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient),
[API reference](https://docs.typesafe.ai/sdk/javascript/api), and
[changelog](https://docs.typesafe.ai/sdk/javascript/changelog).

The package declares Node.js 20+, and ships ESM, CommonJS, and TypeScript
declarations. TypeSafe does not explicitly document Bun or Cloudflare Workers
compatibility; verify both runtimes before adopting it in FrockBot. Add the package
to the narrowest owning workspace, not automatically to the repository root.

```sh
bun add @typesafe-ai/sdk
```

## Basic typed call

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const questions = {
  route: choice("Which handler should receive `message`?", {
    deterministic: "A lookup or exact rule can answer it",
    specialist_model: "It needs generated language or multi-step reasoning",
    human: "It needs judgment or authority reserved for a person",
  }),
  sensitive: noul("Does `message` contain sensitive personal information?"),
  ambiguity: score("How ambiguous is `message`?", [
    "One clear interpretation",
    "Some uncertainty but a likely interpretation",
    "Several materially different interpretations",
  ] as const),
} as const;

const result = await client.systemOne({
  state: { message: "Please sort this out before payroll closes." },
  questions,
});

result.answers.route.choice;
result.answers.route.probabilities.human;
result.answers.sensitive.noul;
result.answers.ambiguity.score;
result.model;
result.usage.input_tokens;
```

Answer types are inferred from question names and criteria keys. Keep literal
criteria narrow (`as const` when useful) so TypeScript preserves label/level
types.

## Constructors and configuration

```ts
const client = new TypeSafeClient({
  apiKey: env.TYPESAFE_API_KEY,
  baseURL: "https://api.typesafe.ai",
  defaultModel: "jev-1.13.0",
  timeout: 10_000,
  logLevel: "warn",
  retry: { maxRetries: 2 },
  fetch: customFetch,
  defaultHeaders: { "x-service": "frockbot" },
});
```

Explicit options win over environment variables, which win over defaults.
Whitespace-only environment values are ignored.

| Option                    | Environment/default                                 | Notes                                             |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `apiKey`                  | `TYPESAFE_API_KEY`; required                        | Keep server-side.                                 |
| `baseURL`                 | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` | SDK strips trailing slashes.                      |
| `defaultModel`            | `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`         | Pin a version after calibrating thresholds.       |
| `timeout`                 | 10,000 ms                                           | Per attempt, not a total retry budget.            |
| `logLevel`                | `TYPESAFE_LOG_LEVEL`, then `warn`                   | `debug`, `info`, `warn`, `error`, `off`.          |
| `logger`                  | prefixed `console`                                  | Receives structured values.                       |
| `retry`                   | SDK defaults below                                  | Partial values inherit remaining defaults.        |
| `fetch`                   | global `fetch`                                      | Inject for tests or transport customization.      |
| `defaultHeaders`          | none                                                | Per-call headers override these.                  |
| `dangerouslyAllowBrowser` | `false`                                             | Never enable in FrockBot; it exposes the API key. |

At `info`, the SDK logs request summaries. At `debug`, it also logs headers and
bodies. Known credential headers are redacted, but bodies are not; do not enable
debug logging around sensitive FrockBot state without an explicit data-handling
decision.

Constructor failures include missing API key, invalid configuration, prohibited
browser use, missing `fetch`, and unsupported runtime configuration.

## Methods

```ts
client.systemOne(request, options?)
client.models.list(options?)
```

`systemOne` accepts:

```ts
interface SystemOneRequest<Q> {
  state: EntryType;
  questions: Q; // non-empty
  model?: string;
}
```

Per-call options:

```ts
interface RequestOptions {
  headers?: Record<string, string>;
  retry?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  timeout?: number;
}
```

`model` inherits the client's default. Per-call timeout is milliseconds per
attempt. `signal` cancels the active request and pending retries.

The returned `APIPromise<T>` behaves like a Promise and also supports:

- `.asResponse()` for the raw `Response` without parsing;
- `.withResponse()` for `{ data, response, requestId }`, where `requestId` comes
  from `x-typesafe-request-id`;
- `.map(...)`, `.then(...)`, `.catch(...)`, and `.finally(...)`.

`asResponse()` transfers raw body ownership to the caller; do not also expect the
SDK to parse that same consumed body. Use `.withResponse()` when correlating
service failures or support requests.

## Retry policy

Default policy in SDK 0.6.0:

| Field                | Default                           |
| -------------------- | --------------------------------- |
| `maxRetries`         | 2 after the initial attempt       |
| `httpStatuses`       | 408, 429, and 500–599             |
| `apiConnectionError` | true                              |
| `apiTimeoutError`    | true                              |
| `backoffInitialMs`   | 500                               |
| `backoffMaxMs`       | 5,000                             |
| `backoffJitter`      | 0.25 (random fraction subtracted) |
| `respectRetryAfter`  | true                              |
| `maxRetryAfterMs`    | 60,000                            |

Backoff doubles until capped. The SDK honors `Retry-After` and
`retry-after-ms` only up to the configured maximum; longer values fall back to
client backoff. Retried requests include `X-TypeSafe-Retry-Count`. Timeout is per
attempt, so worst-case wall time includes every attempt and delay. Own an
end-to-end `AbortSignal` when the surrounding operation has a deadline.

In FrockBot, align SDK retries with the owning durable operation. A transport
retry must retain the same logical effect identity and must not cause a second
billing admission or duplicate downstream side effect. Disable or narrow SDK
retries when an outer repository-owned retry policy already governs the call.

## Errors

All SDK errors derive from `TypeSafeError`. Relevant subclasses include:

- `APIError`: non-2xx response; carries `status`, parsed/raw `body`, `headers`,
  and optional `requestId`. `APIError.fromResponse(response)` constructs it.
- `BadRequestError` (400), `AuthenticationError` (401),
  `PermissionDeniedError` (403), `NotFoundError` (404),
  `UnprocessableEntityError` (422), `RateLimitError` (429), and
  `InternalServerError` (5xx).
- `APIConnectionError`: fetch/network failure or interrupted body.
- `APITimeoutError`: carries `timeoutMs`.
- `APIUserAbortError`: caller-provided signal aborted the request.

Import the concrete classes and branch with `instanceof`; preserve request ID and
retry-after metadata in the repository's normalized failure/logging boundary.
Do not convert every failure into “no” or a low score—service failure is not a
model judgment.

## SDK validation

Version 0.6.0 rejects an empty question map; rejects a Score whose criteria are
not an array or contain fewer than two entries; and its Choice helper rejects an
array as criteria. The service may impose additional validation and return 422.
Choice's documented maximum is 255 options, and Score documents 2–10 levels.

## Testing without network

Inject `fetch` or wrap `TypeSafeClient` behind a narrow interface owned by the
feature. Unit tests should assert:

- exact state and question shapes;
- output composition and thresholds;
- missing/ambiguous cases and service failures;
- cancellation/timeout propagation;
- retry ownership and stable effect identity;
- resolved model and usage are retained where the design requires them.

Example injected fetch:

```ts
const fetch: typeof globalThis.fetch = async (_input, init) => {
  const request = JSON.parse(String(init?.body));
  expect(request.questions.route.type).toBe("choice");
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        route: {
          type: "choice",
          choice: "human",
          probabilities: {
            deterministic: 0.05,
            specialist_model: 0.15,
            human: 0.8,
          },
          confidence: 0.76,
        },
      },
      usage: { input_tokens: 120, output_tokens: 8 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
```

Use live calls only for explicit evaluation work with an API key and a bounded
spend. Store question/threshold constants and labeled fixtures so results can be
reviewed without repeatedly spending API calls.

## Version note

SDK 0.6.0 changed `Score.criteria` from an integer-keyed dictionary to an ordered
sequence. Use arrays/tuples. If the installed package is newer than 0.6.0, inspect
its delivered declarations/changelog before assuming this snapshot's surface.
