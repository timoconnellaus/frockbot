# Handoff: capability gaps session

This comes from the cloud session `session_01QJq3nsmLo41b6iU5JrzyhJ`, handed to a local session on 2026-09-25 at Tim's request. It says what was asked, what shipped, what is half-done and where it lives, the decisions that are still open, and what the session learned about Jev.

## What was asked

Tim asked which obvious capabilities FrockBot lacks compared with other agents, then picked items 1–4, 6–8, 10–13, 16 and 17 to build. Each item was built by a subagent on its own `claude/charming-maxwell-r6nxhq-*` branch and PR. The babysitter merges; this session only got PRs green. Later, Tim asked for:

- email both ways, with memorable addresses;
- removing the Bot label;
- replies to an email going back by email, with no chat narration;
- Jev switched **on** rather than in shadow, so he can tune it while he uses FrockBot;
- then Jev plan steps 2 and 3.

## Shipped (merged to main)

| PR               | What                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| #802             | Billing by the served model, from a versioned rate table held in DeploymentPolicy                                                                 |
| #806, #819, #823 | Remote MCP servers, MCP OAuth sign-in, and the sign-in bound to the User who started it (with grant revocation on account deletion)               |
| #807             | Replies stream live                                                                                                                               |
| #808             | Delete an account or its Computer                                                                                                                 |
| #809             | Files and photos in a message (vision)                                                                                                            |
| #812             | Brave web search, billed per search                                                                                                               |
| #814, #821       | iPhone client first slice; a consent page before native sign-in issues a code                                                                     |
| #820 → #827      | Telegram, reverted by Tim in another session                                                                                                      |
| #824             | Teach a Bot by demonstration (Computer recorder to Skill)                                                                                         |
| #825             | Collect a secret and fill it by reference. The remaining limit is issue #830: a Bot running code on its own Computer can read a filled field back |
| #826             | Email to and from a Bot (#803 folded in)                                                                                                          |
| #837             | Remove the Bot label                                                                                                                              |

## Open or half-done

- **#818: update or reset the Computer, keeping browser sign-ins.** Branch `claude/charming-maxwell-r6nxhq-browser-logins`, labelled `hold`. Tim is running `bun run --filter @frockbot/computer-host test:live` against a real Sprite. It conflicts with main (with #824's recorder); the babysitter owns that.
- **Email replies by email, plus an email-thread card.** Branch `claude/charming-maxwell-r6nxhq-email-thread`, WIP, no PR. See "Email thread work" below.
- **Jev on.** Branch `claude/charming-maxwell-r6nxhq-jev-on`, WIP, no PR. See "Jev" below.
- **Jev plan steps 2 and 3** (tool read/mutate catalog, then enforced mutation approval). Tim approved these, to follow the Jev-on PR. Not started.
- **iOS.** Commit `695a4df3` ("Commit the iPhone Runner's CocoaPods integration") exists only in this cloud container's worktree, on the local `claude/charming-maxwell-r6nxhq-ios`. It was never pushed, and it is lost when the container goes. The iOS release job and Apple setup (associated domains / `webcredentials`) are not done.
- **Smaller follow-ups:**
  - Composio sends as editable drafts (item 10, part 3).
  - Prune Computer command records; the control heartbeat from #824 adds two every 30 s.
  - Rerun `chat.e2e.ts` on a quiet machine (a possible slowdown from #807).
  - The flaky timing test `core/agent-loop/batch.test.ts`.
  - A known-issues entry for Composio Connect's sign-in-link weakness: a Connect link sent to someone else connects their app to the sender.

## Email thread work (WIP)

**The goal (agreed with Tim).**

- An email Turn answers by email, with no chat message. It posts in chat only when it draws an app-only card, or when the email can't be sent.
- The Bot's instructions tell it not to narrate an `email_owner` send in chat.
- A centred, expandable email-thread card in the transcript, like `_VoiceCallAccordion`, replaces both the "via email" bubble and the "Emailed you" receipt.

**Where it stands.** Branch `claude/charming-maxwell-r6nxhq-email-thread`, one WIP commit `e35e4c8d`, pushed with `--no-verify`. **It does not typecheck yet.**

**Design as built.**

- An email Turn answers through `reply_to_request` (voice's tool) with a new `"email"` caller, not by diverting `send_to_user`.
- The channel is chosen once per Turn by `replyChannelOfOriginV1(origin)` in `app/shell/reply-to-caller.ts`. `turn.ts` sets `replyByEmail` from it, and `runtime-mount.ts` mounts the new seam `emailReply` (added in `backend-runtime.ts` and `app/runtime.ts`).
- That seam registers the tool and a prompt section from `app/shell/email-reply.ts`. The send happens in `emailReplyDelivererV1`, from the reply tool's `execute`, so a reply Jev withholds is never sent.
- The send itself is `sendEmailReplyV1` → `sendOwnerMailV1` in the new `app/email/bot.ts`, which the owner-note path also now uses. Both share the once-per-key claim (key `email-reply\0<runId>\0<occurrenceId>`) and the 20-a-day cap.
- If the email can't be sent, the answer goes to chat with "(Not sent by email: …)". If the Turn drew a card, the email gets "There's something waiting for you in FrockBot." An email Turn sends at most one reply.
- **Stored shape change.** The email origin is now `{kind, messageId, from, subject, threadId?}`, with an `email:thread:<sha(id)>` index. Existing `run:em-*` records, from Tim's test emails, **will not decode**, so they need a receipted cleanup. The plan was to drop their origin.
- **Wire, server side.** `reply/to-caller` accepts `"email"`. Runs carry `emails[]` from the new `app/email/thread.ts`, and `runsForProtocolV1` (protocol 5) strips both for older clients.

**Not done.**

- Make typecheck pass, and fix `email/inbound.test.ts` and `run-protocol.test.ts`.
- Route `user-application.ts` and `bot-state-channel.ts` through `runsForProtocolV1`.
- Wire schema: `emails` on all four Run branches, `"email"` in the caller enum, `protocolMax` 5, then `bun run generate:protocol` and fixtures.
- The stored-shape cleanup.
- An audit row for email replies.
- The prompt wording in the email Plugin's `SKILL.md`, references and `plugin.json` owner-card description, then regenerate the seeded artifacts.
- The whole Flutter card, with thread grouping, removing "via email", hiding note receipts, and widget tests.
- Unit and integration tests, and docs.

**Open.**

- A failed email Turn sends no email.
- Unverified: whether the send binding's returned `messageId` equals the delivered `Message-ID` header. Threading a reply to a note depends on it.

## Jev

**The goal (Tim's decision).** Jev supervision is **enforced**, not in shadow, even below the eval gate, so Tim can tune it in use. This PR covers plan step 4, fully enforced:

- the start-of-Turn judgment plus acknowledgement steering;
- whole-response review, which withholds needless visible text (motivating case: narrating an email the receipt card already shows), and repair or wrong-objective handling for off-task responses.

It includes no mutation approval; that is steps 2 and 3, next. Every decision is recorded per Turn, with thresholds and wording in one place.

**Where it stands.** Branch `claude/charming-maxwell-r6nxhq-jev-on`, one WIP commit `dbe4cad0`, pushed with `--no-verify`. **Not typechecked or tested.** Typecheck is expected to fail: tests still build `TurnDirective` / `StepDecision` without `judgments`, and `contract.test.ts` tests the removed per-call path. Edit scripts and eval logs are in this cloud container's `scratchpad/agents/jev-on/`, which won't survive.

**Done, by file.**

- `app/supervision/turn-start.ts`
  - Question wording retuned; thresholds unchanged, still pinned to `jev-1.13.0`.
  - `composeTurnDirectiveV1` won't ask for an acknowledgement when Jev reads the message as `conversation_only`.
  - It records the raw answers and the model.
  - `turnStartJudgmentEvidenceV1` maps the evidence.
- `app/evals/turn-start.fixtures.ts`: a new case, `email-me-the-notes` ("no acknowledgement").
- `core/contracts/turn-supervisor.ts`
  - `TurnDirective` / `StepDecision` carry `judgments` and `model`; `StepDecision` carries `textReason`.
  - `StepProposalEvidence` gains `origin`, `conversation` and `shown` (what the person has already been shown this Turn).
  - A new reason code `redundant_text`; new origins `email` and `group`; `ProposedCallV1.speaks` (a question, card or reply to a caller is never rejected); `ContinuationItemV1.description`.
  - Exact-key decoders.
- `core/contracts/types.ts`: new session events `supervision/turn-start` and `supervision/step`. The step event carries withheld text word for word. Both decoded.
- `core/contracts/loop-hooks.ts` and `core/agent-loop/index.ts`: the loop seam, a new `reviewResponse` hook called in `#completeStep` before any tool is prepared, on fresh and resumed steps. It runs only when the response has tool calls. If it throws, the Turn fails with nothing run.
- `app/supervision/response-review.ts` (new): the whole-response questions, every threshold and veto, and `composeStepDecisionV1`. **This is the one place to tune.**
- `app/supervision/jev.ts`
  - Rewritten: one Jev call per Turn start and one per model response. The per-call tool-approval questions are no longer asked.
  - `hostedJevClientV1` is the only reader of `JEV_API_KEY` / `JEV_BASE_URL`. `JEV_BASE_URL` is new, for an e2e fake. The routine-event, group-reply and dictation judges use it too.

**Not started.**

- `app/supervision/loop.ts`, the feature that calls both hooks. Planned:
  - Enforce decisions through `prepareTool`, keyed by occurrence id (batch sub-calls included), returning a denied result the model can read.
  - `stepContinuation` stops the Turn when a finish send was withheld as redundant.
  - Mount it first in `createFoundationRuntime`, so a Plugin hook can't override it.
  - Call `startTurn` from a `request` hook on the Turn's first request, when the journal has no `supervision/turn-start`. Add acknowledgement steering to the system prompt when `acknowledge` is set and nothing has been said yet.
- Supply the supervisor as `ShellRuntimeFactoriesV1.supervisor(env)`: the fake in test fixtures, the hosted one in `foundationShellApplicationV1`.
- `app/shell/delivery.ts`: a withheld finish send must count as the Turn's reply, or the Turn is marked as owing one and yields.
- A `supervision` audit kind for withheld text.
- Jev fakes for the workerd, integration and e2e harnesses, and `JEV_API_KEY` required in `production-secrets.ts`.
- The whole-response eval suite, unit tests and docs, including correcting `docs/jev-supervision-plan.md`.

**Eval scores.**

- Start of Turn: **22/28 at baseline → 29/29 after tuning**, twice, with identical scores on reruns.
- Whole-response: no suite yet.
- Jev latency: about 120–190 ms per call; the first call is about 600 ms.

**Decisions left open.**

- Should voice stay a "person is waiting" origin?
- `JEV_API_KEY` becoming required breaks zero-configuration self-hosting. Is that acceptable?
- Retry Jev once, or fail the Turn on the first blip?
- **Streamed drafts of withheld text.** Reply drafts stream the words while the model writes, so a withheld message would flash in the thread and vanish. That breaks "must not appear in chat" and needs a decision: hold drafts until review, or accept the flash.
- Does withheld text belong in the audit, or only in debug events?
- The agent planned never to withhold `reply_to_request`, because a caller is waiting for it.

**More learned.**

- Jev often answers `needs_clarification` for big jobs, which suppresses the acknowledgement. That errs safe.
- Production has no open-work state yet; a mid-work nudge shows up as a "[Steering]…" line prepended to the person's message.
- Once supervision is mandatory, every workerd, integration and e2e Turn fails without a Jev fake, and so does local `bun run dev` without a key.

**Composing with the email-thread branch.** Email replies go through `reply_to_request` with caller `"email"`. Jev's plan never withholds `reply_to_request`, so the redundant chat narration is prevented by email delivery, not by Jev. Jev still catches a `send_to_user` narration of an `email_owner` send in a chat Turn.

### What this session learned about Jev (verified on main at `b2f77192`)

- **Nothing in the agent loop calls `TurnSupervisor` on main.** `startTurn` and `reviewStep` are referenced only by `app/supervision/*`, `core/contracts/turn-supervisor.ts` and the tests. `docs/jev-supervision-plan.md` reads as if step 3 (mutation approval) were enforced; it is not. The only live Jev uses are the routine-event judge, the group-reply judge and dictation cleanup.
- `startTurn` in `app/supervision/jev.ts` returns the typed default. The start-of-Turn questions in `app/supervision/turn-start.ts` scored 21/28 on `jev-1.13.0` in `bun run eval:turn-start`; the missing judgment is telling a short message about open work from one that asks for nothing.
- **Mutation approval needs plan step 2 first:** a trusted catalog of which tools read and which mutate. Without it every tool defaults to `mutate`. That would put `send_to_user` and memory writes through tool approval, cost a Jev round trip per call, and effectively stop Bots talking.
- **A Bot's visible words are its `send_to_user` / `reply_to_request` tool calls.** Assistant text is private. So "withhold text" means settling those sends as not delivered, and an email Turn's reply is redirected where those sends are delivered.
- `JEV_API_KEY` is set in this cloud environment, so the live evals run here.
- Tim's steer: **on, not shadow, even below the eval gate.** He wants to tune it in use. So every decision needs to be inspectable per Turn (via `/api/debug` session events and audit), including withheld text and its reason, with thresholds and question wording in one file.

## Open decisions

- Whether to accept third-party replies to a Bot's emails into the conversation. Today they are refused, and drafts to others carry `Reply-To` the owner's sign-in address.
- Jev plan steps 5 (specialist routing), 6 (Mentor) and 7 (Plugin judgments) are unbuilt, and Tim hasn't asked for them yet.

## Tim's to-dos

- Run the #818 live test.
- Revoke the old `BILLING_MODEL_RATES` Worker secret and delete its GitHub secret.
- Confirm the `@frock/structured` rate.
- Run `bun run update:desktop` on the Mac for the native changes.
- Apple setup for iOS.
