# __APPLET_NAME__

A FrockBot Applet. Two files are yours:

| File        | What it owns                                                               |
| ----------- | -------------------------------------------------------------------------- |
| `server.ts` | the tables (state that survives every code change) and the tools Bots call |
| `ui.tsx`    | the page the User sees beside the conversation                             |

## The loop

```sh
applet check # type-check and lint; every problem prints as path:line:col message
applet build # dist/server.js, dist/ui.html, dist/manifest.json
applet dev   # serves the built Applet; prints a URL, opens nothing
```

Open the printed URL in the Computer's browser to look at it. Publish with
`applet_publish` once `applet check` is clean.

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
