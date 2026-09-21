# References beside a Skill

A large Skill costs the prompt only what a Turn reads. Put the encyclopedia
in `references/`, one `.md` file at a time, and keep `SKILL.md` as the
procedure plus an index.

Write a reference with `skill_write`:

```json
{
  "slug": "daily-standup",
  "reference": "agenda.md",
  "body": "# Agenda\n…"
}
```

Rules:

- `reference` is a single `.md` file name, like `forms.md`. Not a path.
- Do not pass `name` or `description` on a reference write.
- At most 32 references, 64 KiB each.
- The Skill's own `SKILL.md` must list each file so a later Turn knows
  which to load.

Load one with `skill_load`:

```json
{ "path": "bot/daily-standup", "reference": "agenda.md" }
```

`skill_load` without `reference` returns the `SKILL.md` body. Only a Skill
this Turn loaded, at the generation the catalog listed, can be read.
