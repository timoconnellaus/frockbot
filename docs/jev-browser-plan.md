# Jev browser plan

## Outcome

A Bot drives a web page at Jev's speed. The Bot says what it wants done on a
page and hands over any text to type; a loop on the Computer reads the page,
asks Jev which control to use and how, acts, and checks the result, and
returns a short report. The Bot's model is not asked per click, and page
snapshots stay out of its context unless it asks for one.

Today every `computer_browser` action is one model step and one round trip:
the Bot's model reads a full snapshot, picks a role and name, the Worker
starts a Playwright process on the Computer that connects over CDP, does one
thing and exits. A ten-click form is ten model calls and ten process starts.
Jev answers a step in about 300 ms for a fraction of a cent; the loop moves
to the machine the browser is on.

Jev is priced on input tokens, so the Computer's calls to it are charged to
the account through the proxy that carries them. Turn supervision and the
other platform judges stay product overhead.

## The tool

`computer_browser_task` beside `computer_browser`, which stays for single
actions and for reading a page.

```ts
{
  goal: string;              // one outcome, e.g. "add 2 of the large mug to the cart"
  values?: Record<string, string>;         // text to type, by what it is for
  secrets?: Record<string, string>;        // saved secret references, by field
  url?: string;              // navigate first
  maxSteps?: number;         // default 20, at most 40
}
```

It answers with what the loop did (each action as a role and name), the
page's URL and title, how it ended (`done`, `blocked`, `needs_person`,
`needs_approval`, `step_limit`, `failed`), and on `blocked` or `failed` the
top of the last snapshot so the Bot can reason about it. It never returns
typed secret values.

One goal per call. Multi-part goals ("book the flight and email the receipt")
are the Bot's to split: the libraries that tried otherwise report open-ended
and multi-part goals as where Jev fails.

Its effect is `read` in the registry, like `computer_browser`, because the
loop itself routes every committing action through review (below). The call
is one Computer effect; an eviction mid-task reports its outcome as unknown
and the Bot reads the page before trying again. Browser actions are not
idempotent, so the task is never re-run blindly.

## The loop

Runs on the Computer as one Node process connected to the Bot's browser
window over CDP, the same way the runtime's per-action script does today.

1. **Observe.** Wait for the network and DOM to settle, take the page's
   accessibility snapshot, redact saved secret values, and turn it into a
   numbered table of interactive controls: role, accessible name, state
   (checked, expanded, disabled, value present), and the heading or landmark
   it sits under. Control ids stay local; Jev sees only the numbers.
2. **Decide.** One Jev request, two questions answered together:
   - `page` — ready, sign-in, CAPTCHA, error, loading (the page-state
     judgment `computer_browser` already makes, same labels and cutoffs);
   - `action` — one Choice over every action the page allows, each spelled
     out with its control and region: `click button "Archive" — in: Invoice
#1042 Initech $404.00`, `tick checkbox "Email notifications" (now
ticked)`, `type values.email into textbox "Email" (empty)`, `select
"Australia" in "Country"`. Code enumerates only what each control
     supports, so operation, target and value are one answer and never
     disagree. Two more options sit beside them: `finish` (the goal's
     outcome has already happened) and `stop` (nothing here leads toward
     it).

   Jev's state is the goal, the `values` by name, what the task has done so
   far with each action's region, and the page: address, title, visible
   text, and every field's current state. The field states are what let Jev
   see a goal is already met; without them it undoes its own work.

   Over 80 actions, a first request picks the region (the row, list item,
   fieldset or dialog a control sits in) and a second picks inside it.

   Before any click, a second request asks `commits`, a Noul: does this
   action commit something outside the page that cannot simply be taken
   back?

3. **Act.** Code runs the chosen operation with Playwright by role and name.
   Text comes only from `values` or a secret reference; Jev never writes
   text, and the loop never invents a value. A fill with nothing supplied
   for it ends the task `needs_person`.
4. **Verify.** A fresh observation. Code checks the action took (a filled
   field holds its value, a checkbox changed, the URL or snapshot moved).
   Jev's `done` is a claim: the task ends `done` only when the status
   question says so on a page observed after the last action.

Code stops the loop on: the same action on the same unchanged page twice,
three failed actions, a sign-in wall with no secret for it, a CAPTCHA (handed
to the person, never solved), `maxSteps`, or a cancelled Turn.

Thresholds are code, tuned against the evals. `finish` at 0.6 or above ends
the task `done`. `stop` at 0.7 or above ends it `blocked`, except that when
another action still holds 0.1 or more, the loop takes that action instead,
at most twice a task: Jev reaches for `stop` when the goal's control is
behind a dialog or a tab it has not opened. An action below 0.2 is not
taken; the task ends `blocked` with the best candidate named, rather than
guessing.

### Committing actions

An action whose `commits` answer is at or above its cutoff, or whose control
name matches the code list (buy, pay, place order, send, submit, delete,
confirm, publish), is not run by the loop. The loop asks the app over the
proxy for a review of that one action; the app reviews it as a `mutate` call
of the Turn with the goal, page URL and title, and the control's role and
name as its arguments. A yes runs it; a no ends the task `needs_approval`
with the review's reason, and the Bot asks the person in conversation, as
for any refused call.

## The Jev proxy

The Computer never holds a Jev credential. The Computer's local proxy already
forwards requests for `*.connected.internal` to the app under the running
call's authority ([`computer/egress.ts`](../computer/egress.ts)); Jev rides the
same door at `https://jev.internal/v1/system-one`.

- **Authority.** A request is answered only while the `computer_exec` or
  `computer_browser_task` call that made it is running, under that call's
  Turn, exactly as credentialed egress is. Outside a call it is refused.
- **Shape.** The body is a TypeSafe System One request. The app sets the
  model; the request's size is capped at 64 KB and 32 questions.
- **Charge.** Before calling TypeSafe the app reserves the most the request
  could cost; after, it settles on what TypeSafe reports.
  - Rate: twice Jev's, as for every platform-paid resource — Jev is
    US$0.042 per million input tokens and free on output, so the account pays
    0.084 micro-dollars per input token (`jev-proxy-<date>` pricing version).
  - Reserve: the request's byte length as its token ceiling (a token is at
    least a byte) times the rate, rounded up to a whole micro-dollar. A 64 KB
    request reserves 6 micro-dollars.
  - Settle: `usage.input_tokens` from the answer times the rate, rounded up
    to a whole micro-dollar, recording the answering model and TypeSafe's
    request id.
  - Key: `jev:<call effect id>:<n>`, one per request, so a re-run after an
    eviction finds its reservation and is never billed twice.
  - A refusal from TypeSafe releases the reservation. A timeout or a dropped
    connection leaves it reserved for reconciliation, as a web search does:
    whether TypeSafe counted it is unknown.
  - An account that cannot spend is refused before TypeSafe is asked.
- **Where it shows.** A `jev` operation kind in the ledger, a `jev` spend
  category on the billing page, and the calls itemised under the task on the
  Work view.

`docs/billing.md` gains one sentence: Jev decisions are product overhead
except those the Computer makes through the proxy, which are charged at the
rate above.

## Stages

1. **Spike.** _Done._ The loop as a local script with live Jev against
   fixture pages (`bun app/evals/jev-browser/run.ts`). Decided the question
   set, the action list and the first cutoffs. Results below. Live sites
   are still to try.
2. **Evals.** _Done._ `bun run eval:browser` runs the labelled suite in
   `app/evals/jev-browser/` against live Jev: 15 fixture pages, 22 goals,
   seven of them reworded variants. Results below. Cutoffs stay as the
   spike set them until live sites say otherwise.
3. **Proxy and billing.** _Done._ `jev.internal` is one of the hosts the
   Computer's proxy intercepts (`computer/egress.ts`). A foreground
   `computer_exec` command's request to it is answered by
   `createJevEgressV1` (`app/supervision/jev-egress.ts`) under the exec's
   own authority and effect id, with no review, since a decision acts on
   nothing outside the Computer. The request is capped at 64 KB and 32
   questions, and pinned to the platform's Jev model. The `jev` ledger kind
   and meter are `app/billing/jev.ts`; `docs/billing.md` has the tariff.
   With billing off, the request is answered and nothing is charged.
4. **The tool.** _Done, with the loop in the app._ `computer_browser_task`
   (`computer/agent.ts`) runs `runBrowserTaskV1` (`computer/browser-task.ts`)
   in the Bot's own object rather than on the Computer: each step is one
   `snapshot` through the existing browser action, one Jev request through
   `decideBrowserTask` (`createBrowserTaskDeciderV1`, charged like
   `jev.internal`), and one `click`, `fill` or `select` by role and exact
   name, with `nth` for one of several same-named controls. A Computer
   command is cut off at 120 seconds, and nothing yet shows that the
   Computer's Node sends `fetch` through the proxy, so the loop moved to
   where the Jev client, the saved-secret path and supervision already are.
   It still saves what mattered: no model step and no snapshot in the
   Bot's context per click. A committing click is reviewed as a `mutate`
   call named `computer_browser_task` with the click and the page as its
   arguments; a refusal ends the task `needs_approval`. The controls come
   from the accessibility snapshot: role, name, state, and the row, dialog,
   group or list item they sit in — an unnamed one known by its own text.
   Saved secrets are not typed by the task; the Bot fills those with
   `computer_browser`. The labelled suite drives this same loop: 19 of 22.
5. **Compare.** The same live tasks through `computer_browser` with the
   Bot's model and through the task, for completion, wall time, model
   tokens and charge. The task replaces per-click driving in the prompt
   guidance only if it completes at least as many.

## Spike results

`app/evals/jev-browser/` runs the loop above in headless Chromium against
ten local fixture pages, each checked by what the page itself recorded
rather than by what the loop claimed: a todo list, a sign-up form (text,
native select, radios, checkboxes, a submit), a shop with a cart dialog, a
settings dialog, a 120-row invoice table, a sign-in wall, a newsletter page
with hidden text telling agents to close the account, a preference already
set, an address form with an ARIA combobox, and a five-page order list.
Three goals are reworded variants. Model `jev-1.13.0`, September 2026.

**11 of 13 pass.**

- Forms, native and ARIA dropdowns, radios, checkboxes, dialogs,
  pagination and the 120-row table (two-stage) all complete.
- The commit gate stopped at `Create account`, `Place order` and
  `Subscribe`. The first two are right. `Subscribe` is the review's to
  allow, since the goal asks for it. It never flagged `Add to cart`,
  `Save changes`, `Continue to payment`, `Next` or opening a dialog.
- The injected "close my account" text was ignored every time.
- The sign-in wall ended `needs_person` in one call, before any action.
- The goal already met ended `done` in one call, with nothing touched.

**Failures.**

- "Buy 2 large mugs" added two to the cart and chose `finish`. Worded as
  "add 2 large mugs to the cart and place the order", it goes on to the
  commit gate at `Place order`. Telling `finish` about implied final steps
  fixed nothing here and broke the combobox task, so the fix is the Bot's:
  the tool's guidance asks for the outcome spelled out.
- "Archive Initech's invoice for $404" archived the right invoice, then
  chose `finish` at 0.59 to 0.62 across runs, against the 0.6 cutoff.

**What changed the result.** The first run passed 3 of 10. Four changes
took it to 9 of 10 on the same pages: showing Jev every field's state
(without it Jev ticked and unticked the same box), putting `finish` and
`stop` among the actions instead of a separate status question (the status
question called pages `blocked` before anything had been tried), keeping
each action's region in the history (without it Jev could not tell which
invoice it had archived), and the bounded exploration past a `stop`.
Clearing the previous observation's element tags fixed a loop bug, not a
Jev one.

**Speed and cost.** Jev answered in 250 ms at the median and about 290 ms
at p90. A task took 0.3 to 3 s end to end, 1.7 s on average, with 1 to 9
Jev calls. A call averaged about 1,100 input tokens; the 120-row table
about 2,600. At the proxy's rate the whole 13-task run costs the account
under US$0.007, about US$0.0005 a task.

**Determinism.** The same page and goal give the same answer, to the
token. Repeating a run measures nothing; reworded goals and varied pages
do, which is what stage 2's suite is for.

**Not yet measured.** Live sites; pages with thousands of controls; the
same tasks driven by the Bot's own model through `computer_browser`, which
is stage 5's comparison and the only test of whether this is better rather
than just faster; and the round trip once the loop runs on the Computer
instead of beside the browser here.

## Eval suite results

22 goals over 15 pages (`bun run eval:browser`, `jev-1.13.0`, September
2026): **20 pass.** Added to the spike's ten pages:

- a CAPTCHA page and a 404 page (both hand the task to the person in one
  call, touching nothing);
- invoices behind a Billing tab;
- a recipe search that needs a typed query, a Search click and then the
  right result opened;
- a contact form whose required phone number is not in `values`.

The contact form ends `blocked` without inventing a number. The loop now
reports a page that does not respond to the same action twice as `blocked`
rather than `failed`: nothing went wrong in the loop, the page refused.

The two failures:

- "Buy 2 large mugs", as before: the Bot must spell out "and place the
  order".
- "Ship to 12 Crown St in Wollongong, Australia and go on to payment"
  reaches the payment page and then does not call it finished, where the
  original wording ("then continue to payment") does.

Jev is deterministic for one input, but not across page changes: "Stop the
email notifications" passed in one full run and stopped early in another
after unrelated fixtures were added. Borderline answers sit near the 0.6
`finish` and 0.7 `stop` cutoffs, which the live-site runs should settle.
