---
status: accepted
---

# An Applet activation is a commit boundary, and a Turn executes the Applet generation it pinned

An external review on 2026-09-05 reproduced two defects in Applets, both P1 and
both about the same thing: the kernel knew which Applet generation was supposed
to be running, and nothing enforced it.

**Rolling back an Applet's code did not roll back its data.** `AppletState`
mounted a candidate generation directly against the live facet and then asked it
`health()`. The facet is the Applet's real SQLite storage, and a candidate runs
plenty of code before it answers: its constructor, the SDK's `ready()` — which
creates and alters tables and then calls the Applet's own `migrate()` — and
`health()` itself. All of that writes. Treating a later health failure as a
rollback was wishful: re-`get`ting the previous class over storage the candidate
had already changed leaves the previous generation resident over data it no
longer recognises. The review's counterexample: generation A stored a todo,
candidate B deleted the rows and failed its tool-health check, the host reported
A resident, and A returned an empty list. A timed-out activation was worse still
— the deadline abandoned the candidate without undoing anything.

**A Turn pinned to generation A could execute generation B.** Tool registration
put the pinned Applet generation in the description the model reads
(`backend-composition.ts`), but the invocation DTO carried only the Applet id,
the tool name, and the input. `AppletState.invokeTool` ran whatever generation
was resident. So a publish landing mid-Turn — by the User, by the Bot itself, or
by another Bot of the same User — made the next tool call execute new code behind
the schema, the description, and the provenance the Turn had already advertised.
That contradicts the constitution's "an in-flight Turn completes on its pinned
Composition" and makes the Turn unreconstructable from its recorded generation.

## Considered options

### Making the trial safe

- **Keep mounting against live storage and rely on the candidate failing
  cleanly.** Rejected: it is the defect. Nothing constrains what a constructor
  or a migration writes before it throws, and Bot-authored code is exactly the
  code we cannot assume is careful.
- **Ask the resident facet to export its rows, and restore them on failure.**
  Rejected. The export would have to run inside the facet, so it would be a
  method on the SDK's `Applet` base class that authored code can override,
  shadow, or simply not have (an Applet may write tables the SDK never declared
  with raw `ctx.storage.sql`). A rollback that the code being rolled back gets a
  vote on is not a rollback.
- **Wrap DDL, `migrate()` and `health()` in one SQLite transaction inside the
  SDK.** Rejected. `migrate()` is async by contract, and `transactionSync()`
  takes a synchronous closure; changing the authoring surface to a synchronous
  migration would forbid the one thing migrations legitimately need. It also
  protects only what the SDK routes through itself, not raw SQL.
- **Trial the candidate on a second facet holding a copy of the live data, then
  mount it for real.** Viable, and it is what the "disposable/copy state" option
  describes — but it runs the candidate's migrations twice, once against the
  copy and once against the live rows, and the second run is still unprotected.
- **Snapshot the live facet, run the candidate against the real storage, and
  restore the snapshot on failure.** Chosen. `ctx.facets.clone(src, dst)` is a
  whole-facet storage copy the _kernel_ performs, from outside the facet, with
  no cooperation from the Applet's code and no dependence on what tables it
  declared. It is what the Durable Object API actually supports for this, and it
  is the only option on this list that the Applet cannot subvert.

### In-flight tool calls after a publish

- **Retain generation A executable and route the pinned Turn to it (an execution
  lease), deferring activation until leases drain.** Rejected, and not only for
  its cost. An Applet's facet storage is singular and shared: activating B
  migrates it. Keeping A's _code_ alive would not keep A's _data shape_ alive, so
  the lease would run old code against migrated rows — the compatibility hazard
  the trial above exists to avoid, reintroduced deliberately. Deferring
  activation until every in-flight Turn drains is worse: it holds a User's
  publish behind an arbitrarily long Turn, and a Bot repairing its own Applet
  would deadlock against itself.
- **Refuse a mismatched call with a plain reason.** Chosen. Refusing is safer
  than running the wrong version, and the Turn's own pinned Composition is what
  explains it: the refusal names both generations, says nothing ran, and says the
  next Turn picks up the new one.

## Decision

**An activation is a commit boundary the kernel owns, with a recoverable
snapshot.** Before a candidate generation is mounted, `AppletState` clones the
live facet into a second facet, `applet-rollback`, that never has code mounted
against it, and then writes an `applet:trial` record naming the candidate and
the previous mount input. The snapshot precedes the marker, so a marker never
promises a copy that was never taken. The candidate then mounts against the real
storage and is asked `health()` under the existing deadline. On success the
promotion is one atomic transaction: the generation's `active` status, the
previous generation's `superseded` status, the current pointer, last-known-good,
and the deletion of the trial record go in together, and the rollback facet is
dropped afterwards. That transaction is the commit — a health check that passed
is not, because an eviction between the two would leave the candidate resident
under a pointer still naming the previous generation, with no trial left to
settle and every pinned tool call refused. On any
failure — a throwing constructor, a throwing migration, a health answer that
contradicts the manifest, or a blown deadline — the kernel aborts the candidate
facet first, clones the rollback copy back over it, restores the previous mount
input, and re-`get`s the previous class. The abort precedes the clone so a
candidate still running past its deadline cannot write behind the restore.

**An interrupted activation is settled before anything else reads the Applet.**
While `applet:trial` exists the facet's storage is provisional. `publish`,
`revert`, `invokeTool`, `connectViewer`, `read` and `alarm()` all settle an open
trial first, which rolls it back — including a trial record that cannot be
decoded, which is rolled back onto the generation the current pointer names
rather than merely deleted. A Durable Object eviction between the snapshot and
the commit therefore leaves a half-migrated Applet for exactly as long as it
takes the next caller to arrive, rather than promoting code that never passed a
health check. Rolling back is also what keeps the rest of the account
consistent: a publish that was interrupted before its commit never returned to
its caller, so the User's Applet directory — which follows the mount and is
written by that caller — still names the previous generation too.

**An Applet's first generation has nothing to protect.** With no previous mount
input there is no snapshot and no restore: a failed first activation deletes the
facet outright, so the next candidate starts on empty storage rather than on
whatever the refused one wrote.

**A tool call names the generation its Turn pinned, and the instance runs that
generation or refuses.** `ShellAppletMountOptions.invokeTool` and
`AppletInstanceBindingV1.invokeTool` carry `generationId`; the Composition passes
the member's pinned generation, which is the same string the tool description
shows the model. `AppletState.invokeTool` compares it against the resident
generation and, on a mismatch, returns an ordinary tool error naming both
generations and stating that nothing ran. Nothing is executed, nothing is
retried against the new code, and the next admitted Turn — which pins the new
generation — runs it.

**Which older generations stay compatible with migrated data.** The SDK's
`ensureSchema` is additive: it creates missing tables and adds missing columns,
and every added column is either optional or `NOT NULL DEFAULT`. It never drops
a table or a column. So a generation whose declared tables and columns are a
_subset_ of what the storage now holds remains mountable and writable over
migrated data — which is what makes revert work, and what the revert test
proves. Two things are not compatible and are not made compatible here: a
generation that redeclares an existing column with a different type, and one
whose behaviour depends on data a later generation's `migrate()` rewrote.
Reverting past either is a mount the Applet's own code has to handle, and it
fails closed onto the last known good like any other failed activation.

## Consequences

- A publish now costs one whole-facet storage copy, taken and discarded inside
  the activation. Applet storage is per-User product state under the existing
  Applet quotas, and the copy lives only for the length of one health check.
- `applet-rollback` is a second facet name under every `AppletState` object.
  Deleting an Applet deletes it too, so it can never outlive its Applet.
- A tool call's DTO is one field wider. Because both sides of that seam ship in
  the same Worker script, the field is required rather than optional: a caller
  that cannot name a generation has no business executing one.
- A Bot that publishes an Applet mid-Turn will see its own next tool call
  refused, with a reason that tells it to retry on the next Turn. That is the
  intended behaviour, and it is visible to the Bot rather than silent.
