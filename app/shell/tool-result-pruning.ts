// Pruning older tool results once a Bot has gone quiet.
//
// Any change to a message a request has already sent invalidates the
// provider's prompt cache from that message on, so history is only rewritten
// when the cache has gone cold anyway: once the Bot has made no model request
// for PRUNE_AFTER_IDLE_MS_V1. A judge decides which results the next Turn can
// do without; the decision is recorded as a session event, and the working
// context replaces each chosen result with the pruned marker from then on.

/**
 * How long after its last model request a Bot's history may be rewritten.
 * Together's serverless cache publishes no lifetime; this is the common one.
 */
export const PRUNE_AFTER_IDLE_MS_V1 = 5 * 60_000;

/** One line of what the conversation has been about, for the judge. */
export interface ToolResultPruneLineV1 {
  readonly from: "person" | "assistant";
  readonly text: string;
}

/** One tool result the judge may prune. */
export interface ToolResultPruneCandidateV1 {
  readonly tool: string;
  readonly text: string;
}

export interface ToolResultPruneInputV1 {
  readonly conversation: readonly ToolResultPruneLineV1[];
  readonly results: readonly ToolResultPruneCandidateV1[];
}

/**
 * For each result, in order, whether it is pruned. `undefined` when the judge
 * could not say, which prunes nothing.
 */
export type ToolResultPrunerV1 = (
  input: ToolResultPruneInputV1,
  signal?: AbortSignal,
) => Promise<readonly boolean[] | undefined>;
