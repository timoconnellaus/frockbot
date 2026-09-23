# Startup implementation handoff

Status: implementation instructions for the startup and Memory decisions in [the product plan](../plan.md). Written against `4a1bdd9ea` after the 2026-09-22 rebase. The work has not been implemented. Use this directory when assigning any startup task to a coding agent. Read this page and the assigned task's packet; load research only when the packet points to it.

The product plan defines agreed behavior. This handoff supplies engineering direction, task boundaries and completion criteria. Existing source symbols are entry points, not a requirement to keep every file's current structure. New record/interface names below are proposed names: reuse an equivalent existing contract instead of creating a duplicate.

## Assignment procedure

1. Give each agent one task ID from the table below, its packet, the common rules on this page, repository instructions, and an exact base commit containing its prerequisites.
2. Supply the plan files to the cloud workspace: include them on its pushed starting branch or inline the required packet. A cloud agent cloning main does not automatically receive this worktree's uncommitted documents or this conversation.
3. State the allowed files, output branch and publication authority in the assignment. Use an isolated branch/workspace. The user selected Cursor for these assignments; that takes precedence over the default Claude delegation preference in local workflow instructions.
4. Have the agent identify the existing writer/read paths and tests listed in its packet before editing. An agent may resolve ordinary implementation details within the stated interface. A conflict with a required invariant is a blocker to report with evidence, not permission to weaken it.
5. Integrate and review the completed prerequisite before launching dependent work. Update the next assignment's base commit; a sibling branch does not contain another agent's work automatically.
6. Require the completion report described below. Review the actual diff and verification results before accepting the task.

## Scope

Implement the agreed directory, bounded context, durable recovery, prepared configuration/Skills/catalogs, voice opening, committed chat delivery and Hindsight-inspired Memory work. Keep the current `BotState extends DurableObject` and `VoiceAssistant extends Agent`. Reuse the voice Agent scheduler and existing Bot alarm owner.

The following remain outside these assignments:

- Moving the first-party application router into the gateway; authentication/selected-Bot RPC consolidation; active-effect projections and private-chunk batching; deferred accounting settlement. These are findings awaiting a scope decision, not authorized additions to a nearby task.
- Changing complete-model-step execution into incremental tool execution; showing private assistant output; changing model selection or provider billing policy.
- Replacing the Bot with `AIChatAgent`, adding a second scheduler to an object, or introducing a global Memory DO.
- Actual MCP Plugin implementation. Keep the prepared-catalog interface suitable for it, but implement the existing Composio REST path first. [SDK ownership constraints](../research/sdk-reuse-decision-review.md#mcp-the-managers-owner-is-the-important-constraint) apply when MCP is separately assigned.
- Group Chats and the removal of Projects. The text design is agreed in the [Group Chat plan](../plan.md#planned-group-chats-replace-projects) and assigned separately; voice is still undesigned. Memory must use the existing membership authority and keep its internal scope mapping isolated.
- A new Jev recall gate or broad supervision rollout. Retain an interface for a later gate; a Memory task cannot silently turn on the separate supervision plan.

## Task order

| ID  | Deliverable                                                         | Prerequisites                                             | Packet                                                                                            |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S1  | Current Bot profile mirror; no voice startup all-Bot fan-out        | None                                                      | [Context and preparation](context-and-preparation.md#s1-bot-directory)                            |
| S2  | Bounded working context and bounded voice history                   | None; freeze Session seed contract before callers change  | [Context and recovery](context-and-recovery.md#s2-working-context)                                |
| S3  | Bounded startup/admission; durable recovery and transcript delivery | S2; preserve exact active-run recovery                    | [Chat](context-and-recovery.md#s3-recovery-and-admission) and [voice](voice.md#s3-voice-recovery) |
| S4a | Revisioned preparation inputs                                       | S2                                                        | [Context and preparation](context-and-preparation.md#s4a-preparation-inputs)                      |
| S4b | Durable Skill metadata with exact-generation loads                  | S4a                                                       | [Context and preparation](context-and-preparation.md#s4b-skill-indexes)                           |
| S4c | Persistent Composio catalogs and first-use Turn pinning             | S4a; owns integration with the existing User alarm        | [Context and preparation](context-and-preparation.md#s4c-tool-catalogs)                           |
| S5  | Committed chat updates, replay and snapshot/cursor protocol         | S2 and S3                                                 | [Chat delivery](chat-delivery.md#s5-committed-updates)                                            |
| S6  | Attempt-owned voice opening, audio readiness and durable resumption | S1–S3 and S4a; reuse preparation interfaces as S4b/c land | [Voice](voice.md#s6-opening-lifecycle)                                                            |
| M1  | Canonical Memory store, exact recall and explicit write/forget      | S3 scheduling; freeze owner/scope contract in packet      | [Memory](memory.md#m1-records-and-explicit-operations)                                            |
| M2  | Extraction, consolidation, indexing and prepared views              | M1                                                        | [Memory](memory.md#m2-background-processing)                                                      |
| M3  | Hybrid recall and chat/voice integration                            | M2, S2, S4a and S6 for voice                              | [Memory](memory.md#m3-recall-and-context-integration)                                             |
| V1  | Combined correctness, cleanup and release readiness                 | All assigned tasks integrated                             | [Acceptance](#combined-acceptance)                                                                |

S1 and the S2 contract/reducer work can begin independently. S4b, S4c and Memory internals can proceed in parallel after their interfaces exist, with disjoint file ownership. Serialize edits to `apps/cloudflare/src/bot-state.ts`, `user-configuration.ts`, `voice-assistant.ts`, `app/shell/turn.ts`, durable authority, and the protocol schema. A task may prepare an adapter against a frozen interface while the integration owner wires these shared files. Do not launch dependent agents against empty placeholder interfaces and call their work integrated.

## Common implementation rules

- **Cloud authority:** clients submit commands and render committed state. Private text/tool arguments stay private until an explicit send commits. Keep one visible bubble per send.
- **One durable owner per change:** write an authoritative record, its derived projection and required pending work in the same owner's transaction when possible. User/Bot DOs and R2/Vectorize are separate transactions; use durable intents, acknowledgements and idempotent receivers between them.
- **External I/O outside transactions:** compute/store intent first, perform external work outside the transaction, then commit its result only if the source revision and ownership still match. A transaction must not enclose model calls, embeddings, R2 fetches or other DO RPCs.
- **Wakeups are part of correctness:** pending work must have a durable future wakeup even if the object is evicted immediately. Use the object's existing alarm owner. A post-commit callback, `waitUntil`, or startup scan alone is insufficient. Each task changing scheduling must document and test the record/alarm crash sequence.
- **Exact effects:** retain durable model/tool intent before dispatch, current grants/credentials, Stop fencing, spend admission and uncertain-outcome handling. Retry only where the actual receiver/protocol supports the key. An ordinary retry key does not make every provider idempotent.
- **Prepared data is derived:** reuse revisions, catalogs and context; create fresh cancellation, billing, run/Session identity and capability bindings for each Turn. Permission changes take precedence over cache reuse.
- **Keep context equivalent:** S2/S4 storage changes preserve assembled requests for unchanged history and policy, including provider replay fields, roles, tool IDs, ordering and prompt prefixes. Memory's deliberate content changes are tested separately.
- **Bound every scan:** use indexed pages/ranges with count and byte limits. A smaller return value after reading the whole archive is not a bounded read. Preserve useful cancellation in all asynchronous paths.
- **Use real seams:** pure projection/retrieval reducers with explicit storage/provider adapters; ordinary imports; no new dependency-injection framework, universal cache abstraction or generic job platform. Extend existing app modules and recovery hooks.
- **Disposable test state:** follow the repository's no-compatibility rule. A changed durable shape ships a scoped, repeatable cleanup of incompatible test records and references, verified on a fresh conversation. Preserve unfinished obligations or explicitly account for their disposal in the authorized cleanup. Do not add legacy decoders or silent read-time migrations to avoid that work.

## Validation and completion

Use deterministic fakes and call/read-count assertions. New timing measurements and live provider benchmarks are not prerequisites. Test the public interface and meaningful crash/race cases; avoid tests that merely assert helper names or duplicate implementation details.

For runtime, integration or native client changes, the repository requires full `bun run validate`; follow [local validation](../local-validation.md) for committing code inputs, receipts and environment setup. Flutter changes also need the applicable Dart checks; changes to wire contracts go through the schema generators and protocol checks. Use the repository's publication/no-mistakes workflow when publication is explicitly assigned. A missing tool or environment is reported as an unrun check, never a pass. Source inspection is not a substitute for the required executable checks during implementation.

This handoff is not permission to merge, tag, deploy or run production cleanup. Before an authorized release, the release owner verifies the scoped cleanup and fresh text/voice conversation, preserves the native compatibility policy, and follows current repository release instructions. Include What's New for visible changes under the existing procedure. Backend/client protocol changes must be released coherently; coordinate the minimum-client version if required rather than keeping unsupported wire variants.

Every task report must include:

1. Outcome and task ID; actual base and result commits; changed interfaces/files.
2. Tests run and results, including any unrun required checks.
3. Relevant transaction boundaries, wakeup guarantees and crash cases exercised.
4. Stored-shape changes and the exact scoped cleanup to ship with them.
5. Remaining limitations or deviations, with a concrete reason; prerequisite changes needed by downstream tasks.

## Combined acceptance

V1 exercises an integrated scenario, using fakes where provider timing is involved: a User with several Bots, a long conversation with multiple compactions, queued and steered work, a revoked Connection, a slow unrelated Bot, pending transcript delivery, and recent/corrected/forgotten Memory. Open chat, send, open voice, speak immediately, pause, disconnect/rejoin, wake, and receive a reply. Repeat after object eviction.

Pass only when unrelated history/Bots/integrations no longer gate startup; accepted commands/effects survive their defined crash points; context and provider replay remain correct; explicit sends arrive once in order without a transcript GET; opening speech survives until attempt readiness; and forbidden/stale Memory cannot reappear through cached views or vectors. Test live/paused expiry, scroll position and first-use catalog pinning as the packets specify. Verify required maintenance makes progress without another user request.

The final review compares the integrated behavior with the product plan, not just each agent's local tests. Routing removal, accounting redesign, Group Chat behavior and other excluded proposals remain separate decisions.

## Assignment template

Replace every bracketed field before dispatch; attach the actual packet contents when the cloud checkout cannot read them.

```text
Implement task [ID and deliverable] from docs/startup-implementation/README.md.
Start at commit [SHA including accepted prerequisites]. Read AGENTS.md, the
common rules and [packet]. Required task sections: [sections]. The other
packets are interface references, not permission to implement their tasks.

Own [files/modules]; [integration owner] owns shared adapter/schema edits.
Preserve the packet's behavior and transaction/effect boundaries. Follow its
engineering defaults. If source or API evidence makes a required guarantee
impossible, report the exact conflict and a narrow proposed adjustment.

Complete the task's acceptance cases and required repository validation.
Return the five-part completion report from the handoff, including the diff,
checks, stored-state cleanup and any unresolved limitations. Publication
authority: [local branch only / push named branch / open draft PR]. Do not
merge, tag, deploy, run production cleanup or add deferred product features.
```
