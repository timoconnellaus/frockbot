# `plugin.json`

```json
{
  "id": "notes",
  "displayName": "Notes",
  "version": "1",
  "contractVersion": 7,
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
- `contractVersion` is the kernel contract the module is built against. The
  scaffold `plugin_create` wrote already names the one this deployment serves
  — leave that number alone rather than typing your own: a Plugin declaring a
  contract the deployment has retired does not mount, and one naming a
  contract that does not exist yet is refused at publish.
- `tools`, `hooks`, `triggers`, `views` and `cards` must match the module's
  exports, name for name. A mismatch is refused at publish with both lists.
- `grants` is what the module may use. See `grants.md`.
- `settingsSchema` (optional) is a JSON Schema for per-Bot values the User
  can set; read them with `ctx.settings.read()`. Never put a secret in it.
- `provides` / `consumes` (optional) name services by `{ "name", "version" }`
  for Plugins that share values with each other through `export const services`.
- `triggers` (optional) name `{ "name", "description" }`, one per function
  `export const triggers` holds. See `triggers.md`.
- `contextKeys` is always all three.
