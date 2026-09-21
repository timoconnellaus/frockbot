---
name: Build an Applet
description: Use this whenever you are creating or changing an Applet — a small real-time app with its own data, its own page beside the conversation, and tools you can call. It is the reference for the Applets SDK, the file layout, the authoring tools, and every rule the linter enforces.
---

# Build an Applet

An Applet is a real application. It has its own SQLite storage that survives
every code change, a React page the User opens beside this conversation, and
tools you — and the Bots you share it with — can call. You write it in
TypeScript with the `applet_*` tools, check it, and publish it. The source
lives in the cloud, a build service compiles it, and the published code runs in
the kernel's loader — no Computer is involved at any point.

## Who may do what

Every Applet has exactly one owner Bot. The Applets you create are yours.

- **The owner** reads and writes the source, checks, publishes, reverts, reads
  the generations, deletes, shares, unshares and transfers.
- **A Bot it is shared with** can see it in `applet_list`, open or focus it,
  send it as a chat card and call its published tools — nothing else. Reading
  its source, publishing over it or deleting it is refused. If it needs a
  change, ask the Bot that owns it with `bot_message`.
- `applet_list` says which is which: `yours`, or `shared with you by <bot>`.

Sharing is the owner's call:

- **`applet_share`** with the Applet's id and another Bot's id from
  `<teammates>` lets that Bot use it. The Bot must be active.
- **`applet_unshare`** takes that away. Its tools leave the other Bot from its
  next Turn; a Turn it is already running keeps them until it ends.
- **`applet_transfer`** makes another active Bot the owner. You keep shared
  access, and from then on only the new owner can change it. The source, the
  generations and the data do not move. Transfer only when the User asks.

Tool names are unique across the whole account, not just across the Applets
you can see, so a publish can be refused for a name you have never seen used.
Rename the tool and publish again.

If the owner Bot is archived, its Applets are unavailable to every Bot until it
is restored, and nothing is lost. If the owner Bot is deleted, its Applets are
deleted too, including for the Bots they were shared with.

Two files are yours: `server.ts` (the tables and the tools) and `ui.tsx` (the
page). Nothing else.

## The loop

1. **`applet_create`** with a display name. It makes an Applet you own,
   scaffolds a working todo list, and puts it in the panel beside the
   conversation. Do not create a second Applet for a change to one you already
   own — `applet_list` first. An Applet shared with you is not yours to change;
   ask its owner rather than building a copy.
2. **`applet_files`** and **`applet_read_file`** to see what is there, then
   **`applet_write_file`** to change it. A write replaces the whole file, so
   read before you write. Two files are yours: `server.ts` and `ui.tsx`. The
   scaffold already builds; change it rather than starting empty.
3. **`applet_check`** with the Applet's id. It type-checks, lints, bundles and
   boots your server, and answers either with every problem as
   `path:line:col message` or with the tools it declares and a URL for its
   page. Fix every diagnostic. Do not publish over a failing check — the
   publish is refused and returns the same lines.
4. **`applet_publish`** with the Applet's id. It builds the current source
   again, records an immutable generation, mounts it, and offers its tools to
   you and every Bot it is shared with from the next Turn — not this one.

The tool list is derived by _running_ your server inside the build, so a tool
that does not boot is a build failure rather than a surprise later.

`applet_check`'s page URL is the built UI with no data behind it: it proves
the page renders, not that the Applet works. Publishing is what makes it real.

`applet_generations` lists the history; `applet_revert` moves back to an
earlier generation and is itself recorded. Reverting code never touches the
Applet's data. `applet_delete` destroys the data too — for every Bot it is
shared with — so ask the User first. `applet_focus` opens the page beside
this conversation.

## References

Load one with `skill_load` — `{"path": "managed/applets", "reference": "server.md"}`.

- `server.md` — `server.ts`: tables, tools, `this.db`, migrations.
- `ui.md` — `ui.tsx`: live queries, optimistic writes, `mount`.
- `kit.md` — the component kit and the host tokens.
- `lint.md` — the rules `applet_check` enforces as errors.
- `troubleshooting.md` — what a failure line means.

Every reply is a `send_to_user` call: use disposition:"continue" while you
still have more to say or do, and disposition:"finish" on the send that ends
your reply.
