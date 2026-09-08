# __APPLET_NAME__

A FrockBot Applet. Two files are yours:

| File        | What it owns                                                               |
| ----------- | -------------------------------------------------------------------------- |
| `server.ts` | the tables (state that survives every code change) and the tools Bots call |
| `ui.tsx`    | the page the User sees beside the conversation                             |

## The loop

`applet_files` and `applet_read_file` to see what is here, `applet_write_file`
to change it, then `applet_check` — it type-checks, lints, bundles and boots
your server, and answers either with every problem as `path:line:col message`
or with the tools it declares and a URL for the page. Publish with
`applet_publish` once the check is clean.

## Rules the linter enforces

- Colours come from the nine `--frockbot-*` theme tokens. The kit's components
  already use them; never write `#hex`, `rgb(...)`, or a colour name.
- No `fetch`, `XMLHttpRequest`, or `WebSocket`. The Applet has no outbound
  network: reach the world through a tool on the server.
- Import only from `@frockbot/applet-sdk/*`, `react`, and your own files.
- Declare tables with `table({ ... })` and tools with `this.tool({ ... }, fn)`.

## Changing the schema

Add a column with `.default(...)` or `.optional()` and the SDK adds it on the
next mount, keeping the rows. For anything else — renaming, rewriting values —
override `migrate(from)` on the class; it runs once, before the Applet serves
anything, and throwing fails the mount back to the last known-good generation.

The kit's components and their props are documented in the Applets Skill.
