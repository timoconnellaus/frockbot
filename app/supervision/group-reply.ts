import { APIUserAbortError, type Fetch } from "@typesafe-ai/sdk";
import {
  createUnavailableGroupReplyJudgeV1,
  unavailableGroupReplyDecisionV1,
  type GroupReplyJudgeV1,
} from "@frockbot/core/contracts";
import {
  groupReplyDecisionOfV1,
  reviewGroupReplyV1,
} from "../evals/group-reply.js";
import { hostedJevClientV1, type createJevClientV1 } from "./jev.js";

/**
 * The hosted judge. A failure or a timeout asks nobody extra and lets a
 * member's mentions run under the group's own bound; an abort still aborts.
 */
export function createJevGroupReplyJudgeV1(options: {
  readonly client: ReturnType<typeof createJevClientV1>;
}): GroupReplyJudgeV1 {
  return {
    async decide(evidence, signal) {
      try {
        const review = await reviewGroupReplyV1(options.client, evidence, {
          signal,
        });
        return groupReplyDecisionOfV1(evidence, review.answers);
      } catch (error) {
        if (
          error instanceof APIUserAbortError ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        return unavailableGroupReplyDecisionV1(evidence);
      }
    },
  };
}

/**
 * The production chooser: Jev when `JEV_API_KEY` is present, otherwise the
 * unavailable judge.
 */
export function createHostedGroupReplyJudgeV1(
  env: Record<string, string | undefined>,
  fetch?: Fetch,
): GroupReplyJudgeV1 {
  const client = hostedJevClientV1(env, fetch);
  if (!client) return createUnavailableGroupReplyJudgeV1();
  return createJevGroupReplyJudgeV1({ client });
}
