# Jev supervision build plan

## Outcome

FrockBot uses a fast conversational model at one fixed reasoning level. Jev
supervises every Bot Turn and decides when the Bot needs a specialist subagent.
The conversational model remains the Bot's voice; specialists perform slower
planning, research, coding, criticism and recovery work behind it.

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
- Specialist profiles pair a model with instructions, tool reach and a budget.
  Profiles express durable capabilities such as planning or code diagnosis;
  provider model names remain deployment configuration.
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
- Repeated bad proposals accumulate weighted failure signals with decay. At a
  calibrated threshold, Jev requires a Mentor specialist. The fast model keeps
  authorship after receiving the Mentor's advice and remains bounded by the
  existing step and Turn deadlines.
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
effect admission, telemetry and failure scoring are implementation details
behind this seam.

## Runtime flow

```text
Input admitted durably
        |
        v
TurnSupervisor.startTurn            (request hook, step 1, recorded once)
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
        |             a withheld finish still ends the Turn
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

Reuse the existing durable subagent runtime, concurrency limits, one-level depth,
model pinning and per-role tool ceilings in `app/subagents`.

Add a deployment-owned profile catalog:

```ts
interface SpecialistProfile {
  id: string;
  capabilities: SpecialistCapability[];
  model: ModelBindingSnapshot;
  role: SubagentRoleV1;
  instructions: string;
  budget: SpecialistBudget;
}
```

The initial profiles are planner, researcher, coder, critic and Mentor. Multiple
profiles may use different providers and models. Jev judges needed capabilities
against the eligible profiles; code enforces availability, budget and maximum
fan-out.

The conversational model supplies the concrete, self-contained assignment
because Jev does not generate prose. Review verifies that the assignment matches
the User's request and the profile Jev selected. Specialist results return to the
conversational model; specialists do not normally speak directly to the User.

Every specialist Turn is supervised. A specialist's mutating call crosses the
same approval path as a call proposed by the main Bot.

## Mentor and failure score

Step review produces independently meaningful failure signals such as:

- wrong objective;
- unauthorized mutation;
- unsupported claim about an effect;
- ignored supervisor feedback;
- repeated invalid tool arguments;
- failure to use a required specialist.

Code assigns weights, applies decay and compares the accumulated score with a
calibrated Mentor threshold. Infrastructure failures and missing User authority
have separate routes and do not masquerade as reasoning failures.

At the threshold, the supervisor requires the Mentor profile. The Mentor receives
the objective, proposals, rejection evidence and tool outcomes, then returns
advice. The fast model authors the repaired response. Existing maximum steps and
the Turn deadline prevent an infinite retry loop.

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
`bun run eval:response-review` and `bun run eval:call-review`; each reads
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
- Mentor scoring, decay and infrastructure exclusions;
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

- Add the profile catalog over the existing subagent runtime.
- Have Jev select required capabilities and eligible profiles.
- Constrain dispatch to the chosen profile while the main model supplies the
  assignment.
- Start with one specialist per route, then enable bounded parallel selection
  when labeled cases justify it.

### 6. Mentor and continuation

- Add weighted failure signals, decay and the Mentor threshold.
- Feed Mentor advice back to the fast model.
- Add bounded continuation candidates and final-step classification.
- Inject open continuation state into the next Turn.

### 7. Plugin judgment binding

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
