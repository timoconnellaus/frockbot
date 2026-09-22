# Sections

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

The slots a Plugin may declare are `composer.toolbar`, `message.actions`,
`settings.sections`, `bot.profile`, `conversation.panel`, and `bot.nav`.
Open today: `settings.sections`, `conversation.panel` (the page beside the
chat), and `bot.nav` (a door on this Bot). How to declare those two is
`panels.md`. `composer.toolbar`, `message.actions`, and `bot.profile` are
closed. Trust chrome is never a slot.
