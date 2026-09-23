# Hooks

Each hook receives the event's payload and returns the _whole_ replacement
value, or `undefined` to leave it alone. `PluginHookPayloads` and
`PluginHookReplacements` in `types.md` give every payload's exact shape. The
events and what each may replace:

| Event                    | Replace               |
| ------------------------ | --------------------- |
| `system-prompt/assemble` | `payload.assembly`    |
| `agent/tool-exposure`    | `payload.tools`       |
| `agent/request`          | `payload.request`     |
| `tools/pre-execute`      | `payload.preparation` |
| `tools/post-execute`     | `payload.result`      |
| `agent/turn-stopping`    | nothing — a notice    |
| `theme/assemble`         | `payload.document`    |

Those seven are the whole surface. Do not invent another event name.

The kernel checks the value a hook returns before using it. When several
Plugins wrap one event, each receives the replacement of the one before it,
and the kernel checks the value the last one returns. A value it refuses is
not applied, nor is any earlier Plugin's change to it, and the failure is
charged to every Plugin that wraps the event: the User gets a notice naming
it and the reason, and three failures in a row turn it off for this Bot. A
replacement has exactly the members its type declares, no more.

## `theme/assemble`

The payload carries `document` (a `ThemeDocument`), `look` (`inherit` |
`studio` | `custom`), `now` and `timezone`. Return a whole `ThemeDocument`,
or `undefined` to leave the look alone. The kernel refuses a document unless:

- it has `schemaVersion` `1`, `look` (`ink` | `paper` | `studio`),
  `tokens`, and optionally `phases`, and no other member at any level;
- no key anywhere in it is `approval`, `billing`, `Stop` or `grants`;
- every colour in `tokens.surfaces` (`window`, `surface`, `raised`, `text`,
  `muted`, `line`, `accent`, `onAccent`) is `#rrggbb`;
- `text` has at least 4.5:1 contrast against `window` and against
  `surface`, `muted` at least 3:1 against `window`, and `onAccent` at least
  4.5:1 against `accent`;
- `type` is `manrope` or `inter`, `bubbles.bot` is `plain` or `raised`, and
  `bubbles.me` is `accent` or `tint`;
- `phases` has at most 24 entries, each exactly `{ after, tokens }`, where
  `after` is a 24-hour `HH:MM` time of day and `tokens` meets every rule
  above.

A refused document leaves the Bot on its last good theme.
