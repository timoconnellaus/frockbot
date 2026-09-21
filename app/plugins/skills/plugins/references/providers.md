# Model providers

A Plugin may serve a model provider (the protocol a Bot's model selection
names). That is a **claim**, not a grant, and not the `ai` grant.

`ctx.model.invoke` spends the Bot's own configured model. `modelProviders`
_is_ a configured model, for Bots that selected this provider.

## What you may declare

`plugin.json`:

```json
"modelProviders": [{ "id": "deepseek", "protocolVersion": 1 }],
"tools": [],
"hooks": [],
"grants": []
```

- `id` is the provider type a model binding names, `^[a-z][a-z0-9-]{0,63}$`.
- `protocolVersion` is `1` — the only version this deployment serves.
- At most 4 providers. The export `modelProviders` in `plugin.ts` must use
  the same ids.

You may only claim a provider this **deployment's provider catalog**
opens to **this Plugin id**, at the content hash it compiled. A Bot-written
Plugin that names a provider the catalog reserved for another artifact
fails to mount. Do not invent an endpoint, a route, or a credential
scheme: the host attaches those server-side. Selecting the provider is
what runs this contribution; this Plugin's tools and hooks still need
the Bot's own switch.

If the catalog does not open any provider to your id, omit
`modelProviders`. Point the User at **Models** / Marketplace to install
a provider Package this account does not have; you cannot install it.

## The module

```ts
import type {
  PluginModelContext,
  PluginModelProvider,
  PluginModelRequest,
  PluginModelStreamEvent,
  PluginTool,
  ToolResult,
} from "@frockbot/applet-sdk/plugin";

export const tools: PluginTool[] = [];
export const execute = (): ToolResult =>
  "This Plugin serves a model; it has no tools.";

export const modelProviders: Record<string, PluginModelProvider> = {
  deepseek: {
    async *stream(
      request: PluginModelRequest,
      ctx: PluginModelContext,
    ): AsyncIterable<PluginModelStreamEvent> {
      const outcome = await ctx.modelTransport({
        body: JSON.stringify({
          model: request.model,
          messages: [
            { role: "system", content: request.system },
            ...request.messages,
          ],
          stream: true,
        }),
      });
      if (outcome.status !== "streaming") {
        yield {
          type: "provider-failure",
          classification:
            outcome.status === "refused" ? "transient" : "unknown",
          reason: outcome.reason,
        };
        return;
      }
      // Decode the provider's bytes into normalized events. Yield
      // text-delta, tool-call, usage, progress, then one finish.
      yield { type: "finish", reason: "completed" };
    },
  },
};
```

Rules:

- The kernel hands a **normalized** request (`requestId`, `provider`,
  `model`, `system`, `messages`, `tools`, optional `responseFormat`).
- You answer with **normalized** stream events only: `provider-state`,
  `text-delta`, `progress`, `tool-call`, `usage`,
  `response-format-note`, `structured-output-failure`, `finish`
  (`completed` | `tool-calls` | `max-tokens`), or `provider-failure`
  (`transient` | `permanent` | `unknown`, plus `reason`).
- `ctx.modelTransport` may be called **once per attempt**. It sends to
  the one endpoint and inference route the catalog compiled in, with the
  Connection's secret attached server-side. You never see the secret,
  cannot name a Connection or a destination, and cannot follow a
  redirect. Pass `{ body }` as the upstream should receive it.
- A frame you cannot read, a stream that ends before a terminal, a tool
  call without an id or a name, or arguments that are not JSON are
  `provider-failure`, not a plausible-looking reply.
- `ctx.modelTransport` is present only while serving this contribution.
  A tool call's `ctx` has none.

A provider Plugin still exports `tools` and `execute` (they may be
empty / a one-line refusal). Leave `grants` empty unless the module
actually uses a handle.
