# Conversation panel

A Plugin can fill the page beside the conversation — the same tree, drawn by
the host, no HTML and no iframe. Declare a `conversation.panel` view; give it
a `label` when you declare more than one. A `bot.nav` view is a door on this
Bot's page; `opens` names which of your panel surfaces a press focuses.

```json
"views": [
  { "slot": "conversation.panel", "surfaceId": "board", "label": "Notes" },
  { "slot": "bot.nav", "surfaceId": "door", "label": "Notes", "opens": "board" }
]
```

The panel walk admits the full page vocabulary (`text`, `group`, `list`,
`field`, `action`, `embed` as a host image), 512 nodes, depth 16. `bot.nav`
is a row: the section vocabulary, 64 nodes, depth 8.

This Bot's `panel_focus` tool is mounted only when at least one enabled Plugin
declares a conversation panel. Call it when the person should look:

```
panel_focus({ "pluginId": "notes" })
panel_focus({ "pluginId": "notes", "surfaceId": "board" })
panel_focus({ "pluginId": null })
```

Publishing does not open the panel. Unknown, disabled, or not a conversation
panel is an error that names the tabs this Bot actually has.
