# `plugin.json`

```json
{
  "id": "notes",
  "displayName": "Notes",
  "version": "1",
  "contractVersion": 7,
  "tools": [
    {
      "name": "note_count",
      "description": "How many notes this Plugin has kept.",
      "inputSchema": { "type": "object" }
    },
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

Required keys: `id`, `displayName`, `version`, `contractVersion`, `tools`,
`hooks`, `grants`, `contextKeys`. Optional keys: `network`, `settingsSchema`,
`provides`, `consumes`, `triggers`, `skills`, `cards`, `modelProviders`,
`slots`, `views`.

- `id` is the Plugin's id, exactly as `plugin_create` named it.
- `version` is a string you bump when you publish a change. A publish with
  the version already live is still a new generation — the User approves the
  code, not the number — but bumping it is how you both tell versions apart.
- `contractVersion` is the kernel contract the module is built against. The
  scaffold `plugin_create` wrote already names the one this deployment serves
  — leave that number alone rather than typing your own: a Plugin declaring a
  contract the deployment has retired does not mount, and one naming a
  contract that does not exist yet is refused at publish.
- `tools`, `hooks`, `triggers`, `views`, `cards` and `modelProviders` must
  match the module's exports, name for name. `provides` must match
  `export const services`. A mismatch is refused at publish with both lists.
- `grants` is what the module may use. `network` is present exactly when
  `grants` holds `http`. See `grants.md`.
- `settingsSchema` (optional) is a JSON Schema for an object of per-Bot
  values the User can set; read them with `ctx.settings.read()` or
  `plugin_settings`. Never put a secret in it. At most 64 KiB of schema
  text.
- `provides` / `consumes` (optional) name services by `{ "name", "version" }`.
  See `services.md`.
- `triggers` (optional) name `{ "name", "description" }`. See `triggers.md`.
- `skills` (optional) is `{ "slug", "text", "references"? }[]`. See
  `skills.md`.
- `cards` (optional) is `{ "id", "displayName", "description", "dataSchema",
"actions" }[]`. See `cards.md`.
- `modelProviders` (optional) is `{ "id", "protocolVersion" }[]`. See
  `providers.md`.
- `slots` / `views` — see `sections.md`. Only `settings.sections` is open.
- `contextKeys` is always all three: `user`, `bot`, `session`.
