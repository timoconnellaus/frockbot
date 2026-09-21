# Skill format

`skill_write` without `reference` writes the `SKILL.md`:

- `name` — at most 64 characters, one line.
- `description` — at most 1024 characters, one line, starting "Use this
  when …" or "Use this whenever …".
- `body` — the Markdown recipe, at most 64 KiB.
- `slug` — the directory name. Pass one. A name that does not slug cleanly
  is refused.

The file the tool writes is:

```
---
name: Daily standup
description: Use this when assembling the weekday standup.
---
# Steps
1. …
```

Separate the recipe from the instance. Names, dates, ids, and amounts from
the conversation are examples, not the Skill. A step that needs a tool you
do not have must ask the User, not pretend it will work.

Check a step against what you can actually do before you write it.
