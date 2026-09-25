# Jev supervision build plan

## Outcome

FrockBot uses a fast conversational model at one fixed reasoning level. Jev
supervises every Bot Turn and decides when the Bot needs a specialist subagent.
The conversational model remains the Bot's voice; specialists perform writing,
coding, thinking and vision work behind it.

Jev is a hard runtime dependency. If supervision is unavailable, no Bot Turn,
scheduled Turn, subagent or tool call runs. There is no unsupervised fallback.
Conversation history and settings may remain readable while agent execution is
unavailable.

The first enforced behavior is plan step 4: the start-of-Turn judgment with
acknowledgement steering, whole-response alignment, and review of each text
send. It is enforced rather than shadowed, even below the eval gate, so it is
tuned in use; every decision is a session event, inspectable per Turn through
`/api/debug`, and a withheld send is an audit row. Approval of mutating calls
(steps 2 and 3) is enforced the same way for calls from outside the
deployment. Specialist routing, Mentor escalation and continuation state are
built against the same interface.

## Product decisions

- The main Bot uses one fixed reasoning level. There is no automatic reasoning
  effort selection.
- Jev decides whether specialist help is required. A weak conversational model
  is not trusted to identify all of its own blind spots.
- A specialist is a named capability (writing, coding, thinking, vision)
  backed by a deployment-configured model; provider model names remain
  deployment configuration (see Specialist subagents).
- One Jev request assesses an admitted Turn before its first conversational
  model call. One Jev request reviews each complete model response that calls
  tools, for whether it works on what was asked. One more reviews each text
  send right before it runs, with everything the Turn has already shown, for
  whether the person would miss it: what makes a message redundant is often a
  result that landed earlier in the same step.
- A rejected tool call is a normal model-visible result with a reason. It does
  not throw and does not fail unrelated calls from the same response.
- Whole-response review may withhold the complete proposal when the Bot pursues
  work the User did not request.
- The Bot asks for missing permission in ordinary conversation. This works in
  text and voice and needs no new approval card.
- Policies are durable. Per-Bot User policy outranks global User policy; both
  outrank overridable platform defaults. Locked platform policy always wins.
- The Bot may propose a policy change through a tool. That mutation is reviewed
  against the same existing policy and User evidence as every other mutation.
- A long Turn that stops getting anywhere is told to change course and offered
  the Mentor specialist (see Loop health and claims). The fast model keeps
  authorship and remains bounded by the existing step and Turn deadlines.
- Continuation state contains bounded candidates and evidence references, not
  prose invented by Jev.
- A mutating call is allowed only when review finds User authorization and
  `argumentsMatch.noul` is at least the labeled yes cutoff
  (`TOOL_APPROVAL_NOUL_YES_V1`). A value between the no and yes cutoffs is not
  a yes. The adapter passes authorization evidence through as-is and never
  invents a User message from the Turn objective.

## Ownership and extension shape

Supervision is a Package selected by the deployment at build time. It is not a
User-installable or per-Bot Plugin and cannot be switched off. The default
hosted adapter uses Jev. Another product may provide another adapter without
changing the agent loop.

Plugins may separately receive a metered judgment binding when granted one.
That binding lets Plugin authors ask bounded semantic questions, but it cannot
approve the Plugin's own effects, change locked policy or bypass mandatory Turn
supervision. The TypeSafe credential remains server-side. The hosted adapter
reads `JEV_API_KEY` only; the key never leaves the chooser.

The app owns the interface:

```ts
interface TurnSupervisor {
  startTurn(
    evidence: TurnStartEvidence,
    signal?: AbortSignal,
  ): Promise<TurnDirective>;

  reviewStep(
    evidence: StepProposalEvidence,
    signal?: AbortSignal,
  ): Promise<StepDecision>;
}
```

The Jev adapter, deterministic policy composition, retry ownership, durable
effect admission, telemetry and loop detection are implementation details
behind this seam.

## Runtime flow

```text
Input admitted durably
        |
        v
TurnSupervisor.startTurn            (request hook, step 1, recorded once)
TurnSupervisor.reviewProgress       (request hook, from step 5, recorded)
        |
        v
Fast conversational model
        |
        v
Complete proposal: private text + tool calls
        |
        v
TurnSupervisor.reviewStep           (reviewResponse hook, recorded per step)
        |
        +--> off task: refuse every call but the Bot speaking
        |
        v
Each call, in order                 (prepareTool hook, outermost)
        |
        +--> a text send: TurnSupervisor.reviewSend, recorded per send
        |        +--> release: the send runs
        |        +--> withhold: never delivered, draft cleared, audited;
        |             a finish withheld as redundant still ends the Turn
        +--> a mutate call: TurnSupervisor.reviewCall, recorded per call
        |        +--> allow: the call runs
        |        +--> reject: never runs, the model is told to ask the
        |             person, audited
        +--> any other call runs
        |
        v
Next model step or Turn settlement
```

`app/supervision/loop.ts` mounts this first on every Turn, so its hooks are
outermost: no Plugin hook sees a call it refused, and nothing after it reopens
a Turn it ended. A Bot's visible words are its `send_to_user` and
`reply_to_request` calls; assistant text is private. `reply_to_request` is
never withheld, because a caller is waiting for it. Reply drafts stream while
the model writes; a withheld send's draft is cleared.

### Start-of-Turn judgment

`startTurn` receives a bounded evidence object:

- the admitted input and its origin;
- effective locked, Bot, global User and platform-default policies;
- explicit User authorization relevant to this Turn;
- unresolved continuation items and their evidence references;
- recent conversation evidence needed to interpret the current request;
- eligible specialist profiles;
- prior failure and Mentor state.

It returns typed decisions for acknowledgement, task complexity, consequence,
ambiguity, specialist capability and any mandatory steering. Jev does not write
the acknowledgement or the specialist assignment. Code renders bounded steering
from the typed decisions, and the conversational model writes in the Bot's own
voice.

Long-lived preferences never depend on a conversation window. They are read
from durable policy. When authorization exists only in old conversation text and
is not available as evidence, the safe result is to ask again rather than infer
permission.

### Step review

`reviewStep` receives:

- the original Turn objective and start directive;
- the complete proposed text and tool calls;
- the exact arguments and host-owned effect classification of every call;
- effective policy and relevant explicit User evidence;
- tool results and specialist advice already produced in this Turn;
- current weighted failure state;
- bounded continuation candidates on a potentially final step.

It returns:

```ts
interface StepDecision {
  text: "release" | "withhold";
  calls: Array<{
    callId: string;
    decision: "allow" | "reject";
    reasonCode: SupervisionReasonCode;
    policyRefs: string[];
  }>;
  responseAlignment: "on-task" | "repair" | "wrong-objective";
  failureSignals: FailureSignal[];
  continuation: ContinuationDecision[];
}
```

Jev supplies narrow Choice, Noul and Score judgments. Trusted code applies
thresholds, vetoes, precedence and arithmetic. User-facing rejection text is
rendered from reason codes and policy references rather than generated by Jev.

### Rejection behavior

Each rejected call receives a durable result equivalent to:

```json
{
  "status": "rejected",
  "reason": "No authorization was found for sending this email.",
  "needed": "Ask the User for permission."
}
```

The result is not an exception. The next model step sees it and can revise the
plan, ask the User or continue with allowed work. Text may be released only when
review says it neither claims nor depends on a rejected effect.

A whole-response rejection withholds its text, rejects its calls and injects a
first-class supervisor feedback record into the next model request. It is never
represented as a User message.

## Tool effects

Host-owned effect metadata on registered tools
(`core/contracts/tool-execution.ts`):

```ts
type ToolEffectV1 = "read" | "mutate";
```

- `mutate` is code from outside the deployment acting on the world: a Plugin
  a User installed or a Bot wrote, a remote MCP server, a connected app. Every
  such call needs a positive review decision, made right before it runs.
- `read` is everything a review would only slow down: reads, changes the
  person can see and undo inside FrockBot, work on the Bot's own Computer, and
  first-party effects that carry their own human gate (the approval card for
  the person's machine, an approved email draft, Plugin publishing).
- A native tool that declares nothing is `read`. A namespace that declares
  nothing is `mutate`, and a tool's own declaration wins over its namespace's.
  The registry resolves the effect into the call's `ToolExecutionContext`
  before any hook sees it.
- A Plugin cannot confer `read` on itself: the Plugin host marks a Plugin's
  namespace `read` only when its artifact's content hash is one the
  deployment seeded, and marks its card draws `read` because drawing a card is
  the Bot speaking.
- `orderedEffect` and `idempotent` retain their current meanings; neither is a
  substitute for effect classification.
- A batch's sub-calls are reviewed one by one, as each runs.

## Policy model

The effective policy order is:

1. locked platform policy;
2. per-Bot User policy;
3. global User policy;
4. overridable platform defaults.

Code resolves conflicts in that order before Jev is called. Jev interprets
whether the proposed action matches the resulting policy and supplied User
evidence; it does not decide precedence.

Global policy is authoritative in the User Durable Object. Bot policy is
authoritative in the Bot Durable Object. An admitted Turn receives an immutable
policy snapshot or generation reference so replay and recovery review the same
rules.

Policy tools support list, add, replace and remove. A request such as "yes, send
it" authorizes the pending occurrence without creating a durable policy. A
request such as "always send these weekly reports" may support a policy mutation
when its scope is unambiguous. The policy tool itself is a mutation and is
reviewed under the policy snapshot that existed before it ran.

## Acknowledgement steering

The initial silence target is two seconds. This is measured as a product latency
objective, not claimed as a hard guarantee.

When `startTurn` requires acknowledgement, the first conversational-model step
is steered to produce a short acknowledgement and the tool or specialist call
that begins the work. The main model supplies the words. Jev only judges whether
the Turn should acknowledge before doing longer work and later checks whether
the directive was followed.

The steering is a labeled runtime note at the tail of the first request only.
It never touches the system prompt or the tool list: those are the cached
prefix, and a note that changed them per Turn would miss the cache on the
whole history. The same rule holds for every later Jev use: supervision appends
at the tail, or answers through a tool result, and never edits the prefix.

This keeps acknowledgement behavior identical over text and voice.

## Specialist subagents

The main model stays fixed per Bot, so its prompt cache holds; other models'
strengths come in through subagents. A specialist is a Frock AI model id —
`@frock/writing`, `@frock/coding`, `@frock/thinking`, `@frock/vision`
(`FROCK_AI_SPECIALTIES_V1`, `providers/frock-ai/catalog.ts`) — backed by an AI
Gateway dynamic route (`frock-writing` and so on) whose target model is chosen
in the dashboard, the way Auto's is. Nobody picks a specialist as a Bot's own
model.

- A Bot on Frock AI is offered each specialist whose route the deployment
  prices (docs/billing.md), in `<available_subagent_models>` with its specialty
  and what it is for. An unpriced route is never offered, so an unconfigured
  specialist is never called. Automation and subagent Turns are offered none.
- A `Task` names the specialist's slug; the child Turn runs on the model its
  task pinned, read off the task record, when that model is on the Bot's own
  connection.
- The start-of-Turn judgment names the specialty the work most needs, from
  the same names. When the Turn is offered it, the first request's tail note
  hands the work over: call `Task` with that model and a complete brief, and
  give the person what it produced as it wrote it. The conversational model
  still writes the brief; Jev does not generate prose.

Every specialist Turn is supervised. A specialist's mutating call crosses the
same approval path as a call proposed by the main Bot.

## Context selection

Jev also chooses what a Turn reads, without touching the cached prefix. Both
are context quality, not safety: a judgment that fails leaves things as they
were, and neither is enforced.

- **Memory recall.** After hybrid recall finds candidates for a Turn, Jev
  judges up to 12 against the request; code drops those below 0.2 and orders
  the rest (`app/supervision/memory-recall.ts`). They land in the existing
  `<memory-recall>` message.
- **Memory writes.** Before a Bot's `memory_write` or a Plugin's
  `ctx.memory.write` stores a fact, recall finds up to five kept facts near
  it in the same scope and Jev judges the fact against them
  (`app/supervision/memory-write.ts`, applied in `executeRecordsWriteV1`). A
  fact holding a secret the credential patterns missed is refused (at 0.7). A
  fact saying what one already says is not written (at 0.8). A newer value
  replaces the kept one through the engine's `replaces`, which supersedes it
  (at 0.7); a fact another writer kept is left standing beside it. A profile
  fact that will not stay true is kept as a log entry (at or below 0.2). The
  model is told each outcome. The legacy Markdown store, with no records
  binding, is not judged.
- **Email triage.** Only the owner's own confirmed mailboxes reach a Turn, so
  triage is not a spam filter. Before an email Turn is admitted, Jev judges
  whether the message asks the Bot anything or only passes something on
  (`app/supervision/email-triage.ts`). A message it is sure only passes
  something on (at 0.8) is `quiet` on its email origin, so the Bot's answer
  lands unread and wakes no device. Labelled in `bun run eval:context`.
- **Browser pages.** After each `computer_browser` action, Jev reads the
  page's address, title and redacted accessibility snapshot and says what it
  is showing (`app/supervision/page-state.ts`). A sign-in wall, CAPTCHA,
  error or page still loading it is sure of (at 0.7) gets a plain line
  above the snapshot, with what to do. A CAPTCHA is handed to the person,
  never solved. The result also names the page's title and address, which it
  used to drop. Labelled in `bun run eval:context`. Jev does not pre-rank
  the elements to act on: clicks resolve by role and name on the live page,
  the snapshot is already the candidate list, and ranking would need the
  Turn's goal, which the tool does not see.
- **Skills.** At the Turn's first request, Jev judges each Skill in a catalog
  of up to 24 against the request, and up to three strong matches are named
  in the tail runtime note (`app/supervision/skill-nomination.ts`). The
  catalog in the system prompt is unchanged.
- **Routine reports.** Before a delivery Turn is opened for a Routine's
  hand-offs, Jev judges each report: did the firing find something the person
  would want to hear, and how soon (`app/supervision/routine-report.ts`). A
  report it is sure nobody needs is dismissed and stays in the Routine's log;
  a delivery whose every report can wait is `quiet` on its run origin, so its
  message lands unread and wakes no device. When Jev cannot say, the report is
  delivered loudly, as before.
- Runtime notes from several features share one trailing message
  (`appendRuntimeNoteV1`), since some providers refuse two user messages in a
  row. Labelled in `bun run eval:context` (17/17 live, with the seven write
  cases; 10/10 on `jev-1.13.0` before they were added).

## Loop health and claims

Built in `app/supervision/loop-health.ts` and `app/supervision/claim-check.ts`.

A long Turn is checked for progress before its model call, from step 5, then
every 4 steps. Code counts what it can: the same call with the same arguments
made 3 times, or 3 failed results in a row. Either is a loop signal, and a
signalled Turn is checked every 2 steps. Jev answers one Noul, whether the
latest calls moved the work toward what was asked. At or below 0.25 the Turn is
stuck; with a loop signal, at or below 0.45. A stuck Turn's request carries a
tail runtime note telling it to stop repeating what failed and to try another
approach. The note offers the thinking specialist (the Mentor) when the Turn is
offered one, or else tells it to say what blocks it and ask the person. Each
check is a `supervision/progress` session event, read back on resume.

Every text send is also checked for its claims, beside the redundancy question
and whatever that question's vetoes say. Jev is shown each call this Turn made,
its tool and whether it failed, and is asked whether the message says something
was done that none of them did. An `unsupported` answer at 0.7 or above
withholds the send with reason `unsupported_claim`. The model is told to do the
thing or say plainly that it is not done. Such a send does not end the Turn,
even as a finish, and the check runs at most once per Turn, so a Turn is
corrected once and never held in a loop.

A weighted failure score with decay was not built. Loop signals and the
per-send claim check cover the cases it was for.

## Continuation state

The final step review classifies bounded candidates drawn from:

- explicit User requests;
- Bot commitments already present in durable messages;
- previously open continuation items;
- tool and specialist outcomes.

Each candidate is classified as open, completed, blocked or obsolete and retains
references to its source evidence. No generated todo prose is required. The open
set becomes a compact prompt section on the next conversational Turn.

## Availability and recovery

The supervisor has no permissive failure mode. Each Jev call is retried once;
a second failure fails the Turn before anything it would have judged runs, and
the person is told the reply failed. `JEV_API_KEY` is a required production
secret; without it no Turn runs. Test harnesses answer through a
supervision-only Jev fake (`app/supervision/testing.ts`).

- The request path does not acknowledge new work as accepted unless its durable
  input admission succeeds.
- If supervision is already known to be unavailable, agent execution answers
  unavailable and starts no Turn.
- If failure occurs after admission, the Turn records a pending supervision
  effect and releases no proposed text or tool call.
- Queued chat, scheduled and subagent work remains durable and resumes after
  recovery under the same effect identity.
- A timeout is an ambiguous paid Jev outcome. It is recorded explicitly and is
  not blindly repeated under a new identity.
- Health, latency and error-rate telemetry drives the product outage state.

The read-only control plane remains available so a User can read conversations
and settings and see why Bots are paused.

## Durable records and observability

Add exact, versioned records for:

- supervision request intent and stable effect identity;
- resolved adapter and Jev model version;
- token usage and latency;
- typed raw judgments retained under the data policy;
- composed directive or decision;
- policy generation and evidence references;
- released, withheld, allowed and rejected outcomes;
- failure-score changes and Mentor dispatch;
- continuation-state replacement.

Do not log the TypeSafe key. Prefer hashes and durable references when raw
conversation or policy content is not needed for diagnosis.

## Evaluation

Keep live evaluation separate from unit tests. Pin the calibrated Jev version.
Run the labeled suites with `bun run eval:turn-start`,
`bun run eval:response-review`, `bun run eval:call-review`,
`bun run eval:plugin-fit` and
`bun run eval:context`; each reads
`JEV_API_KEY` from the main checkout's `.dev.vars` (the runners still accept
`TYPESAFE_API_KEY` as a local alias) and writes traces to `.eval-results/`.
Neither is part of ordinary tests or the pre-push gate.

Evaluation suites cover:

- direct, implied, earlier-Turn and absent authorization;
- global, Bot, default and locked policy conflicts;
- exact tool argument changes after approval;
- mixed batches with one rejected occurrence;
- text that claims or depends on an effect that did not run;
- whole responses pursuing an unrequested objective;
- policy-mutation requests and accidental over-broad policies;
- acknowledgement steering and needless acknowledgements;
- specialist necessity, capability selection and no-match cases;
- stuck and progressing long Turns, with and without loop signals;
- continuation classification;
- adversarial instructions in User text, retrieved content and tool output;
- Jev failure before a Turn, between proposal and release, and during recovery.

Track false mutation allows first, then false rejections, whole-response accuracy,
specialist-routing accuracy, acknowledgement latency, cached input, token cost and
total Turn latency. Thresholds do not move between questions or Jev versions
without rerunning the labeled suite.

## Delivery sequence

Each change leaves production Bots able to reply when Jev is healthy.

### 1. Contracts, adapter and journal

_Done for step 4._ The loop is wired (`app/supervision/loop.ts`).

- _Done._ `TurnSupervisor`, its domain types, a fake adapter, a hard-unavailable
  adapter and the hosted Jev adapter (`core/contracts/turn-supervisor.ts`,
  `app/supervision/`).
- _Done._ Labeled evals and adapter contract tests. Each Node report runner
  lives beside its suite in `app/evals/` so the Worker does not import it.
- _Done._ Production owns `JEV_API_KEY` from the GitHub secret of that name:
  required in `production-secrets.ts`, declared on Worker `Env`, and carried
  by the release and staging deploys.
- Add durable supervision effects and usage records.
- Buffer private model proposals until review.
- _Done._ The hard unavailable state: one retry, then the Turn fails. A resumed
  Turn reads recorded decisions back rather than asking again.

### 2. Tool classification and policy storage

- _Done._ Trusted `read`/`mutate` metadata with conservative defaults (see
  Tool effects).
- Add platform, global User and per-Bot policy stores and deterministic
  precedence. Until they exist every Turn is reviewed under an empty policy
  snapshot, and the call questions carry no policy judgment.
- Pin the effective policy generation on admitted Turns.
- Add supervised policy-management tools.

### 3. Enforced mutation review

_Done, enforced._

- Each `mutate` call is reviewed right before it runs
  (`TurnSupervisor.reviewCall`, `app/supervision/call-review.ts`), with the
  conversation, the Turn's own requests and its results so far. A labeled
  suite of 16 cases (`bun run eval:call-review`, 16/16 on `jev-1.13.0`).
- Code allows a call the person asked for, or gave lasting permission for,
  whose particulars match; and a step their request plainly needs only while
  it reaches nobody outside FrockBot. Text trying to direct the review
  authorizes nothing.
- A refused call is a tool result the model reads, telling it to ask the
  person in conversation; it never runs. Each decision is a `supervision/call`
  session event, and a refused call an audit row.

### 4. Whole-response review and acknowledgement

_Done, enforced._

- The start-of-Turn questions and their thresholds
  (`app/supervision/turn-start.ts`), with a labeled suite of 29 cases
  (`bun run eval:turn-start`, 29/29 on `jev-1.13.0`), steer an acknowledgement
  from the tail of the first request.
- Whole-response alignment and per-send redundancy
  (`app/supervision/response-review.ts`), with a labeled suite of 23 cases
  (`bun run eval:response-review`, 23/23 on `jev-1.13.0`). Every threshold and
  veto lives in that file.
- Every decision is a `supervision/turn-start`, `supervision/step` or
  `supervision/send` session event; a withheld send is a `supervision` audit
  row with the words it would have said.
- Still to do: measure the two-second acknowledgement target.

### 5. Specialist profiles and routing

- _Done._ Four specialists on Frock AI routes, offered once priced; a child
  runs on its task's pinned model; the start-of-Turn judgment names the
  specialty (`bun run eval:turn-start`, 32/32 on `jev-1.13.0`) and the tail
  note hands the work over.
- _Done._ Faithful relay: when a subagent's work is in the Turn — a blocking
  `Task` result, or the completion a Turn was opened for — each send is first
  asked whether the person wanted the words themselves and whether it gives
  them as written. A condensed or reworded version is withheld with feedback,
  and the Turn goes on to send the work; a change the person asked for
  ("make it punchier") passes, and a Turn withholds a rewrite at most once.
- _Done._ `task_ask`: a subagent hands its parent one question and ends its
  Turn; the parent's notice says to answer with `task_resume`. When a Turn
  opens on such a question, Jev judges whether what the person already said
  answers it or only the person can, recorded as `supervision/question`, and
  the tail note steers the Turn accordingly (`bun run eval:response-review`,
  33/33 on `jev-1.13.0` before the `toast-made-punchier` case was added; that
  case has not yet been run live).

### 6. Mentor and continuation

- Built: loop health and the per-send claim check (see Loop health and
  claims); the thinking specialist is the Mentor a stuck Turn is offered.
- Add bounded continuation candidates and final-step classification.
- Inject open continuation state into the next Turn.

### 7. Plugin judgment binding

- Built: the Plugin authoring check. Before the User is asked to run a
  Plugin the Bot wrote, code lints its source for what the SDK documents: a
  page must style with the `--frockbot-*` theme variables and load nothing
  from the network, and cloud code must name only hosts `plugin.json`
  declares. `plugin_check` reports the lint to the Bot. `plugin_publish` takes
  the Bot's `purpose`. Jev (`app/supervision/plugin-fit.ts`) judges whether
  the Plugin is built for what the person asked this Turn, and which of its
  parts (tools, hooks, grants, hosts, device abilities) nothing asked for
  needs. The check is advisory and runs once per new card. What it finds ends
  the approval card's rationale under "Before you approve" and goes back to
  the Bot. Jev failing leaves the lint alone. Labelled in
  `bun run eval:plugin-fit`.
- Add a named grant and loopback binding for metered Plugin judgments.
- Attribute spend and calls to the Plugin, Bot and Turn.
- Enforce quotas, data bounds and the prohibition on self-approval.
- Add a second `TurnSupervisor` adapter contract test to prove the build-time
  seam is genuinely swappable.

## Release gates

Mutation enforcement is ready when no mutating call can dispatch without a
durable positive decision, rejected calls reliably lead to conversational repair,
policy precedence is deterministic, replay cannot change the reviewed call, and
every Jev failure mode stops execution.

The later shadow features are enabled individually only when their labeled evals
meet consequence-appropriate thresholds. Shadow mode is temporary deployment
configuration, not a permanent User-facing flag. Once a feature enforces, delete
its shadow-only path.
