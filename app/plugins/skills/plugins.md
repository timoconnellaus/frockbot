---
name: Build a Plugin
description: Use this whenever you are creating or changing a Plugin — code of your own that adds tools to this Bot, wraps steps of your own loop, keeps its own data, and reaches the network the User allowed. It is the reference for the Plugin SDK, the two files, the authoring tools, and the approval that makes a Plugin live.
---

# Build a Plugin

A Plugin is your own code, running inside the kernel beside you. It can offer
you tools, wrap your loop (change the tools you are offered, edit a model
request, look at a tool's result), keep a key-value store of its own for this
Bot, and — when the User has approved it — reach declared hosts on the
network. You write it in TypeScript with the `plugin_*` tools, check it,
publish it, and the User approves it in the conversation. Nothing you publish
runs until they do.

Two files are yours: `plugin.ts` (the module) and `plugin.json` (the
descriptor). Nothing else.

## The loop

1. **`plugin_list`** first. It shows every Plugin this User's Bots wrote and
   whether each one runs on this Bot. Extend one that exists rather than
   creating a second with the same purpose.
2. **`plugin_create`** with a display name. It makes the directory, writes a
   working starting point — two tools over the storage grant — and tells you
   the Plugin's id. The id is what every other tool takes.
3. **`plugin_files`** and **`plugin_read_file`** to see what is there, then
   **`plugin_write_file`** to change it. A write replaces the whole file, so
   read before you write. Keep `plugin.json` and `plugin.ts` in step: every
   tool the module exports is named in the descriptor, and every grant the
   module uses is declared there.
4. **`plugin_check`** with the Plugin's id. It type-checks the module against
   the SDK and answers with every problem as `path:line:col message`, or with
   "builds". Fix every line. Do not publish over a failing check.
5. **`plugin_publish`** with the Plugin's id. It builds the module, runs it
   once to read what it exports, compares that with `plugin.json`, stores the
   artifact, and asks the User to approve it with a card in the conversation
   that lists its hooks, hosts and grants. Say in your own words what the
   Plugin does and why you built it, then end your Turn: the decision arrives
   as durable input on a later Turn, and the Plugin is live on this Bot from
   the Turn after the User approves it — never the one in flight.

`plugin_enable` asks the same approval for a Plugin that exists but does not
run on this Bot. `plugin_disable` turns one off for this Bot at once, no
approval needed — narrowing what you can do is always yours to decide.
`plugin_settings` reads or writes the values a Plugin's `settingsSchema`
declares, for this Bot.

## `plugin.ts`

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
  `undefined` to leave it alone. The events and what each may replace:

  | Event                    | Replace               |
  | ------------------------ | --------------------- |
  | `system-prompt/assemble` | `payload.assembly`    |
  | `agent/tool-exposure`    | `payload.tools`       |
  | `agent/request`          | `payload.request`     |
  | `tools/pre-execute`      | `payload.preparation` |
  | `tools/post-execute`     | `payload.result`      |
  | `agent/turn-stopping`    | nothing — a notice    |

- `ctx` names the User, the Bot and the Session, and one member per grant
  the descriptor declares: `ctx.storage` (`storage`), `ctx.connection`
  (`http`), `ctx.schedule` (`schedule`), `ctx.model` (`ai`), `ctx.memory`
  (`memory`), `ctx.workspace` (`workspace`). A grant you did not declare is
  simply absent. `ctx.settings.read()` and `ctx.capabilities.list()` are
  always there. Every call answers `{ status: "unavailable", reason }` rather
  than throwing when the authority refuses it.
- `ctx.deadlineMs` is how long the call may run. A hook that overruns is
  skipped for the Turn; three failures in a row take the Plugin out of this
  Bot until a person turns it back on.
- Network: with the `http` grant, `fetch` reaches only the hosts
  `plugin.json` declares. Every other host is refused at the edge.

## `plugin.json`

```json
{
  "id": "notes",
  "displayName": "Notes",
  "version": "1",
  "contractVersion": 4,
  "tools": [
    {
      "name": "note_add",
      "description": "Keep one short note.",
      "inputSchema": { "type": "object" }
    }
  ],
  "hooks": ["agent/tool-exposure"],
  "grants": ["storage"],
  "contextKeys": ["user", "bot", "session"]
}
```

- `id` is the Plugin's id, exactly as `plugin_create` named it.
- `version` is a string you bump when you publish a change. A publish with
  the version already live is still a new generation — the User approves the
  code, not the number — but bumping it is how you both tell versions apart.
- `tools` and `hooks` must match the module's exports, name for name. A
  mismatch is refused at publish with both lists.
- `grants` is what the module may use, from `storage`, `http`, `schedule`,
  `ai`, `memory`, `workspace`. With `http`, add `"network": { "hosts": ["api.example.com"] }`
  (a leading `*.` matches one subdomain label), or `"network": { "open": true }`
  for the whole network — the card says plainly that open network means every
  Plugin on this account, so declare hosts unless you truly cannot.
- `settingsSchema` (optional) is a JSON Schema for per-Bot values the User
  can set; read them with `ctx.settings.read()`. Never put a secret in it.
- `provides` / `consumes` (optional) name services by `{ "name", "version" }`
  for Plugins that share values with each other through `export const services`.
- `contextKeys` is always all three.

## What you cannot do

You cannot make a Plugin run on this Bot by yourself: publishing and enabling
both end in a card the User answers, because a Plugin widens what you are
allowed to do and "self-modification never widens your own authority". You
cannot reach a host you did not declare, read another Plugin's store, or call
a model other than this Bot's. A Plugin you delete from the source tree is
still in the User's history; nothing published is ever lost.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have work to do, and disposition:"finish" on the send that ends your
reply.
