---
name: Build a Plugin
description: Use this whenever you are creating or changing a Plugin — code of your own that adds tools to this Bot, wraps steps of your own loop, keeps its own data, ships Skills or cards, draws a page beside the conversation and a door on this Bot, serves a model provider this deployment opened, and reaches the network the User allowed. It is the reference for the Plugin SDK, the two files, every export and grant, the authoring tools, and the approval that makes a Plugin live.
---

# Build a Plugin

A Plugin is your own code, running inside the kernel beside you. It can offer
you tools, wrap your loop, keep a key-value store for this Bot, ship Skills
the catalog lists as `plugin/<pluginId>/<slug>`, draw cards, expose a
settings section, fill the page beside the conversation — with a page of its
own when it needs one — put a door on this Bot, receive webhooks, share typed services with other Plugins,
and — when this deployment's catalog opens the claim — serve a model
provider. You write it in TypeScript with the `plugin_*` tools, check it,
publish it, and the User approves it in the conversation. Nothing you
publish runs until they do.

Two files are yours: `plugin.ts` (the module) and `plugin.json` (the
descriptor). Skills, cards, settings, panels and providers live in those two
files, not as extra paths. The one other file is an HTML page a
`conversation.panel` view names (`pages.md`).

## The loop

1. **`plugin_list`** first. It shows every Plugin this User's Bots wrote and
   whether each one runs on this Bot. Extend one that exists rather than
   creating a second with the same purpose. Sibling Bots see a published
   generation but do not run it until someone switches it on for them.
2. **`plugin_create`** with a display name. It makes the directory, writes a
   working starting point — two tools over the storage grant — and tells you
   the Plugin's id. The id is what every other tool takes.
3. **`plugin_files`** and **`plugin_read_file`** to see what is there, then
   **`plugin_write_file`** to change it. A write replaces the whole file, so
   read before you write. Keep `plugin.json` and `plugin.ts` in step: every
   tool, hook, trigger, view, card, service and model provider the module
   exports is named in the descriptor, and every grant the module uses is
   declared there.
4. **`plugin_check`** with the Plugin's id. It type-checks the module against
   the SDK and answers with every problem as `path:line:col message`, or with
   "builds", plus anything the check warns about: a page with colours written
   out instead of the `--frockbot-*` variables, a page that loads from the
   network, or code that reaches a host `plugin.json` does not declare. Fix every line. Do not publish over a failing check. The SDK's
   types are not on the Computer: `plugin_check` is what resolves
   `@frockbot/applet-sdk/plugin`, so never hunt for them there. Every type it
   declares is in `types.md`.
5. **`plugin_publish`** with the Plugin's id and its `purpose`: what the
   person asked it to do, in a sentence or two. It builds the module, runs it
   once to read what it exports, compares that with `plugin.json`, stores the
   artifact, and asks the User to approve it with a card in the conversation
   that lists its tools, hooks, grants, hosts and model providers. The card
   also warns the User when the Plugin may not do what they asked, holds a
   part nothing they asked for needs, or fails the check above; the result
   tells you what it warned, so answer each point. Say in your own words what
   the Plugin does and why you built it, then end your Turn. Their answer opens a Turn of yours that carries the decision;
   approved, the Plugin is already live on this Bot in that Turn — never the
   one in flight — so tell them it is ready.

`plugin_enable` asks the same approval for a Plugin that exists but does not
run on this Bot. `plugin_disable` turns one off for this Bot at once, no
approval needed — narrowing what you can do is always yours to decide.
`plugin_settings` reads or writes the values a Plugin's `settingsSchema`
declares, for this Bot. Never a secret. `plugin_page_reports` reads what a
Plugin's pages reported from the person's devices, and `plugin_page_try` runs
a page on your Computer before you publish it: see `pages.md`.

A Plugin with no tools is valid: hooks, a provider, a trigger, a card or a
conversation panel can be the whole surface. A card's Bot-facing tool is `<pluginId>_<cardId>`;
declaring that name yourself is refused. For the components a card may draw,
load `managed/a2ui` with `skill_load`.

## References

Load one with `skill_load` — `{"path": "managed/plugins", "reference": "module.md"}`.

- `module.md` — `plugin.ts`: tools, execute, every optional export.
- `descriptor.md` — `plugin.json`: id, version, contract, matching exports.
- `grants.md` — `ctx`: grants, `fetch`, email, settings, capabilities.
- `types.md` — every SDK type, copied from the file `plugin_check` uses.
- `hooks.md` — every loop event you may wrap, including `theme/assemble`.
- `skills.md` — Skills this Plugin ships as `plugin/<pluginId>/<slug>`.
- `services.md` — `provides` / `consumes` and `export const services`.
- `providers.md` — `modelProviders` and `ctx.modelTransport`.
- `triggers.md` — inbound deliveries and `routine_manage`.
- `sections.md` — a settings.sections view on the Plugin's card.
- `panels.md` — `conversation.panel` and `bot.nav`, and `panel_focus`.
- `pages.md` — a panel that is your own HTML page, and its bridge.
- `microphone.md` — a page that listens, with a whole guitar tuner.
- `cards.md` — declaring a card, drawing it, approvals and actions.
- `limits.md` — what you cannot do, and what a publish never is.
- `troubleshooting.md` — check, publish, mount and health failures.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
