# `plugin.ts`

```ts
import type {
  PluginExecute,
  PluginHooks,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

export const tools: PluginTool[] = [
  {
    name: "note_count",
    description: "How many notes this Plugin has kept for this Bot.",
    inputSchema: { type: "object", properties: {} },
    idempotent: true,
  },
  {
    name: "note_add",
    description: "Keep one short note for this Bot.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

export const execute: PluginExecute = async (tool, input, ctx) => {
  if (tool !== "note_add" && tool !== "note_count") {
    throw new Error(`unknown tool ${tool}`);
  }
  const stored = await ctx.storage?.get({ key: "notes" });
  const notes =
    stored?.status === "available" && Array.isArray(stored.value)
      ? stored.value
      : [];
  if (tool === "note_count") return `${notes.length} note(s).`;
  const text = String((input as { text?: unknown })?.text ?? "");
  await ctx.storage?.put({ key: "notes", value: [...notes, text] });
  return `Kept it. ${notes.length + 1} note(s) now.`;
};

export const hooks: PluginHooks = {
  "agent/tool-exposure": (payload) =>
    payload.tools.filter((tool) => tool.name !== "image_generate"),
};
```

- The module has no default export and no imports of its own except
  `import type … from "@frockbot/applet-sdk/plugin"`. A value import fails the
  build; the module is one file and the bundler inlines nothing from outside.
- `tools` is an array of at most 64. It may be empty when the Plugin's
  surface is only hooks, a card, a trigger, a view or a model provider. A
  name is `^[a-z][a-z0-9_]{0,63}$` and the description is what a model reads
  before calling it, so write it for a model.
- `idempotent: true` on a tool means a retry under the same input is
  harmless. Default is false. Put it on the module's `PluginTool`, not in
  `plugin.json` — the descriptor's tools are only `name`, `description` and
  `inputSchema`.
- `admission` (optional, module only) narrows which Turn types may call the
  tool. Absent means every Turn type. Subagent roles can narrow it further.
- `execute(tool, input, ctx)` answers with a string, which the calling Bot
  reads as it is. Throw to answer with an error — a thrown `Error`'s message
  is what the Bot sees. Anything else you return is JSON-serialized. A
  provider-only Plugin still exports `execute`; it can answer that it has no
  tools.
- Optional named exports, each matching `plugin.json` name for name:
  - `hooks` — one function per loop event. See `hooks.md`.
  - `services` — values other Plugins that consume the same name receive.
    See `services.md`.
  - `triggers` — inbound deliveries. See `triggers.md`.
  - `views` — `settings.sections` on this Plugin's card. See `sections.md`.
  - `cards` — `render` plus `actions`. See `cards.md`.
  - `modelProviders` — one `stream` per provider id. See `providers.md`.
