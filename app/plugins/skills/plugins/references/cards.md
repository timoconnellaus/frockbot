# Cards

A Plugin can put a rich card in the conversation — a thing, some controls, and
a settled state — instead of a wall of text. You declare the card in
`plugin.json` and export its `render` in `plugin.ts`; the Bot sends the values
and your code composes the surface.

Components come from the catalogs the client compiled in. You ship no markup.
Load `managed/a2ui` with `skill_load` for the message model, the families, and
the budgets; this file is the Plugin seam, not the catalog.

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
              action: { event: { name: "plugin/<your plugin id>/details" } },
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
  canonical values that decision authorizes, as _you_ drew them. The kernel
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
- A component `action` whose name is neither `plugin/<pluginId>/…` nor
  `approval/…` reaches no handler: it is the person's answer to the Bot, and
  it opens a Turn in which the Bot reads the name and `context` as a press on
  a control, never as their words. Use it when the Bot should act on the
  choice; use a handler when the card can answer the press itself.
- A handler is handed `{ cardId, surfaceId, action, context, dataModel, record }`:
  `cardId` is the card the pressed surface was drawn from, `record` is that
  Card's data model as the kernel stores it — read your card's state from there
  rather than keeping a second copy of it keyed by surface id — and `dataModel`
  is what the client sent back, only when the surface asked for it.
