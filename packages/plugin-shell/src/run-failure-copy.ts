import type {
  ModelProviderFailureClassV1,
  SessionEvent,
  TurnOutcome,
} from "@frockbot/kernel-contracts";
import {
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  MODEL_IDLE_DEADLINE_REASON_V1,
} from "@frockbot/kernel-contracts";
import {
  STEP_LIMIT_REASON_V1,
  TURN_DEADLINE_REASON_V1,
} from "@frockbot/kernel-agent-loop";
import { UNRECONCILABLE_RUN_FAILURE_V1 } from "@frockbot/kernel-do";

/**
 * The one place a Turn that did not finish is turned into a sentence for the
 * person who was waiting on it.
 *
 * A run's stored `failure` is a diagnostic. It is composed by whoever settled
 * the run, out of whatever the layer below handed up, and it reads like it:
 * "Reconciliation was explicitly abandoned: Bot turn ended with outcome
 * model-error: Flock AI keeps no durable copy of an interrupted response, so it
 * cannot be recovered". Every word of that is useful — on the debug surface,
 * where it stays, unchanged. None of it belongs in a chat bubble. A person
 * asked for a countdown applet; they should not have to learn what
 * reconciliation is to find out that the model gave up.
 *
 * So the projection stops forwarding the diagnostic and picks the sentence
 * instead. Two inputs, in order:
 *
 *  1. The kernel's own user-facing reasons. A handful of failures already have
 *     a sentence written for a person — the model deadlines, the Turn deadline,
 *     the unretrievable settlement — and those say something the outcome alone
 *     cannot, so a stored failure that carries one hands it straight through.
 *  2. Otherwise the Turn's terminal outcome, which is a closed set, mapped
 *     below. It says less, and it can never leak.
 *
 * The diagnostic is never the answer, not even as a fallback: an unmapped
 * outcome gets the generic line rather than whatever prose happened to be
 * stored.
 */

/**
 * Sentences the kernel writes for the person rather than for the log. They are
 * matched as substrings because the layer that settles a run wraps the reason
 * it was handed — the sentence survives the wrapping, the wrapper does not.
 */
export const USER_FACING_FAILURE_REASONS_V1: readonly string[] = [
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  MODEL_IDLE_DEADLINE_REASON_V1,
  TURN_DEADLINE_REASON_V1,
  STEP_LIMIT_REASON_V1,
  UNRECONCILABLE_RUN_FAILURE_V1,
];

/**
 * What each terminal outcome says. Total over `TurnOutcome` so adding one to
 * the kernel's union is a type error here rather than a silent generic line.
 */
export const RUN_FAILURE_COPY_V1: Record<TurnOutcome, string> = {
  completed: "This Bot couldn't finish its reply. Try again.",
  blocked: "This Bot wouldn't do that. Try asking a different way.",
  cancelled: "You stopped this.",
  interrupted: "This reply stopped before it finished. Try again.",
  "model-error": "The model couldn't finish its reply. Try again.",
  "tool-error": "Something the Bot was using didn't work. Try again.",
};

/** Every provider class reaches the same intentionally plain model-error copy. */
export const MODEL_PROVIDER_FAILURE_COPY_V1: Record<
  ModelProviderFailureClassV1,
  string
> = {
  transient: RUN_FAILURE_COPY_V1["model-error"],
  permanent: RUN_FAILURE_COPY_V1["model-error"],
  unknown: RUN_FAILURE_COPY_V1["model-error"],
};

/** What a Turn says when nothing more specific is known about how it ended. */
export const RUN_FAILURE_FALLBACK_COPY_V1 =
  "This Bot couldn't finish its reply. Try again.";

/** What an older client says for the one run projection it cannot decode. */
export const CLIENT_VERSION_DEGRADED_MESSAGE_V1 =
  "This message can't be shown in this version. Reload to update.";

/** The outcome the run's own log records, or `undefined` on an unclosed Turn. */
function terminalTurnOutcomeV1(
  events: readonly SessionEvent[],
): TurnOutcome | undefined {
  const terminal = events.findLast((event) => event.type === "turn/end");
  return terminal?.type === "turn/end" ? terminal.outcome : undefined;
}

export function runFailureCopyV1(input: {
  failure?: string;
  events?: readonly SessionEvent[];
}): string {
  const failure = input.failure ?? "";
  const written = USER_FACING_FAILURE_REASONS_V1.find((reason) =>
    failure.includes(reason),
  );
  if (written) return written;
  const outcome = terminalTurnOutcomeV1(input.events ?? []);
  return outcome ? RUN_FAILURE_COPY_V1[outcome] : RUN_FAILURE_FALLBACK_COPY_V1;
}

/**
 * The product's own sentences, as a set a client can check a string against.
 *
 * The projection maps every failure through {@link runFailureCopyV1} on the way
 * to the wire, so what reaches a client is already copy. The client still must
 * not *trust* that: a `ClientRun` can arrive from an older backend that
 * forwarded the raw diagnostic, and a provider's words under a bubble read as
 * part of what the Bot was saying. So the thread accepts a failure only when it
 * recognises it as something the product wrote, and otherwise says the generic
 * line — which keeps the specific sentences (the model deadlines say something
 * the outcome alone cannot) without ever letting an unknown string through.
 */
const KNOWN_FAILURE_COPY_V1 = new Set<string>([
  ...Object.values(RUN_FAILURE_COPY_V1),
  ...USER_FACING_FAILURE_REASONS_V1,
  RUN_FAILURE_FALLBACK_COPY_V1,
  CLIENT_VERSION_DEGRADED_MESSAGE_V1,
]);

/** The failure if the product wrote it, else the line every failure can use. */
export function knownFailureCopyV1(failure: string | undefined): string {
  return failure && KNOWN_FAILURE_COPY_V1.has(failure)
    ? failure
    : RUN_FAILURE_FALLBACK_COPY_V1;
}

/**
 * The half of a failure sentence that asks the person to send it again.
 *
 * These sentences were written for a thread that had nothing to press: they
 * ended by telling the person to try again, and trying again meant typing
 * their message a second time. The words stay on the wire — a client that
 * cannot offer the action still needs to say what to do — and a client that
 * can offer it drops them and shows the action instead.
 */
export const FAILURE_RETRY_INVITATION_V1 = " Try again.";

/**
 * A failure sentence split into what it reports and whether sending the same
 * message again is the way out of it.
 *
 * Only a sentence that asks for a retry gets one: "You stopped this." and
 * "This Bot wouldn't do that." are endings the person chose or the Bot meant,
 * and neither is repaired by sending the message a second time.
 */
export function failureNoticeV1(copy: string): {
  notice: string;
  retry: boolean;
} {
  return copy.endsWith(FAILURE_RETRY_INVITATION_V1)
    ? {
        notice: copy.slice(0, -FAILURE_RETRY_INVITATION_V1.length),
        retry: true,
      }
    : { notice: copy, retry: false };
}
