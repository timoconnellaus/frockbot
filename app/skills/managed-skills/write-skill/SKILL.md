---
name: Write a Skill
description: Use this when you are writing or updating a Skill — a recipe you or another of your User's Bots will follow later — including when the User sends you a demonstration they recorded on the Computer to learn from.
---

# Write a Skill

A Skill is a directory: one `SKILL.md` and the Markdown files under
`references/`. The catalog lists only its name and description. The body is
read on demand with `skill_load`. Mentioning a Skill is not running it.

1. Decide who should see it. `scope: "bot"` (the default) is only you.
   `scope: "user"` is every Bot your User owns, attributed to you. You cannot
   write `managed` or `plugin` Skills.
2. Call `skill_write` with a short `name`, a `description` that starts "Use
   this when …" so a future catalog line is enough to decide, a `slug`, and a
   `body` that is the recipe — not the encyclopedia. Keep the body under a
   page. Name the reference files the body will need.
3. For each reference, call `skill_write` again with that `slug`, the
   `reference` file name (`forms.md`), and the file's Markdown as `body`.
4. Confirm with the User: slug, description, and the steps. A wrong Skill is
   a durable mistake.

The Skill is visible on your next Turn, not this one. Do not claim to have
followed it in the Turn that wrote it.

A message carrying `demonstration-<id>.json` is the User showing you a task
on the Computer: load `demonstration.md` before you do anything else with it.
A walkthrough typed into this conversation is something you turn into a
Skill with `skill_write`, or it is not a Skill yet.

## References

Load one with `skill_load` — `{"path": "managed/write-skill", "reference": "format.md"}`.

- `format.md` — the `SKILL.md` shape `skill_write` will render.
- `references.md` — how to add files beside the Skill, and how they load.
- `scope.md` — bot versus user, and the two scopes that refuse.
- `demonstration.md` — learning a Skill from a recording the User sent.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
