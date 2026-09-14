# ADR 0027: Applets are owned by a Bot and shared with Bots

Status: accepted, 2026-09-14.

## Context

An Applet was account-wide. Every Bot of a User listed every Applet, was
offered every Applet's tools, could rewrite any Applet's source, publish over
it, revert it and delete it. A User with a Bot for work and a Bot for home had
one pool: the home Bot's `applet_list` named the work tracker, its Composition
carried the tracker's tools, and nothing stopped it deleting the tracker's data
for every Bot.

That is an authority decision, not a presentation one. Who may change an
Applet's code decides who can make its tools say something else to every Bot
that calls them, and who may delete it decides whose data can disappear. Once
real Users hold Applets, narrowing that authority breaks things they already
rely on. This is the moment to decide it.

## Decision

**Every Applet has exactly one owner Bot.** The directory entry carries
`ownerBotId`, set to the Bot that created it. Ownership implies access.

**Sharing grants use, never authorship.** The entry carries
`sharedWithBotIds`: active Bots of the same User. A shared Bot may list the
Applet, focus and open it, use its page, embed it as a chat card, and call its
published tools. Only the owner may read or write the source, check, publish,
revert, read the generations, delete, share, unshare or transfer. The Bot
tools `applet_share`, `applet_unshare` and `applet_transfer` are the only way
access changes; the User's client has no share or transfer control yet.

**Transfer is metadata.** `applet_transfer` requires an active Bot of the same
User, makes it the owner, and keeps the former owner as a shared Bot. The
source root, the `AppletState` object (`idFromName("<userId>:<appletId>")`),
the generations and the facet's data stay User-scoped and are not touched, so
a transfer moves no bytes and cannot half-finish.

**Tool names stay unique across the account.** Two Applets never declare the
same tool name even when no Bot can see both, so a share or a transfer can
never produce a Composition that fails to mount on a name clash.

**Availability is separate from publication status.** `status` stays `draft |
published | deleted`; `available` is whether the Applet may be used at all.
The Bot lifecycle saga, which already runs in the User Durable Object beside
the directory, applies the Applet consequence in the transaction that settles
the Bot's lifecycle and advances the directory revision there:

- archiving the owner makes its Applets unavailable to every Bot, keeping all
  state;
- restoring the owner makes them available again;
- deleting the owner tombstones its Applets and queues their cleanup, whether
  or not they are shared;
- deleting a shared Bot removes it from every share list.

**Deletion tombstones and cleans idempotently.** An owner delete — the
`applet_delete` tool, the client's delete, or the owner Bot's deletion —
marks the entry `deleted`, clears its tools and shares, advances the revision
and writes an `applets:cleanup:<appletId>` to-do in the same write. The User
Durable Object then deletes the `AppletState` object's storage and the source
under `applets/source/<appletId>/`, and drops the to-do only when both are
gone; its alarm retries anything a crash left. Every step is a delete, so
repeating one is free.

**A destructive Bot deletion is fenced on what its confirmation showed.**
`GET /api/bots/:bot/applets/impact` answers the Applets the Bot owns, the
Bots each is shared with, and a fingerprint of that set. The client shows
both archive and delete that list, and a `bot/delete` from the client must
carry the fingerprint as `appletImpact`. The saga compares it with the
directory when it admits the command, and a mismatch is a 409 the client
answers by reading the impact again. Archive is not fenced, because it
destroys nothing and restore undoes it.

**Every read is scoped to the acting Bot.** The directory's list, a Bot's
Composition, the focus, the open endpoint, the chat card's UI and token reads,
and the source and build reads name the Bot, and an Applet the Bot has no
access to answers exactly as an Applet that does not exist. A viewer token
binds the Bot (`b`) beside the User, the Applet and the generation, and the
socket door checks that Bot still has access before it forwards, so an
unshare reaches the next socket rather than waiting out the token.

**Pinning is unchanged.** A Composition generation is still one per User; its
Applet members carry `ownerBotId` and `sharedWithBotIds`, so the access a Turn
runs under is pinned with the generation and covered by its artifact set hash.
A Bot registers only the Applet members it has access to. An access change
advances the directory revision and reaches the next admitted Turn, and an
admitted Turn keeps the tools it pinned. The management verbs are not Applet
tools: the owner check for them is made against the directory when they are
called, which only ever narrows what a Turn can do mid-flight.

**Legacy entries are cleaned, not decoded.** A directory entry without
`ownerBotId` has no owner to infer. On its first load after this change the
User Durable Object runs a scoped, receipted cleanup
(`maintenance:bot-owned-applets:2026-09-14`): it tombstones every such entry
and queues its state and source cleanup, and replaces a Composition generation
holding old-shape Applet members with one holding the same Plugins and no
Applets. Nothing else in the account is touched.

## Consequences

- `AppletDirectoryEntryV1`, `AppletSummaryV1`, `CompositionAppletMemberV1`,
  the viewer claims and the client wire `AppletSummary` change shape;
  `BotAppletImpact` is new and `BotLifecycleCommand` gains `appletImpact`.
- `/api/applets`, `/api/applets/:id/delete`, `/ui` and `/token` move under
  `/api/bots/:bot/applets`. The socket stays at `/api/applets/:id/socket`,
  because the token is what names the Bot.
- The native client's modal Applet picker is gone. The selected Bot's Applets
  are a mode of the left sidebar, and a pushed page on the phone, opened from
  the header's Applets button and the Bot settings Applets row.
- A User who wants a second Bot to build on an Applet asks the owner Bot to
  transfer it. Sharing an Applet with another User is still not planned.
