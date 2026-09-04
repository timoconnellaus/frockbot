---
status: accepted
---

# An Applet's build progress is a client projection of the Turn, not durable state

Building an Applet is slow and mostly invisible. `applet_create` makes the
directory entry, writes the scaffold into the Applet's source root on the
Computer, and focuses the canvas. The Bot then edits files, runs
`applet check` and `applet build` through `computer_exec`, and finally calls
`applet_publish`. Only that last call produces something the canvas can run.
In production the gap between the first and the last call is typically two to
ten minutes and sometimes ends in a failure the person never sees (Bot
test-99860758, 2026-09-04).

For all of that gap the canvas beside the conversation showed one unchanging
line saying the Applet was not live, plus the source files. Nothing said
whether anything was happening, which step it was on, why a publish had been
refused, or what the last check printed. The Applets list had the same
problem in smaller: it recited the directory record's own words at a person.

## Considered options

- **Record the progress durably.** Give the Applet authority a build-status
  record the Bot updates as it goes, and read it from the canvas. Rejected for
  now: it makes a second authority for something the Session already knows,
  and it requires the Bot to remember to report, which it will not do reliably.
  The Session's own tool events are the primary record of what happened; a
  status field would be a derived copy that can disagree with them.
- **Read the outcome from `AppletBuildViewV1`.** The route and the DTO exist
  (`GET /api/bots/:bot/applets/:id/build`), but nothing populates it: the Bot
  Durable Object returns `{ status: "unknown" }`. Filling it honestly means the
  `applet` CLI writing a report file into the durable root, and the CLI reaches
  Computers through a pinned npm release rather than this repository's build.
  Kept as an input the projection reads when it ever carries anything, not
  relied on.
- **Project the line on the client from what the thread already draws.**
  Chosen.

## Decision

**`appletProgressV1` is a pure function over what the client already holds.**
`packages/plugin-shell/src/client/applet-progress.ts` takes the focused
Applet's directory summary, its source view, the recorded build view, and the
Turn tool activity the transcript is already drawing, and returns one stage,
one label, an optional failure sentence, and a bounded output tail. It reads
no route, writes no state, and holds no clock. Both surfaces that show
progress call it, so a phone and a wide screen never disagree.

**The stages are the order the work happens in, and the projection takes the
furthest one it has evidence for:** `unknown`, `created`, `writing`,
`checking`, `building`, `publishing`, `published`. `unknown` is the honest
answer — "Still being built", the words the Applets list already uses — and is
what a draft reads as until something specific is known. Nothing invents a
step it has not seen.

**A shell command is recognised by its output, not by its command line.** The
Turn projection carries the input of dynamic tool calls only, and
`computer_exec` is a native tool, so the client is never told what a shell call
ran. What it is told is the result, and the `applet` CLI's output is a stated
contract: `applet check:` on a line of its own, and the three `dist/` paths a
build reports. Matching those two shapes turns a shell result into "the check
came back" or "the build came back", with the tail of its output. Anything
else the Bot ran is not recognised and contributes nothing, which is the right
failure: silence rather than a wrong line.

**A failure is shown in the words of whatever refused.** A publish that was
refused carries the Applets Package's own reason — a tool-name clash, a stale
build — straight into the panel. A check that found errors is summarised in
plain words with its diagnostics underneath. The failure stays on screen after
the Turn settles, because the last thing that happened to the Applet is what a
person needs to see.

**The projection reads every Turn, not only the running one.** Building an
Applet spans several Turns with conversation in between, and the reducer takes
the last relevant activity. A settled failure therefore survives until
something newer replaces it.

**Bounds are part of the contract.** At most twelve output lines, each at most
200 characters; a failure sentence at most 400. A build log cannot fill the
panel or the phone chip.

**Narrow widths reuse the one overlay.** There is no room for a canvas beside
the conversation on a phone, so the existing chip above the composer carries
the same line and opens the existing right-panel drawer, which is already a
full-width sheet at that width. No second overlay is introduced.

## Consequences

The canvas says something true and changing for the whole of a build, and a
refused publish is visible where the person is looking rather than only in the
Bot's answer. The cost is that two of the signals are inferred rather than
told: a shell command is identified by the shape of its output, and a step
that produces no recognised output leaves the line where it was. If the
`applet` CLI's output changes, the recognition loosens rather than lies — the
panel falls back to the previous stage and the source view, which is what it
showed before this decision. Should the Applet authority ever record real
build outcomes, `appletProgressV1` already reads them and they take precedence
over nothing: they are simply one more input to the same projection.
