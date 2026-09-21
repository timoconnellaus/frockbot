# `plugin.ts`

```ts
import type {
  PluginExecute,
  PluginHooks,
  PluginTool,
} from "@frockbot/applet-sdk/plugin";

export const tools: PluginTool[] = [
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
  if (tool !== "note_add") throw new Error(`unknown tool ${tool}`);
  const text = String((input as { text?: unknown })?.text ?? "");
  const stored = await ctx.storage?.get({ key: "notes" });
  const notes =
    stored?.status === "available" && Array.isArray(stored.value)
      ? stored.value
      : [];
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
- `tools` is a non-empty array. A name is `^[a-z][a-z0-9_]{0,63}$` and the
  description is what a model reads before calling it, so write it for a model.
- `execute(tool, input, ctx)` answers with a string, which the calling Bot
  reads as it is. Throw to answer with an error — a thrown `Error`'s message
  is what the Bot sees. Anything else you return is JSON-serialized.
- `hooks` is optional: one function per loop event you wrap. Each receives
  the event's payload and returns the _whole_ replacement value, or
  `undefined` to leave it alone. See `hooks.md`.
