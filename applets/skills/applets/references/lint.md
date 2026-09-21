# The rules the linter enforces

Every one of these is an error from `applet_check`, not a warning.

- **`applet/no-raw-colors`** — no `#hex`, `rgb()`, `rgba()`, `hsl()`, `hsla()`,
  `color-mix()`, or a CSS colour name, in `.ts`, `.tsx`, or `.css`. Use the
  tokens. If the kit cannot express what you want, say so to the User rather
  than styling around it.
- **`applet/no-network`** — no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, or `navigator.sendBeacon`. An Applet has no outbound network.
  Reach the world through a tool on the server, which the Bot calls.
- **`applet/allowed-imports`** — only relative imports, `react`, and
  `@frockbot/applet-sdk/*`. There is no npm install.
- **`applet/tables-via-table`** — `tables` is an object literal of `table({…})`.
- **`applet/tools-via-this-tool`** — `tools` is an object literal of
  `this.tool(…)`.
