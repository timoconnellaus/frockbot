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
- `ctx.model.invoke(...)` (the `ai` grant) calls the Bot's own model at the
  Bot's rates. Each call is itemised under your Plugin's name on the Turn's
  Work view, tokens and cost, so a User can see what it spent.
- `ctx.deadlineMs` is how long the call may run. A hook that overruns is
  skipped for the Turn; three failures in a row take the Plugin out of this
  Bot until a person turns it back on.
- Network: with the `http` grant, `fetch` reaches only the hosts
  `plugin.json` declares. Every other host is refused at the edge. The same
  grant gives you `ctx.email(...)`, which asks this deployment's own sender to
  send one plain-text message for this Bot — you hold no credential and name no
  provider, and a deployment that has bound no sender answers unavailable.

## `plugin.json`

```json
{
  "id": "notes",
  "displayName": "Notes",
  "version": "1",
  "contractVersion": 5,
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
- `tools`, `hooks`, `triggers`, `views` and `cards` must match the module's
  exports, name for name. A mismatch is refused at publish with both lists.
- `grants` is what the module may use, from `storage`, `http`, `schedule`,
  `ai`, `memory`, `workspace`. With `http`, add `"network": { "hosts": ["api.example.com"] }`
  (a leading `*.` matches one subdomain label), or `"network": { "open": true }`
  for the whole network — the card says plainly that open network means every
  Plugin on this account, so declare hosts unless you truly cannot.
- `settingsSchema` (optional) is a JSON Schema for per-Bot values the User
  can set; read them with `ctx.settings.read()`. Never put a secret in it.
- `provides` / `consumes` (optional) name services by `{ "name", "version" }`
  for Plugins that share values with each other through `export const services`.
- `triggers` (optional) name `{ "name", "description" }`, one per function
  `export const triggers` holds, and must match it name for name the way
  `tools` and `hooks` do. See [Triggers](#triggers).
- `contextKeys` is always all three.

## Triggers

A Plugin can receive deliveries from outside — a webhook from another
service — and decide what a Routine runs on. Export `triggers`, one function
per trigger name, and declare each one's name and description in
`plugin.json`:

```ts
import type { PluginTriggers } from "@frockbot/applet-sdk/plugin";

export const triggers: PluginTriggers = {
  alert: async (delivery, ctx) => {
    const event = JSON.parse(delivery.body);
    if (event.severity !== "severe") return { drop: true, reason: "minor" };
    return `Severe weather alert for ${event.city}: ${event.headline}`;
  },
};
```

`delivery` is `{ headers, body }`, headers lower-cased and without the door's
own credential. Return a string and a Routine fires with that text as its
delivered payload; return `{ drop: true, reason }` (or nothing) and it does
not. Then create the Routine with `routine_manage`:

```json
{
  "action": "create",
  "name": "Weather alerts",
  "prompt": "Tell the User what the alert means.",
  "pluginTrigger": { "pluginId": "weather", "trigger": "alert" }
}
```

The Routine is keyed like a webhook one — the receipt carries the URL and the
key the outside service posts to — and the Plugin must be on for this Bot,
or every delivery is dropped with that reason.

## Sections

A Plugin can draw a section on its own card on the Bot's Plugins page — a
status line, a count, a control. Export `views`, one function per surface id,
and declare each in `plugin.json` under `views` with slot `settings.sections`:

```ts
export const views = {
  "notes.settings": async (ctx) => {
    const stored = await ctx.storage?.get({ key: "notes" });
    const count =
      stored?.status === "available" && Array.isArray(stored.value)
        ? stored.value.length
        : 0;
    return {
      root: {
        type: "group",
        orientation: "column",
        children: [
          { type: "text", text: `${count} note(s) kept.` },
          { type: "action", actionId: "note_clear", label: "Clear notes" },
        ],
      },
    };
  },
};
```

```json
"views": [{ "slot": "settings.sections", "surfaceId": "notes.settings" }]
```

The host draws the tree with its own widgets: `text`, `group`, `list` and
`action` nodes, at most 64 of them and at most 8 deep. A control's `actionId`
names one of your tools; pressing it runs that tool with the control's
`input`, outside any Turn, and the section is drawn again. A `field` or
`embed` node, a tool you do not declare, an empty string where a node wants
text, a title or a label, or a tree past those limits is refused and the card
says so instead of the section.
A section runs with the same `ctx` a tool call gets and is drawn only while
the Plugin is on for that Bot. Outside a Turn — a section, a control, a
trigger — `ctx.schedule` answers unavailable; everything else works.

## Cards

A Plugin can put a rich card in the conversation — a thing, some controls, and
a settled state — instead of a wall of text. You declare the card in
`plugin.json` and export its `render` in `plugin.ts`; the Bot sends the values
and your code composes the surface.

```json
"cards": [
  {
    "id": "draft",
    "displayName": "Email draft",
    "description": "Show a drafted email and ask the person to send or discard it.",
    "dataSchema": {
      "type": "object",
      "properties": { "subject": { "type": "string" } },
      "required": ["subject"],
      "additionalProperties": false
    },
    "actions": [{ "name": "details", "description": "Show the rest." }]
  }
]
```

```ts
import type { PluginCard } from "@frockbot/applet-sdk/plugin";

export const cards: Record<string, PluginCard> = {
  draft: {
    render: ({ surfaceId, data }, ctx) => [
      {
        version: "v1.0",
        createSurface: {
          surfaceId,
          components: [
            { id: "root", component: "Column", children: ["title", "more"] },
            { id: "title", component: "Text", text: String(data.subject) },
            { id: "more-label", component: "Text", text: "More" },
            {
              id: "more",
              component: "Button",
              child: "more-label",
              action: { name: "plugin/<your plugin id>/details" },
            },
          ],
        },
      },
    ],
    actions: {
      details: ({ surfaceId }) => [
        {
          version: "v1.0",
          updateComponents: { surfaceId, components: [] },
        },
      ],
    },
  },
};
```

- Each card is a tool the Bot calls: `<pluginId>_<cardId>`, taking
  `{ "data": … }` and optionally the `surfaceId` of a card it already drew, to
  update it in place. Declaring a tool of that name is refused at publish.
- The kernel validates `data` against your `dataSchema` before you see it, and
  refuses a schema using a keyword it cannot enforce — keep to `type`,
  `properties`, `required`, `additionalProperties`, `items`, `enum`, lengths,
  counts and ranges.
- You never choose a `surfaceId`: the kernel mints it and hands it to `render`,
  which is what stops one Plugin drawing over another's card.
- `render` returns the A2UI messages for the surface — an array, or
  `{ messages, covers, decision }`. Return `{ drop: true, reason }` to draw
  nothing.
- Components come from the catalogs the client compiled in. You ship no code
  and no markup; a component the client does not know refuses the whole card.
- An `ApprovalActions` component is the person's decision. Write
  `"approvalId": "pending"`: the kernel overwrites it with an Approval it
  records. The catalog allows the component that id and its two labels and
  nothing else, so the words the Approval is recorded with travel beside the
  messages, as `decision: { action, risk, rationale? }`. Drawing one ends the
  Turn; the decision arrives as durable input later.
- A card that draws an `ApprovalActions` must also return `covers`: the
  canonical values that decision authorizes, as *you* drew them. The kernel
  binds the Approval to those, and a capability claiming the decision later has
  to be about the same values. Return what your tool will actually act on —
  the draft you are holding, not the values the Bot passed to the card tool,
  which you may have ignored. A draw that asks for a decision and declares no
  `covers`, or no `decision`, is refused rather than recorded.
- `actions` are your own handlers, one per name declared in `plugin.json` and
  reached as `plugin/<pluginId>/<action>` from a component's `action` property.
  A press runs the handler with the Bot's authority and redraws the card — it
  costs no Turn. Return `{ messages, input }` to also leave one line for the
  Bot's next Turn. Action names are the Plugin's, so two cards may not share
  one, and a handler that throws or overruns leaves the card exactly as it was.

## What you cannot do

You cannot make a Plugin run on this Bot by yourself: publishing and enabling
both end in a card the User answers, because a Plugin widens what you are
allowed to do and "self-modification never widens your own authority". You
cannot reach a host you did not declare, read another Plugin's store, or call
a model other than this Bot's. A Plugin you delete from the source tree is
still in the User's history; nothing published is ever lost.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends your
reply.
