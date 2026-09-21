# Grants

`grants` is what the module may use, from `storage`, `http`, `schedule`,
`ai`, `files`, `memory`, `workspace`, `computer`.

`ctx` names the User, the Bot and the Session, and one member per grant
the descriptor declares that actually opens a handle:

- `ctx.storage` (`storage`)
- `ctx.connection` (`http`)
- `ctx.schedule` (`schedule`)
- `ctx.model` (`ai`)
- `ctx.memory` (`memory`)
- `ctx.workspace` (`workspace`)

`files` and `computer` are declared to the authority and open nothing on
`ctx` today: name them only when the User is granting that reach, not because
you have a call to make.

A grant you did not declare is simply absent. `ctx.settings.read()` and
`ctx.capabilities.list()` are always there. Every call answers
`{ status: "unavailable", reason }` rather than throwing when the authority
refuses it.

`ctx.model.invoke(...)` (the `ai` grant) calls the Bot's own model at the
Bot's rates. Each call is itemised under your Plugin's name on the Turn's
Work view, tokens and cost, so a User can see what it spent.

`ctx.deadlineMs` is how long the call may run. A hook that overruns is
skipped for the Turn; three failures in a row take the Plugin out of this
Bot until a person turns it back on.

Network: with the `http` grant, `fetch` reaches only the hosts
`plugin.json` declares. Add `"network": { "hosts": ["api.example.com"] }`
(a leading `*.` matches one subdomain label), or `"network": { "open": true }`
for the whole network — the card says plainly that open network means every
Plugin on this account, so declare hosts unless you truly cannot. Every other
host is refused at the edge. The same grant gives you `ctx.email(...)`, which
asks this deployment's own sender to send one plain-text message for this Bot
— you hold no credential and name no provider, and a deployment that has
bound no sender answers unavailable.
