# Grants

`grants` is what the module may use, from `storage`, `http`, `schedule`,
`ai`, `files`, `memory`, `workspace`, `computer`.

`ctx` always names the User, the Bot and the Session, this Plugin's
`packageId`, `deadlineMs`, `bindings`, `capabilities.list()`,
`settings.read()`, and `services` (empty when you consume nothing). One
member per grant the descriptor declares that actually opens a handle:

- `ctx.storage` (`storage`) — a key-value store scoped to this Plugin and
  this Bot. Keys are `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`; a value
  serializes to at most 64 KiB. `get`, `put`, `delete`, `list`.
- `ctx.connection` (`http`) — `(connectionId) => lease`. The lease is an
  opaque, expiring reference to a Connection the Bot holds. You never see
  the credential. Use `capabilities.list()` to learn which Connections
  exist; pass an id you did not invent.
- `ctx.email` (`http`) — asks this deployment's own sender to send one
  plain-text message for this Bot. You hold no credential and name no
  provider. The request names `approvalId` and `surfaceId` of a card
  decision that covers this exact message; one decision sends at most one
  message. A deployment that has bound no sender answers unavailable. An
  `http` grant with `"network": { "hosts": [] }` still opens email and
  opens no `fetch` host.
- `ctx.schedule` (`schedule`) — `{ callId, input }`. `input` is a
  `routine_manage` body; `callId` is yours and makes a retry at-most-once
  for this Plugin. Outside a Turn — a section, a control, a trigger —
  `ctx.schedule` answers unavailable. See `triggers.md` for creating a
  Routine that delivers _to_ you.
- `ctx.model` (`ai`) — `invoke(...)` calls the Bot's own configured model
  at the Bot's rates. Each call is itemised under your Plugin's name on
  the Turn's Work view, tokens and cost. You cannot name another model.
  This is not a model _provider_; see `providers.md` for serving one.
- `ctx.memory` (`memory`) — `read` / `write` / `forget` with `scope`
  `bot` | `user` and optional `tier` `profile` | `log` | `note`. Facts are
  strings. Never a secret.
- `ctx.workspace` (`workspace`) — `read`, `list`, `stat`, `write`,
  `delete` on a `WorkspacePath`. Roots are `{ kind: "bot-instructions",
botId }`, `{ kind: "user-instructions" }`, or `{ kind:
"package-declared", packageId, rootId }`. Writes take
  `expectedGenerationId` (null for create). Deletes take the generation
  you last read.

`files` and `computer` are declared to the authority and open nothing on
`ctx` today: name them only when the User is granting that reach, not
because you have a call to make.

A grant you did not declare is simply absent. Every call answers
`{ status: "unavailable", reason }` rather than throwing when the
authority refuses it.

`ctx.deadlineMs` is how long the call may run. A hook that overruns is
skipped for the Turn; three failures in a row take the Plugin out of this
Bot until a person turns it back on.

Network: with the `http` grant, `fetch` reaches only the hosts
`plugin.json` declares. Add `"network": { "hosts": ["api.example.com"] }`
(a leading `*.` matches one subdomain label, at most 32 hosts), or
`"network": { "open": true }` for the whole network — the card says
plainly that open network means every Plugin on this account, so declare
hosts unless you truly cannot. Every other host is refused at the edge.
You never name a destination on `ctx.modelTransport`; that is a different
door.
