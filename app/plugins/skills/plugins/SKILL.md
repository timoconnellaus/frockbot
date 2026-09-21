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

## References

Load one with `skill_load` — `{"path": "managed/plugins", "reference": "module.md"}`.

- `module.md` — `plugin.ts`: tools, execute, hooks.
- `descriptor.md` — `plugin.json`: id, version, contract, matching exports.
- `grants.md` — what `ctx` opens, network, email, `files` and `computer`.
- `hooks.md` — every loop event you may wrap, including `theme/assemble`.
- `triggers.md` — inbound deliveries and `routine_manage`.
- `sections.md` — a settings.sections view on the Plugin's card.
- `cards.md` — declaring a card, drawing it, approvals and actions.
- `limits.md` — what you cannot do, and what a publish never is.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
