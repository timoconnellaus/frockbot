// A Group Chat's own state: the ordered thread, the person's read cursor, and
// for each member the Turn it is running or owed.
//
// Everything here runs inside one storage transaction of the group's Durable
// Object. What has to leave the object — admitting a member's Turn, telling a
// running member a message arrived, stopping a Turn, waking the clients — is
// returned as effects for the object to carry out after the commit. An effect
// that fails is owed again: the admission it would have made is written down
// before it is attempted, and the object's alarm tries it again.

import {
  GROUP_BOT_CHAIN_MAX_V1,
  GroupChatConflictError,
  groupDisplayNameV1,
  groupSessionIdV1,
  groupTurnRunIdV1,
  mentionedBotIdsV1,
  resolveMentionsV1,
  type GroupAuthorV1,
  type GroupChatContextV1,
  type GroupChatViewV1,
  type GroupEventV1,
  type GroupMessagePageV1,
  type GroupMessageV1,
} from "./shared.js";
import type {
  GroupReplyDecisionV1,
  GroupReplyEvidenceV1,
} from "@frockbot/core/contracts";
import {
  groupTurnMessageIdV1,
  renderGroupTurnInputV1,
  type GroupTurnOriginV1,
  type GroupTurnReasonV1,
} from "./context.js";

export interface GroupListOptionsV1 {
  prefix?: string;
  start?: string;
  end?: string;
  reverse?: boolean;
  limit?: number;
}

/** The part of Durable Object storage a group's state is written through. */
export interface GroupKvV1 {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: GroupListOptionsV1): Promise<Map<string, T>>;
}

const IDENTITY_KEY = "group:identity";
const HEAD_KEY = "group:head";
const READ_KEY = "group:read";
const MESSAGE_PREFIX = "group:msg:";
const MESSAGE_ID_PREFIX = "group:msg-id:";
const MEMBER_PREFIX = "group:member:";
const RECEIPT_PREFIX = "group:receipt:";
const JUDGE_PREFIX = "group:judge:";
const JUDGEMENT_PREFIX = "group:judgement:";

/** How much of the thread before a message Jev reads. */
export const GROUP_JUDGEMENT_THREAD_V1 = 20;

export interface GroupIdentityV1 {
  schemaVersion: 1;
  userId: string;
  groupId: string;
}

interface GroupHeadV1 {
  schemaVersion: 1;
  /** The last message's position; 0 before the first. */
  seq: number;
  /** Bot-started Turns owed since the person last spoke. */
  chain: number;
}

/** Exactly what the Bot object is asked to admit, kept so a retry is identical. */
export interface GroupTurnAdmissionV1 {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  text: string;
  origin: GroupTurnOriginV1;
}

interface MemberTurnV1 {
  runId: string;
  throughSeq: number;
  admittedAt: string;
  /** Set once the Bot object reports the Turn began running. */
  startedAt?: string;
  /** Whether the Turn has posted anything to the group. */
  posted: boolean;
}

interface MemberStateV1 {
  schemaVersion: 1;
  botId: string;
  /** The last message a Turn of this member has been given. */
  contextThrough: number;
  /** Turns ever owed to this member here; part of every run id. */
  turns: number;
  turn?: MemberTurnV1;
  /** A Turn owed but not admitted yet: behind `turn`, or unanswered. */
  owed?: {
    throughSeq: number;
    reason: GroupTurnReasonV1;
    admission?: GroupTurnAdmissionV1;
    /** How many times the member's object refused or failed to answer. */
    failures?: number;
  };
  /** Owed after `owed`, whose admission was already written down. */
  next?: { throughSeq: number; reason: GroupTurnReasonV1 };
}

export type GroupEffectV1 =
  | { kind: "admit"; botId: string; admission: GroupTurnAdmissionV1 }
  | { kind: "signal"; botId: string; seq: number }
  | { kind: "stop"; botId: string; runId: string; commandId: string }
  /** Ask Jev who answers the message at `seq`. */
  | { kind: "judge"; seq: number }
  | { kind: "broadcast" };

export interface GroupOutcomeV1<T> {
  value: T;
  effects: GroupEffectV1[];
}

/**
 * A member's group Turn as its Bot object holds it, read back by the group.
 *
 * The group pulls this rather than being told: the Bot object nudges it after
 * each commit, and the group's alarm reads it again while any Turn is open, so
 * a nudge lost to an eviction only delays what the thread shows.
 */
export interface GroupTurnStateV1 {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  /** The Turn has begun executing. */
  started: boolean;
  /** Every send the Turn made, in order; `occurrence` is stable per send. */
  sends: Array<{ occurrence: number; text: string; at: string }>;
  /** Completed without answering because a newer group message was waiting. */
  yielded: boolean;
}

/** Tries at admitting one member Turn before the group gives up on it. */
export const GROUP_ADMISSION_ATTEMPTS_V1 = 5;

function messageKey(seq: number): string {
  return `${MESSAGE_PREFIX}${String(seq).padStart(12, "0")}`;
}

function judgeKey(seq: number): string {
  return `${JUDGE_PREFIX}${String(seq).padStart(12, "0")}`;
}

function judgementKey(seq: number): string {
  return `${JUDGEMENT_PREFIX}${String(seq).padStart(12, "0")}`;
}

function memberKey(botId: string): string {
  return `${MEMBER_PREFIX}${botId}`;
}

function newMember(botId: string): MemberStateV1 {
  return { schemaVersion: 1, botId, contextThrough: 0, turns: 0 };
}

export class GroupChatLogV1 {
  constructor(
    private readonly kv: GroupKvV1,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async identity(): Promise<GroupIdentityV1 | undefined> {
    return this.kv.get<GroupIdentityV1>(IDENTITY_KEY);
  }

  /** Pins the object to its group. A second call for the same group is a no-op. */
  async initialize(identity: GroupIdentityV1): Promise<void> {
    const pinned = await this.identity();
    if (pinned) {
      if (
        pinned.userId !== identity.userId ||
        pinned.groupId !== identity.groupId
      ) {
        throw new Error("this Group Chat object belongs to a different group");
      }
      return;
    }
    await this.kv.put(IDENTITY_KEY, identity);
    await this.kv.put(HEAD_KEY, { schemaVersion: 1, seq: 0, chain: 0 });
  }

  private async head(): Promise<GroupHeadV1> {
    return (
      (await this.kv.get<GroupHeadV1>(HEAD_KEY)) ?? {
        schemaVersion: 1,
        seq: 0,
        chain: 0,
      }
    );
  }

  private async member(botId: string): Promise<MemberStateV1> {
    return (
      (await this.kv.get<MemberStateV1>(memberKey(botId))) ?? newMember(botId)
    );
  }

  private async members(): Promise<MemberStateV1[]> {
    return [
      ...(
        await this.kv.list<MemberStateV1>({ prefix: MEMBER_PREFIX })
      ).values(),
    ];
  }

  async message(seq: number): Promise<GroupMessageV1 | undefined> {
    return this.kv.get<GroupMessageV1>(messageKey(seq));
  }

  private async append(input: {
    messageId: string;
    author: GroupAuthorV1;
    body: GroupMessageV1["body"];
    at?: string;
  }): Promise<{ message: GroupMessageV1; appended: boolean }> {
    const existing = await this.kv.get<number>(
      `${MESSAGE_ID_PREFIX}${input.messageId}`,
    );
    if (existing !== undefined) {
      const message = await this.message(existing);
      if (message) return { message, appended: false };
    }
    const head = await this.head();
    const message: GroupMessageV1 = {
      schemaVersion: 1,
      seq: head.seq + 1,
      messageId: input.messageId,
      at: input.at ?? this.now().toISOString(),
      author: input.author,
      body: input.body,
    };
    await this.kv.put(messageKey(message.seq), message);
    await this.kv.put(`${MESSAGE_ID_PREFIX}${message.messageId}`, message.seq);
    await this.kv.put(HEAD_KEY, {
      ...head,
      seq: message.seq,
      chain:
        input.author.kind === "user" && input.body.kind === "text"
          ? 0
          : head.chain,
    } satisfies GroupHeadV1);
    return { message, appended: true };
  }

  /** A line recording a change to the group, written once per command. */
  async recordEvent(input: {
    commandId: string;
    actor: GroupAuthorV1;
    event: GroupEventV1;
    context: GroupChatContextV1;
  }): Promise<GroupOutcomeV1<GroupMessageV1>> {
    const { message, appended } = await this.append({
      messageId: `e-${input.commandId}`,
      author: input.actor,
      body: { kind: "event", event: input.event },
    });
    const effects: GroupEffectV1[] = [];
    if (!appended) return { value: message, effects };
    const event = input.event;
    if (event.type === "member-removed") {
      effects.push(
        ...(await this.release(event.botId, `leave-${input.commandId}`, true)),
      );
    }
    if (event.type === "archived") {
      for (const member of await this.members()) {
        effects.push(
          ...(await this.release(member.botId, `archive-${input.commandId}`)),
        );
      }
    }
    effects.push({ kind: "broadcast" });
    return { value: message, effects };
  }

  /**
   * Stops a member's Turn here and forgets what it was owed.
   *
   * A member that left is also let go of the Turn itself: its Bot object may
   * never report again, and nothing it says now is posted anyway.
   */
  private async release(
    botId: string,
    commandId: string,
    left = false,
  ): Promise<GroupEffectV1[]> {
    const member = await this.kv.get<MemberStateV1>(memberKey(botId));
    if (!member) return [];
    const effects: GroupEffectV1[] = [];
    if (member.turn) {
      effects.push({
        kind: "stop",
        botId,
        runId: member.turn.runId,
        commandId,
      });
      if (left) delete member.turn;
    }
    delete member.owed;
    delete member.next;
    await this.kv.put(memberKey(botId), member);
    return effects;
  }

  /**
   * Something the person or a member said.
   *
   * Mentions are resolved against the members as they are named now. The
   * members the person @mentions are owed a Turn at once. Every message is
   * then judged — who else answers, and for a member's message whether its
   * own mentions carry the conversation on — and the judgment is owed as an
   * effect, written down first so an eviction does not lose it. Every member
   * already working here is told a message arrived, so its Turn can yield at
   * its next step boundary.
   */
  async post(input: {
    messageId: string;
    author: GroupAuthorV1;
    text: string;
    context: GroupChatContextV1;
    at?: string;
  }): Promise<GroupOutcomeV1<GroupMessageV1>> {
    const { group, members } = input.context;
    if (group.archivedAt) {
      throw new GroupChatConflictError("this Group Chat is archived");
    }
    if (
      input.author.kind === "bot" &&
      !group.members.includes(input.author.botId)
    ) {
      throw new GroupChatConflictError(
        "only a member may post in this Group Chat",
      );
    }
    const mentions = resolveMentionsV1(
      input.text,
      members.filter((member) => group.members.includes(member.botId)),
    );
    const { message, appended } = await this.append({
      messageId: input.messageId,
      author: input.author,
      body: { kind: "text", text: input.text, mentions },
      ...(input.at ? { at: input.at } : {}),
    });
    if (!appended) return { value: message, effects: [] };
    const effects: GroupEffectV1[] = [{ kind: "broadcast" }];
    const authorId =
      input.author.kind === "bot" ? input.author.botId : undefined;
    for (const member of await this.members()) {
      if (member.botId !== authorId && member.turn) {
        effects.push({ kind: "signal", botId: member.botId, seq: message.seq });
      }
    }
    if (authorId === undefined) {
      for (const botId of mentionedBotIdsV1(mentions)) {
        await this.owe(botId, message.seq, "mention");
      }
    }
    await this.kv.put(judgeKey(message.seq), { seq: message.seq });
    effects.push({ kind: "judge", seq: message.seq });
    effects.push(...(await this.admissionsDue(input.context)));
    return { value: message, effects };
  }

  /** Messages written down as owed a judgment and not yet judged. */
  async pendingJudgements(): Promise<number[]> {
    return [
      ...(
        await this.kv.list<{ seq: number }>({ prefix: JUDGE_PREFIX })
      ).values(),
    ].map((pending) => pending.seq);
  }

  /**
   * What Jev is shown about one message: the group, the thread before it,
   * the message, and the members it may ask — free, not the author, and not
   * already named by the message's own mentions.
   */
  async judgementEvidence(
    seq: number,
    context: GroupChatContextV1,
  ): Promise<GroupReplyEvidenceV1 | undefined> {
    const message = await this.message(seq);
    if (message?.body.kind !== "text") return undefined;
    const members = context.members.filter((member) =>
      context.group.members.includes(member.botId),
    );
    const speaker = (author: GroupAuthorV1) =>
      author.kind === "user"
        ? "User"
        : (members.find((member) => member.botId === author.botId)?.name ??
          author.botId);
    const recent = [
      ...(
        await this.kv.list<GroupMessageV1>({
          start: MESSAGE_PREFIX,
          end: messageKey(seq),
          reverse: true,
          limit: GROUP_JUDGEMENT_THREAD_V1 * 2,
        })
      ).values(),
    ]
      .filter((line) => line.body.kind === "text")
      .slice(0, GROUP_JUDGEMENT_THREAD_V1)
      .reverse()
      .map((line) => ({
        speaker: speaker(line.author),
        text: line.body.kind === "text" ? line.body.text : "",
      }));
    const authorId =
      message.author.kind === "bot" ? message.author.botId : undefined;
    const mentioned = mentionedBotIdsV1(message.body.mentions);
    const busy = new Set(
      (await this.members())
        .filter((member) => member.turn || member.owed)
        .map((member) => member.botId),
    );
    return {
      groupName: groupDisplayNameV1(context.group, context.members),
      members: members.map((member) => ({
        botId: member.botId,
        name: member.name,
        ...(member.description ? { description: member.description } : {}),
      })),
      recent,
      message: {
        speaker: speaker(message.author),
        text: message.body.text,
        mentions: mentioned,
      },
      botAuthored: authorId !== undefined,
      candidates: members
        .map((member) => member.botId)
        .filter(
          (botId) =>
            botId !== authorId &&
            !mentioned.includes(botId) &&
            !busy.has(botId),
        ),
    };
  }

  /**
   * Jev's judgment of one message, applied once.
   *
   * The members it asks are owed a Turn. A member's own mentions are owed
   * only when asking them carries the conversation on; without Jev they run
   * under the group's bound on Bots asking Bots.
   */
  async applyJudgement(input: {
    seq: number;
    decision: GroupReplyDecisionV1;
    context: GroupChatContextV1;
  }): Promise<GroupOutcomeV1<void>> {
    if (!(await this.kv.get(judgeKey(input.seq)))) {
      return { value: undefined, effects: [] };
    }
    await this.kv.delete(judgeKey(input.seq));
    const message = await this.message(input.seq);
    if (message?.body.kind !== "text" || input.context.group.archivedAt) {
      return { value: undefined, effects: [] };
    }
    const inGroup = (botId: string) =>
      input.context.group.members.includes(botId);
    const authorId =
      message.author.kind === "bot" ? message.author.botId : undefined;
    for (const botId of input.decision.reply) {
      if (botId !== authorId && inGroup(botId)) {
        await this.owe(botId, input.seq, "jev");
      }
    }
    if (authorId !== undefined && input.decision.mentions === "continues") {
      const head = await this.head();
      let chain = head.chain;
      for (const botId of mentionedBotIdsV1(message.body.mentions)) {
        if (botId === authorId || !inGroup(botId)) continue;
        // Without Jev to judge a Bot asking a Bot, a run of them ends here.
        if (input.decision.unavailable && chain >= GROUP_BOT_CHAIN_MAX_V1) {
          break;
        }
        chain++;
        await this.owe(botId, input.seq, "mention");
      }
      if (chain !== head.chain) {
        await this.kv.put(HEAD_KEY, { ...(await this.head()), chain });
      }
    }
    await this.kv.put(judgementKey(input.seq), {
      schemaVersion: 1,
      seq: input.seq,
      decision: input.decision,
      at: this.now().toISOString(),
    });
    return {
      value: undefined,
      effects: await this.admissionsDue(input.context),
    };
  }

  /** How one message was judged, once it has been. */
  async judgement(
    seq: number,
  ): Promise<{ decision: GroupReplyDecisionV1; at: string } | undefined> {
    return this.kv.get(judgementKey(seq));
  }

  private async owe(
    botId: string,
    throughSeq: number,
    reason: GroupTurnReasonV1,
  ) {
    const member = await this.member(botId);
    const admission = member.owed?.admission;
    if (admission) {
      // Written down and being asked for as written; a later message is owed
      // after it rather than folded into bytes that were already sent.
      if (throughSeq > admission.origin.throughSeq) {
        member.next = {
          throughSeq: Math.max(member.next?.throughSeq ?? 0, throughSeq),
          reason: member.next?.reason === "mention" ? "mention" : reason,
        };
      }
    } else if (member.owed) {
      member.owed.throughSeq = Math.max(member.owed.throughSeq, throughSeq);
      if (reason === "mention") member.owed.reason = "mention";
    } else {
      member.owed = { throughSeq, reason };
    }
    await this.kv.put(memberKey(botId), member);
  }

  /**
   * The admissions owed now: a member with a Turn owed and none running here.
   *
   * The admission is written down before it is returned, so the object asking
   * the Bot twice — after a failure, or from its alarm — asks for exactly the
   * same Turn.
   */
  async admissionsDue(context: GroupChatContextV1): Promise<GroupEffectV1[]> {
    const identity = await this.identity();
    if (!identity) return [];
    const effects: GroupEffectV1[] = [];
    for (const member of await this.members()) {
      if (!member.owed || member.turn) continue;
      if (
        !context.group.members.includes(member.botId) ||
        context.group.archivedAt
      ) {
        delete member.owed;
        await this.kv.put(memberKey(member.botId), member);
        continue;
      }
      if (!member.owed.admission) {
        const messages = await this.range(
          member.contextThrough,
          member.owed.throughSeq,
        );
        const groupName = groupDisplayNameV1(context.group, context.members);
        const origin: GroupTurnOriginV1 = {
          kind: "group",
          groupId: identity.groupId,
          groupName,
          members: context.members
            .filter((candidate) =>
              context.group.members.includes(candidate.botId),
            )
            .map((candidate) => ({
              botId: candidate.botId,
              name: candidate.name,
            })),
          throughSeq: member.owed.throughSeq,
          reason: member.owed.reason,
        };
        member.owed.admission = {
          runId: await groupTurnRunIdV1({
            groupId: identity.groupId,
            botId: member.botId,
            throughSeq: member.owed.throughSeq,
            attempt: member.turns,
          }),
          sessionId: groupSessionIdV1(identity.groupId),
          acceptedAt: this.now().toISOString(),
          text: renderGroupTurnInputV1({
            botId: member.botId,
            groupName,
            members: origin.members,
            messages,
            reason: member.owed.reason,
          }),
          origin,
        };
        member.turns++;
        await this.kv.put(memberKey(member.botId), member);
      }
      effects.push({
        kind: "admit",
        botId: member.botId,
        admission: member.owed.admission,
      });
    }
    return effects;
  }

  /** Every owed admission, for the alarm to try again. */
  async owedAdmissions(): Promise<GroupEffectV1[]> {
    return (await this.members()).flatMap((member) =>
      member.owed?.admission && !member.turn
        ? [
            {
              kind: "admit" as const,
              botId: member.botId,
              admission: member.owed.admission,
            },
          ]
        : [],
    );
  }

  /** The Bot object has the Turn: it is this member's Turn here now. */
  async admitted(botId: string, runId: string): Promise<void> {
    const member = await this.member(botId);
    const admission = member.owed?.admission;
    if (!admission || admission.runId !== runId) return;
    member.turn = {
      runId,
      throughSeq: admission.origin.throughSeq,
      admittedAt: admission.acceptedAt,
      posted: false,
    };
    member.contextThrough = Math.max(
      member.contextThrough,
      admission.origin.throughSeq,
    );
    delete member.owed;
    if (member.next) {
      member.owed = member.next;
      delete member.next;
    }
    await this.kv.put(memberKey(botId), member);
  }

  /**
   * Asking the member for its Turn failed. After a few tries the group stops
   * asking and shows that the member did not answer, with Retry.
   * Answers whether it gave up.
   */
  async admissionFailed(botId: string, runId: string): Promise<boolean> {
    const member = await this.member(botId);
    if (member.owed?.admission?.runId !== runId) return false;
    member.owed.failures = (member.owed.failures ?? 0) + 1;
    if (member.owed.failures < GROUP_ADMISSION_ATTEMPTS_V1) {
      await this.kv.put(memberKey(botId), member);
      return false;
    }
    delete member.owed;
    delete member.next;
    await this.kv.put(memberKey(botId), member);
    await this.append({
      messageId: `e-settle-${runId}`,
      author: { kind: "bot", botId },
      body: { kind: "event", event: { type: "turn-failed", botId, runId } },
    });
    return true;
  }

  /** The Bot object refused the Turn for good — the Bot is gone. */
  async refused(botId: string, runId: string): Promise<void> {
    const member = await this.member(botId);
    if (member.owed?.admission?.runId !== runId) return;
    delete member.owed;
    delete member.next;
    await this.kv.put(memberKey(botId), member);
  }

  /**
   * A member's Turn as its Bot object reports it: that it started, what it
   * said, and how it ended. Applying the same state twice changes nothing.
   */
  async applyTurnState(input: {
    botId: string;
    runId: string;
    state: GroupTurnStateV1;
    context: GroupChatContextV1;
  }): Promise<GroupOutcomeV1<void>> {
    const effects: GroupEffectV1[] = [];
    // The member can report a Turn before this object has written down that
    // the admission was answered: the Bot runs it the moment it is admitted.
    const before = await this.member(input.botId);
    if (!before.turn && before.owed?.admission?.runId === input.runId) {
      await this.admitted(input.botId, input.runId);
    }
    const member = await this.member(input.botId);
    const current =
      member.turn?.runId === input.runId ? member.turn : undefined;
    const { state, context } = input;
    if (current && state.started && !current.startedAt) {
      current.startedAt = this.now().toISOString();
      await this.kv.put(memberKey(input.botId), member);
      effects.push({ kind: "broadcast" });
    }
    const speaking =
      context.group.members.includes(input.botId) && !context.group.archivedAt;
    for (const send of state.sends) {
      // A Bot removed mid-Turn, or a group archived under it, has nothing
      // more to say here.
      if (!speaking) break;
      const posted = await this.post({
        messageId: groupTurnMessageIdV1(input.runId, send.occurrence),
        author: { kind: "bot", botId: input.botId },
        text: send.text,
        context,
        at: send.at,
      });
      effects.push(...posted.effects);
    }
    if (current && state.sends.length > 0 && !current.posted) {
      const updated = await this.member(input.botId);
      if (updated.turn?.runId === input.runId) {
        updated.turn.posted = true;
        await this.kv.put(memberKey(input.botId), updated);
      }
    }
    if (!current) return { value: undefined, effects };
    if (state.status === "queued" || state.status === "running") {
      return { value: undefined, effects };
    }
    const settled = await this.member(input.botId);
    delete settled.turn;
    await this.kv.put(memberKey(input.botId), settled);
    const commandId = `settle-${input.runId}`;
    const at = this.now().toISOString();
    if (state.status === "cancelled" && state.sends.length === 0) {
      await this.append({
        messageId: `e-${commandId}`,
        author: { kind: "bot", botId: input.botId },
        body: {
          kind: "event",
          event: {
            type: "turn-stopped",
            botId: input.botId,
            runId: input.runId,
          },
        },
        at,
      });
    }
    if (state.status === "failed") {
      await this.append({
        messageId: `e-${commandId}`,
        author: { kind: "bot", botId: input.botId },
        body: {
          kind: "event",
          event: {
            type: "turn-failed",
            botId: input.botId,
            runId: input.runId,
          },
        },
        at,
      });
    }
    const head = await this.head();
    if (
      state.status === "completed" &&
      state.yielded &&
      head.seq > current.throughSeq
    ) {
      await this.owe(input.botId, head.seq, "continue");
    }
    effects.push({ kind: "broadcast" });
    effects.push(...(await this.admissionsDue(context)));
    return { value: undefined, effects };
  }

  /** Member Turns admitted here and not yet seen to settle. */
  async openTurns(): Promise<Array<{ botId: string; runId: string }>> {
    return (await this.members()).flatMap((member) =>
      member.turn ? [{ botId: member.botId, runId: member.turn.runId }] : [],
    );
  }

  /** `/stop`: every member Turn running or owed here, or one member's. */
  async stop(input: {
    commandId: string;
    botId?: string;
  }): Promise<GroupOutcomeV1<{ stopped: string[] }>> {
    const receiptKey = `${RECEIPT_PREFIX}stop:${input.commandId}`;
    const replay = await this.kv.get<{ stopped: string[] }>(receiptKey);
    if (replay) return { value: replay, effects: [] };
    const effects: GroupEffectV1[] = [];
    const stopped: string[] = [];
    for (const member of await this.members()) {
      if (input.botId !== undefined && member.botId !== input.botId) continue;
      if (!member.turn && !member.owed) continue;
      stopped.push(member.botId);
      effects.push(
        ...(await this.release(
          member.botId,
          `${input.commandId}-${member.botId}`,
        )),
      );
    }
    await this.kv.put(receiptKey, { stopped });
    effects.push({ kind: "broadcast" });
    return { value: { stopped }, effects };
  }

  /** Retry on a member Turn that did not finish: that member is asked again. */
  async retry(input: {
    commandId: string;
    botId: string;
    runId: string;
    context: GroupChatContextV1;
  }): Promise<GroupOutcomeV1<void>> {
    const receiptKey = `${RECEIPT_PREFIX}retry:${input.commandId}`;
    if (await this.kv.get(receiptKey)) return { value: undefined, effects: [] };
    const failed = await this.kv.get<number>(
      `${MESSAGE_ID_PREFIX}e-settle-${input.runId}`,
    );
    const line = failed === undefined ? undefined : await this.message(failed);
    if (
      line?.body.kind !== "event" ||
      line.body.event.type !== "turn-failed" ||
      line.body.event.botId !== input.botId
    ) {
      throw new GroupChatConflictError("that Turn has nothing to retry");
    }
    if (!input.context.group.members.includes(input.botId)) {
      throw new GroupChatConflictError(
        "that Bot is no longer in this Group Chat",
      );
    }
    await this.kv.put(receiptKey, true);
    await this.owe(input.botId, (await this.head()).seq, "retry");
    return {
      value: undefined,
      effects: [
        { kind: "broadcast" },
        ...(await this.admissionsDue(input.context)),
      ],
    };
  }

  async markRead(upTo: number): Promise<number> {
    const head = await this.head();
    const current =
      (await this.kv.get<{ readThrough: number }>(READ_KEY))?.readThrough ?? 0;
    const readThrough = Math.max(current, Math.min(upTo, head.seq));
    if (readThrough !== current) await this.kv.put(READ_KEY, { readThrough });
    return readThrough;
  }

  private async range(
    after: number,
    through: number,
  ): Promise<GroupMessageV1[]> {
    if (through <= after) return [];
    return [
      ...(
        await this.kv.list<GroupMessageV1>({
          start: messageKey(after + 1),
          end: messageKey(through + 1),
        })
      ).values(),
    ];
  }

  async page(query: {
    before?: number;
    after?: number;
    limit: number;
  }): Promise<GroupMessagePageV1> {
    if (query.after !== undefined) {
      const listed = await this.kv.list<GroupMessageV1>({
        start: messageKey(query.after + 1),
        end: `${MESSAGE_PREFIX}~`,
        limit: query.limit + 1,
      });
      const messages = [...listed.values()];
      return {
        schemaVersion: 1,
        messages: messages.slice(0, query.limit),
        hasMore: messages.length > query.limit,
      };
    }
    const listed = await this.kv.list<GroupMessageV1>({
      start: MESSAGE_PREFIX,
      end:
        query.before === undefined
          ? `${MESSAGE_PREFIX}~`
          : messageKey(query.before),
      reverse: true,
      limit: query.limit + 1,
    });
    const messages = [...listed.values()];
    return {
      schemaVersion: 1,
      messages: messages.slice(0, query.limit).reverse(),
      hasMore: messages.length > query.limit,
    };
  }

  /** What a watching client is told on every change. */
  async channelState(): Promise<{
    head: number;
    readThrough: number;
    working: string[];
  }> {
    return {
      head: (await this.head()).seq,
      readThrough:
        (await this.kv.get<{ readThrough: number }>(READ_KEY))?.readThrough ??
        0,
      working: (await this.members())
        .filter((member) => member.turn?.startedAt)
        .map((member) => member.botId),
    };
  }

  async view(context: GroupChatContextV1): Promise<GroupChatViewV1> {
    const head = await this.head();
    const readThrough =
      (await this.kv.get<{ readThrough: number }>(READ_KEY))?.readThrough ?? 0;
    let unread = 0;
    if (head.seq > readThrough) {
      for (const message of await this.range(readThrough, head.seq)) {
        if (message.author.kind === "bot" && message.body.kind === "text")
          unread++;
        if (unread >= 99) break;
      }
    }
    const working = (await this.members())
      .filter((member) => member.turn?.startedAt)
      .map((member) => member.botId);
    return {
      schemaVersion: 1,
      group: context.group,
      members: context.members,
      head: head.seq,
      readThrough,
      unread,
      working,
    };
  }
}
