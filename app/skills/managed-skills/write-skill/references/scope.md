# Where a Skill lands

- `scope: "bot"` (default) — this Bot's instruction root. Only this Bot
  lists it.
- `scope: "user"` — `users/<id>/skills/`. Every Bot this User owns reads it,
  and the catalog says you wrote it.
- `scope: "managed"` — refused: "managed skills are not editable this way".
  Those are bytes of the product, not Workspace files.
- `scope: "plugin"` — refused: "plugin skills are not editable this way".
  Change what a Plugin teaches by writing the Plugin.

A User-global Skill is still written under authority you already hold. It
does not widen anyone's reach. It only shares a recipe.

Quota is per root. Past the cap, the write is refused rather than silently
dropping an older Skill.
