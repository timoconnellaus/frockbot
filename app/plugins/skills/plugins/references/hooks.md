# Hooks

Each hook receives the event's payload and returns the _whole_ replacement
value, or `undefined` to leave it alone. The events and what each may
replace:

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

`theme/assemble` wraps the Bot's look: the payload carries `document`,
`look` (`inherit` | `studio` | `custom`), `now` and `timezone`. Return the
replacement document, or `undefined` to leave it alone.
