// Who in a Group Chat answers a message.
//
// Every message in a group reaches every member, and a member the person
// @mentions always runs. Jev decides who else is asked: none, one, several or
// all of the members who are free. For a message a member wrote, it also says
// whether asking the members that message mentions carries the conversation on,
// or loops back on itself, or drifts from what the person wanted.
//
// A judge that cannot answer asks nobody extra, and lets a member's mentions
// run under the bound the group keeps for when Jev is away.

/** How a member's @mentions move the conversation. */
export const GROUP_MENTION_FLOWS_V1 = ["continues", "loops", "drifts"] as const;

export type GroupMentionFlowV1 = (typeof GROUP_MENTION_FLOWS_V1)[number];

export interface GroupReplyMemberV1 {
  botId: string;
  name: string;
  /** What the member is for, as its profile says. */
  description?: string;
}

export interface GroupReplyLineV1 {
  /** A member's name, or `User`. */
  speaker: string;
  text: string;
}

export interface GroupReplyEvidenceV1 {
  groupName: string;
  members: GroupReplyMemberV1[];
  /** The thread before the message, oldest first, bounded. */
  recent: GroupReplyLineV1[];
  message: GroupReplyLineV1 & {
    /** Members the message @mentions, by id. */
    mentions: string[];
  };
  /** Whether a member wrote the message rather than the person. */
  botAuthored: boolean;
  /**
   * The members Jev may ask: free, not the author, and not already asked by
   * the person's own @mention.
   */
  candidates: string[];
}

export interface GroupReplyDecisionV1 {
  /** Candidates asked to reply, most fitting first. */
  reply: string[];
  /**
   * For a member's message that mentions others: whether asking them carries
   * the conversation on. Absent for the person's messages, which always run.
   */
  mentions?: GroupMentionFlowV1;
  /** The judge could not answer; the group falls back to its own bound. */
  unavailable?: true;
}

export interface GroupReplyJudgeV1 {
  decide(
    evidence: GroupReplyEvidenceV1,
    signal?: AbortSignal,
  ): Promise<GroupReplyDecisionV1>;
}

/** What a group does without Jev: nobody extra, mentions under the bound. */
export function unavailableGroupReplyDecisionV1(
  evidence: Pick<GroupReplyEvidenceV1, "botAuthored" | "message">,
): GroupReplyDecisionV1 {
  return {
    reply: [],
    ...(evidence.botAuthored && evidence.message.mentions.length > 0
      ? { mentions: "continues" as const }
      : {}),
    unavailable: true,
  };
}

/** The test and development adapter: a scripted answer, or the fallback. */
export function createFakeGroupReplyJudgeV1(options?: {
  decide?: GroupReplyJudgeV1["decide"];
}): GroupReplyJudgeV1 {
  return {
    async decide(evidence, signal) {
      signal?.throwIfAborted();
      if (options?.decide) return options.decide(evidence, signal);
      return unavailableGroupReplyDecisionV1(evidence);
    },
  };
}

/** The adapter mounted when Jev is known to be down, or not configured. */
export function createUnavailableGroupReplyJudgeV1(): GroupReplyJudgeV1 {
  return {
    async decide(evidence, signal) {
      signal?.throwIfAborted();
      return unavailableGroupReplyDecisionV1(evidence);
    },
  };
}
