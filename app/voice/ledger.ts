// The voice assistant's durable ledger.
//
// One object per User holds it. Every fact that costs money or that another
// object will act on is written here before the call that spends it: the live
// call, each spoken turn under its idempotency key, each delegation to a Bot
// under the run id that Bot will admit, and the day's meters. It is pure over
// a key-value surface so it is tested in bun and hosted by a Durable Object.
//
// What it refuses to do is reconstruct spend after the fact. A model call has
// no idempotency key at the gateway, so a turn found `admitted` on recovery is
// marked `abandoned` and never re-sent. A Bot delegation does have a key — the
// run id the target Bot fences on — so it is looked up again, never re-issued.
import {
  VOICE_DICTATION_DAILY_CLEANUPS_V1,
  VOICE_DICTATION_DAILY_SECONDS_V1,
  VOICE_ASSISTANT_DAILY_DELEGATIONS_V1,
  VOICE_ASSISTANT_DAILY_AUDIO_IN_SECONDS_V1,
  VOICE_ASSISTANT_DAILY_AUDIO_OUT_SECONDS_V1,
  VOICE_ASSISTANT_DAILY_TURNS_V1,
  VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1,
  VOICE_ASSISTANT_PAUSED_REJOIN_WINDOW_MS_V1,
  VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1,
} from "./shared.js";
import { sha256HexTextV1 } from "@frockbot/core/crypto";

/** The key-value surface a Durable Object's storage already offers. */
export interface VoiceLedgerStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const VOICE_CALL_KEY_V1 = "voice:call:current";
export const VOICE_TURN_PREFIX_V1 = "voice:turn:";
export const VOICE_DELEGATION_PREFIX_V1 = "voice:delegation:";
export const VOICE_METER_PREFIX_V1 = "voice:meter:";
export const VOICE_DICTATION_LEASE_KEY_V1 = "voice:dictation:lease";

/** Delegations and turns older than this are dropped on recovery. */
export const VOICE_LEDGER_RETENTION_MS_V1 = 24 * 60 * 60_000;
/** How many settled records are kept before the oldest go. */
export const VOICE_LEDGER_MAX_RECORDS_V1 = 200;

export interface VoiceCallRecordV1 {
  schemaVersion: 1;
  callId: string;
  /** Names the device so a replaced socket from it rejoins rather than supersedes. */
  deviceKey: string;
  connectionId: string;
  startedAt: string;
  lastSeenAt: string;
  turnSequence: number;
  /**
   * The Bot this call is talking to (ADR 0029), durable so the Bot survives
   * the object being evicted mid-call and a rejoin comes back to the same
   * conversation. Absent on a record written before per-Bot calls, and on a
   * client that never named one; the object falls back to General.
   */
  botId?: string;
  /**
   * The person paused, or the app left the screen. A socket that then dies
   * is not a hang-up: the same device has the long rejoin window rather
   * than the short one. Absent means the call was live when last seen.
   */
  paused?: true;
}

export type VoiceTurnStateV1 = "admitted" | "answered" | "failed" | "abandoned";

export interface VoiceTurnRecordV1 {
  schemaVersion: 1;
  turnId: string;
  callId: string;
  /** The model call's idempotency key. Never re-sent after recovery. */
  key: string;
  /**
   * What the person said, as the session transcribed it. Written when the turn
   * is admitted and again when it settles: the model often starts answering
   * before the input transcription has caught up, and the later text is the
   * fuller one.
   */
  transcript: string;
  admittedAt: string;
  state: VoiceTurnStateV1;
  answer?: string;
  failure?: string;
  delegations: number;
}

/** The ledger as one read, for the operator surface. */
export interface VoiceLedgerDebugSnapshotV1 {
  schemaVersion: 1;
  userId: string;
  currentCall?: VoiceCallRecordV1;
  turns: VoiceTurnRecordV1[];
  delegations: VoiceDelegationRecordV1[];
}

/**
 * `admitted` is asked and not yet answered; `settled` is answered, and on its
 * way to the assistant or the thread; `spoken` is told — to the live session
 * if one is up, or as a chat message if the call has ended. `cancelled` is
 * an explicit stop, not a hang-up: ending a call leaves accepted work open
 * so a later call can hear it, or the thread can carry it.
 */
export type VoiceDelegationStateV1 =
  "admitted" | "settled" | "spoken" | "cancelled" | "expired";

export interface VoiceDelegationRecordV1 {
  schemaVersion: 1;
  runId: string;
  turnId: string;
  callId: string;
  botId: string;
  botName: string;
  text: string;
  admittedAt: string;
  state: VoiceDelegationStateV1;
  /** Look-ups made so far, so recovery backs off rather than spins. */
  attempts: number;
  /** When the Bot was last sent this intent, so a check in flight is not doubled. */
  dispatchedAt?: string;
  answer?: string;
  failure?: string;
  settledAt?: string;
  /**
   * When the answer was told once: to a live session, or as a chat
   * message after the call ended. A later call may hear an unspoken
   * answer; an answer already told is not said again.
   */
  spokenAt?: string;
}

export interface VoiceMeterV1 {
  schemaVersion: 1;
  day: string;
  /** Seconds of the person's audio bridged to the model, counted as sent. */
  audioInSeconds: number;
  /** Seconds of the model's audio bridged to the client, counted as sent. */
  audioOutSeconds: number;
  turns: number;
  delegations: number;
  /** Dictation provider seconds, reserved and reconciled the same way. */
  dictationSeconds: number;
  /** Model calls spent tidying a dictated transcript. Counted, never refunded. */
  dictationCleanups?: number;
}

export interface VoiceMeterCapsV1 {
  audioInSeconds: number;
  audioOutSeconds: number;
  turns: number;
  delegations: number;
  dictationSeconds: number;
  dictationCleanups: number;
}

export const VOICE_METER_CAPS_V1: VoiceMeterCapsV1 = {
  audioInSeconds: VOICE_ASSISTANT_DAILY_AUDIO_IN_SECONDS_V1,
  audioOutSeconds: VOICE_ASSISTANT_DAILY_AUDIO_OUT_SECONDS_V1,
  turns: VOICE_ASSISTANT_DAILY_TURNS_V1,
  delegations: VOICE_ASSISTANT_DAILY_DELEGATIONS_V1,
  dictationSeconds: VOICE_DICTATION_DAILY_SECONDS_V1,
  dictationCleanups: VOICE_DICTATION_DAILY_CLEANUPS_V1,
};

/** The one dictation an account may run at a time. */
export interface VoiceDictationLeaseRecordV1 {
  schemaVersion: 1;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
  /** Seconds reserved so far, so a release can refund what was not used. */
  reservedSeconds: number;
}

/**
 * The call the caller must end because this admission replaced it: another
 * device's, or the same device's earlier socket. Present on every admission
 * that displaced a live connection, whether or not the call record survived.
 */
export type VoiceCallAdmissionV1 =
  | {
      status: "admitted";
      call: VoiceCallRecordV1;
      rejoined: boolean;
      replaced?: VoiceCallRecordV1;
    }
  | {
      status: "superseded";
      call: VoiceCallRecordV1;
      previous: VoiceCallRecordV1;
      replaced: VoiceCallRecordV1;
    };

export type VoiceDelegationAdmissionV1 =
  | { status: "admitted"; delegation: VoiceDelegationRecordV1 }
  | { status: "duplicate"; delegation: VoiceDelegationRecordV1 }
  | { status: "refused"; reason: string };

/**
 * How long this call's own device has to come back after the socket goes.
 *
 * A live drop is the short window; a Pause, or the app leaving the screen,
 * is the long one. The record names which, so the alarm and a later
 * `start_call` ask the same question.
 */
export function voiceCallRejoinWindowMsV1(call: VoiceCallRecordV1): number {
  return call.paused === true
    ? VOICE_ASSISTANT_PAUSED_REJOIN_WINDOW_MS_V1
    : VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1;
}

/**
 * A socket from the same device, inside the rejoin window, is the same call:
 * a network change or a brief drop continues the conversation rather than
 * starting one. Anything else — another device, or a longer gap — is new.
 */
export function voiceCallRejoinsV1(
  call: VoiceCallRecordV1,
  deviceKey: string,
  at: Date,
): boolean {
  return (
    call.deviceKey === deviceKey &&
    at.getTime() - Date.parse(call.lastSeenAt) <=
      voiceCallRejoinWindowMsV1(call)
  );
}

/** The other side of the same rule: nobody can still be on this call. */
export function voiceCallIsStaleV1(call: VoiceCallRecordV1, at: Date): boolean {
  return (
    at.getTime() - Date.parse(call.lastSeenAt) > voiceCallRejoinWindowMsV1(call)
  );
}

export function voiceMeterDayV1(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A turn id is `<callId>:<sequence>`; the sequence is its order in the call,
 * from one. It is the only ordinal a turn has: an in-call memory write and the
 * end-of-call source both stamp this number, so they order against each other.
 */
export function voiceTurnOrdinalV1(turnId: string): number {
  const sequence = Number.parseInt(
    turnId.slice(turnId.lastIndexOf(":") + 1),
    10,
  );
  return Number.isFinite(sequence) && sequence > 0 ? sequence : 1;
}

/** `voice-<32 hex>`: a public identifier the Bot's run door accepts. */
export async function voiceDelegationRunIdV1(parts: readonly string[]) {
  // The separator is NUL so the hashed tuple stays unambiguous across parts.
  const hex = await sha256HexTextV1(parts.join("\0"));
  return `voice-${hex.slice(0, 32)}`;
}

export class VoiceLedgerV1 {
  /**
   * The caps in force. Overrides are merged over the shipped ones rather than
   * replacing them, so a caller that lowers one cap for a test does not
   * silently leave a newly added cap undefined — which reads as zero, and
   * refuses everything.
   */
  private readonly caps: VoiceMeterCapsV1;

  constructor(
    private readonly storage: VoiceLedgerStorageV1,
    private readonly userId: string,
    caps: Partial<VoiceMeterCapsV1> = {},
  ) {
    this.caps = { ...VOICE_METER_CAPS_V1, ...caps };
  }

  // -- calls ----------------------------------------------------------------

  async currentCall(): Promise<VoiceCallRecordV1 | undefined> {
    return this.storage.get<VoiceCallRecordV1>(VOICE_CALL_KEY_V1);
  }

  /**
   * Whether a connection from this device, now, continues the live call.
   *
   * Exported as a predicate because two callers need the same answer: this
   * ledger, deciding whether to open a new call record, and the object,
   * deciding whether the call that is about to be displaced should have its
   * memory taken first. One rule, asked twice.
   */
  async rejoins(deviceKey: string, at: Date): Promise<boolean> {
    const call = await this.currentCall();
    return call ? voiceCallRejoinsV1(call, deviceKey, at) : false;
  }

  /**
   * Admits a call for one connection. One live call per account: a newer
   * connection from another device supersedes the older one, and the caller
   * ends that one. A connection from the same device within the rejoin
   * window continues the same call record, so a network change is not a new
   * session.
   */
  async beginCall(input: {
    callId: string;
    deviceKey: string;
    connectionId: string;
    at: Date;
    /**
     * The Bot the client opened the call on. A rejoin that names one honours
     * it — the person pressed voice on that Bot and must not be handed back
     * the Bot of a call they had already lost — and a rejoin that names none
     * keeps the Bot the record already has.
     */
    botId?: string;
  }): Promise<VoiceCallAdmissionV1> {
    const previous = await this.currentCall();
    const at = input.at.toISOString();
    if (previous && voiceCallRejoinsV1(previous, input.deviceKey, input.at)) {
      const call: VoiceCallRecordV1 = {
        ...previous,
        connectionId: input.connectionId,
        lastSeenAt: at,
        ...(input.botId ? { botId: input.botId } : {}),
      };
      await this.storage.put(VOICE_CALL_KEY_V1, call);
      // The same call, a newer socket: the older socket is still a live
      // upstream until the caller ends it, so it is named here too.
      return {
        status: "admitted",
        call,
        rejoined: true,
        ...(previous.connectionId !== input.connectionId
          ? { replaced: previous }
          : {}),
      };
    }
    const call: VoiceCallRecordV1 = {
      schemaVersion: 1,
      callId: input.callId,
      deviceKey: input.deviceKey,
      connectionId: input.connectionId,
      startedAt: at,
      lastSeenAt: at,
      turnSequence: 0,
      ...(input.botId ? { botId: input.botId } : {}),
    };
    await this.storage.put(VOICE_CALL_KEY_V1, call);
    if (previous && previous.connectionId !== input.connectionId) {
      return { status: "superseded", call, previous, replaced: previous };
    }
    return { status: "admitted", call, rejoined: false };
  }

  /**
   * Points the live call at another Bot (ADR 0029, `switch_bot`).
   *
   * Only the connection that holds the call may retarget it, and the record
   * is written before the voice changes, so an eviction between the two
   * leaves the call on the Bot the person was last told about rather than on
   * one nobody heard named. A delegation the previous Bot still owes is
   * deliberately left open: it belongs to the call, not to the target, and
   * is read out in that Bot's own voice when it lands.
   */
  async retargetCall(
    connectionId: string,
    botId: string,
    at: Date,
  ): Promise<VoiceCallRecordV1 | undefined> {
    const call = await this.currentCall();
    if (!call || call.connectionId !== connectionId) return undefined;
    const next: VoiceCallRecordV1 = {
      ...call,
      botId,
      lastSeenAt: at.toISOString(),
    };
    await this.storage.put(VOICE_CALL_KEY_V1, next);
    return next;
  }

  async touchCall(connectionId: string, at: Date): Promise<void> {
    const call = await this.currentCall();
    if (!call || call.connectionId !== connectionId) return;
    await this.storage.put(VOICE_CALL_KEY_V1, {
      ...call,
      lastSeenAt: at.toISOString(),
    });
  }

  /**
   * Records that this connection paused, or that it woke. The rejoin window
   * follows this bit, so it is written before the socket is allowed to go:
   * a Pause whose close then races the write would otherwise expire in a
   * minute.
   */
  async setCallPaused(
    connectionId: string,
    paused: boolean,
    at: Date,
  ): Promise<void> {
    const call = await this.currentCall();
    if (!call || call.connectionId !== connectionId) return;
    const next: VoiceCallRecordV1 = {
      schemaVersion: 1,
      callId: call.callId,
      deviceKey: call.deviceKey,
      connectionId: call.connectionId,
      startedAt: call.startedAt,
      lastSeenAt: at.toISOString(),
      turnSequence: call.turnSequence,
      ...(call.botId ? { botId: call.botId } : {}),
      ...(paused ? { paused: true as const } : {}),
    };
    await this.storage.put(VOICE_CALL_KEY_V1, next);
  }

  /**
   * Ends the call held by this connection; another connection's is left
   * alone. The record it removes is answered back, because the caller has to
   * name the call that just ended — its turns are the source of the session's
   * memory, and the record is the only place the call id was.
   */
  async endCall(connectionId: string): Promise<VoiceCallRecordV1 | undefined> {
    const call = await this.currentCall();
    if (!call || call.connectionId !== connectionId) return undefined;
    await this.storage.delete(VOICE_CALL_KEY_V1);
    return call;
  }

  /**
   * Ends a call whose connection is long gone — the object was evicted mid
   * call, or the socket died without a close. Left alone inside the rejoin
   * window, because a client that comes straight back continues that call.
   */
  async endStaleCall(at: Date): Promise<VoiceCallRecordV1 | undefined> {
    const call = await this.currentCall();
    if (!call) return undefined;
    if (!voiceCallIsStaleV1(call, at)) return undefined;
    await this.storage.delete(VOICE_CALL_KEY_V1);
    return call;
  }

  // -- turns ----------------------------------------------------------------

  /**
   * Records a spoken turn before the model is asked anything. The key names
   * the User, the call and the sequence, so a second admission of the same
   * utterance is the same key.
   */
  async admitTurn(input: {
    connectionId: string;
    transcript: string;
    at: Date;
  }): Promise<
    | { status: "admitted"; turn: VoiceTurnRecordV1 }
    | { status: "refused"; reason: string }
  > {
    const call = await this.currentCall();
    if (!call || call.connectionId !== input.connectionId) {
      return { status: "refused", reason: "no live call for this connection" };
    }
    const meter = await this.meter(input.at);
    if (meter.turns >= this.caps.turns) {
      return {
        status: "refused",
        reason: "today's voice turn allowance is used up",
      };
    }
    const sequence = call.turnSequence + 1;
    const turnId = `${call.callId}:${sequence}`;
    const turn: VoiceTurnRecordV1 = {
      schemaVersion: 1,
      turnId,
      callId: call.callId,
      key: `voice-turn:${this.userId}:${call.callId}:${sequence}`,
      transcript: input.transcript,
      admittedAt: input.at.toISOString(),
      state: "admitted",
      delegations: 0,
    };
    await this.storage.put(VOICE_CALL_KEY_V1, {
      ...call,
      turnSequence: sequence,
      lastSeenAt: input.at.toISOString(),
    });
    await this.storage.put(turnKey(turnId), turn);
    await this.storage.put(meterKey(meter.day), {
      ...meter,
      turns: meter.turns + 1,
    });
    return { status: "admitted", turn };
  }

  /**
   * Closes a turn out. The transcript is written again because the session
   * transcribes what the person said while the model is already answering it:
   * whatever has arrived by the end is the fullest record of the turn there
   * will be, and memory reads this.
   */
  async settleTurn(
    turnId: string,
    outcome: { answer: string } | { failure: string },
    transcript?: string,
  ): Promise<void> {
    const turn = await this.storage.get<VoiceTurnRecordV1>(turnKey(turnId));
    if (!turn) return;
    await this.storage.put(turnKey(turnId), {
      ...turn,
      ...(transcript !== undefined && transcript.trim() ? { transcript } : {}),
      ...("answer" in outcome
        ? { state: "answered" as const, answer: outcome.answer }
        : { state: "failed" as const, failure: outcome.failure }),
    });
  }

  async readTurn(turnId: string): Promise<VoiceTurnRecordV1 | undefined> {
    return this.storage.get<VoiceTurnRecordV1>(turnKey(turnId));
  }

  /**
   * Every turn of one call, in the order they were admitted.
   *
   * This is the session's conversation, and it is what both the spoken
   * history and the end-of-call memory read. A turn is here from the moment
   * it was admitted, before the model was asked anything, so a call that ends
   * while its last turn is still in flight still carries what the person
   * said — which is exactly the turn most likely to have been the request to
   * remember something.
   */
  async turnsForCall(callId: string): Promise<VoiceTurnRecordV1[]> {
    const rows = await this.storage.list<VoiceTurnRecordV1>({
      prefix: VOICE_TURN_PREFIX_V1,
    });
    return (
      [...rows.values()]
        .filter((turn) => turn.callId === callId)
        // The sequence, not the clock: two turns admitted in the same
        // millisecond still have an order, and `10` must not sort before `9`.
        .sort((left, right) => turnSequence(left) - turnSequence(right))
    );
  }

  // -- delegations ----------------------------------------------------------

  /**
   * Records the intent to ask a Bot before the Bot is asked. The run id is
   * the fence: a retried tool call for the same turn and Bot finds the record
   * it already wrote and answers `duplicate`, and the Bot's own admission
   * refuses a second Turn under one id.
   */
  async admitDelegation(input: {
    turnId: string;
    botId: string;
    botName: string;
    text: string;
    at: Date;
  }): Promise<VoiceDelegationAdmissionV1> {
    const turn = await this.readTurn(input.turnId);
    if (!turn) return { status: "refused", reason: "the turn is not admitted" };
    const runId = await voiceDelegationRunIdV1([
      this.userId,
      turn.callId,
      input.turnId,
      input.botId,
      input.text,
    ]);
    const existing = await this.storage.get<VoiceDelegationRecordV1>(
      delegationKey(runId),
    );
    if (existing) return { status: "duplicate", delegation: existing };
    if (turn.delegations >= VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1) {
      return {
        status: "refused",
        reason: `this turn has already asked ${VOICE_ASSISTANT_MAX_DELEGATIONS_PER_TURN_V1} Bots`,
      };
    }
    const meter = await this.meter(input.at);
    if (meter.delegations >= this.caps.delegations) {
      return {
        status: "refused",
        reason: "today's Bot delegation allowance is used up",
      };
    }
    const delegation: VoiceDelegationRecordV1 = {
      schemaVersion: 1,
      runId,
      turnId: input.turnId,
      callId: turn.callId,
      botId: input.botId,
      botName: input.botName,
      text: input.text,
      admittedAt: input.at.toISOString(),
      state: "admitted",
      attempts: 0,
    };
    await this.storage.put(delegationKey(runId), delegation);
    await this.storage.put(turnKey(input.turnId), {
      ...turn,
      delegations: turn.delegations + 1,
    });
    await this.storage.put(meterKey(meter.day), {
      ...meter,
      delegations: meter.delegations + 1,
    });
    return { status: "admitted", delegation };
  }

  async readDelegation(
    runId: string,
  ): Promise<VoiceDelegationRecordV1 | undefined> {
    return this.storage.get<VoiceDelegationRecordV1>(delegationKey(runId));
  }

  async noteDelegationDispatch(runId: string, at: Date): Promise<void> {
    const delegation = await this.readDelegation(runId);
    if (!delegation) return;
    await this.storage.put(delegationKey(runId), {
      ...delegation,
      dispatchedAt: at.toISOString(),
    });
  }

  async noteDelegationAttempt(runId: string): Promise<number> {
    const delegation = await this.readDelegation(runId);
    if (!delegation) return 0;
    const attempts = delegation.attempts + 1;
    await this.storage.put(delegationKey(runId), { ...delegation, attempts });
    return attempts;
  }

  async settleDelegation(
    runId: string,
    outcome: { answer: string } | { failure: string } | { cancelled: true },
    at: Date,
  ): Promise<VoiceDelegationRecordV1 | undefined> {
    const delegation = await this.readDelegation(runId);
    if (!delegation || delegation.state !== "admitted") return delegation;
    const settled: VoiceDelegationRecordV1 = {
      ...delegation,
      settledAt: at.toISOString(),
      ...("answer" in outcome
        ? { state: "settled" as const, answer: outcome.answer }
        : "failure" in outcome
          ? { state: "settled" as const, failure: outcome.failure }
          : { state: "cancelled" as const }),
    };
    await this.storage.put(delegationKey(runId), settled);
    return settled;
  }

  /**
   * The answer went back to the live session as a late function response, on
   * the call it was asked on. What the model then says with it is the model's
   * own business: this records only that it was handed over, once.
   */
  async markDelegationSpoken(runId: string, at: Date): Promise<boolean> {
    const delegation = await this.readDelegation(runId);
    if (!delegation || delegation.state !== "settled") return false;
    await this.storage.put(delegationKey(runId), {
      ...delegation,
      state: "spoken",
      spokenAt: at.toISOString(),
    });
    return true;
  }

  /**
   * An answer that arrived with no call to tell: the one that asked has ended
   * and the end that should have cancelled it raced the answer. Cancelled the
   * same way, for the same reason.
   */
  async dropDelegation(runId: string): Promise<void> {
    const delegation = await this.readDelegation(runId);
    if (!delegation || delegation.state !== "settled") return;
    await this.storage.put(delegationKey(runId), {
      ...delegation,
      state: "cancelled",
    });
  }

  private async delegations(): Promise<VoiceDelegationRecordV1[]> {
    const rows = await this.storage.list<VoiceDelegationRecordV1>({
      prefix: VOICE_DELEGATION_PREFIX_V1,
    });
    return [...rows.values()].sort((left, right) =>
      left.admittedAt.localeCompare(right.admittedAt),
    );
  }

  /** Delegations whose Bot Turn has not been looked up to a settlement. */
  async pendingDelegations(): Promise<VoiceDelegationRecordV1[]> {
    return (await this.delegations()).filter(
      (delegation) => delegation.state === "admitted",
    );
  }

  /**
   * Answers that have landed and have not been told yet — to a live
   * session, or as a chat message after the call ended.
   */
  async unspokenDelegations(): Promise<VoiceDelegationRecordV1[]> {
    return (await this.delegations()).filter(
      (delegation) => delegation.state === "settled",
    );
  }

  /**
   * Everything the ledger holds, for the operator's `/api/debug/voice` read.
   *
   * Reads only, and never the ledger's own recovery: a look at a call that
   * went wrong must not be what ends it, expires its delegations or trims
   * its history. Turns are ordered as they were spoken and delegations as they
   * were asked, so the two together replay a call. Transcripts are included
   * because they are the point: the question "what did the person actually
   * say" is what this read exists to answer.
   */
  async debugSnapshot(): Promise<VoiceLedgerDebugSnapshotV1> {
    const [call, turnRows, delegations] = await Promise.all([
      this.currentCall(),
      this.storage.list<VoiceTurnRecordV1>({ prefix: VOICE_TURN_PREFIX_V1 }),
      this.delegations(),
    ]);
    const turns = [...turnRows.values()].sort(
      (left, right) =>
        left.admittedAt.localeCompare(right.admittedAt) ||
        turnSequence(left) - turnSequence(right),
    );
    return {
      schemaVersion: 1,
      userId: this.userId,
      ...(call ? { currentCall: call } : {}),
      turns,
      delegations,
    };
  }

  // -- meters ---------------------------------------------------------------

  async meter(at: Date): Promise<VoiceMeterV1> {
    const day = voiceMeterDayV1(at);
    const stored = await this.storage.get<VoiceMeterV1>(meterKey(day));
    return {
      schemaVersion: 1,
      day,
      audioInSeconds: stored?.audioInSeconds ?? 0,
      audioOutSeconds: stored?.audioOutSeconds ?? 0,
      turns: stored?.turns ?? 0,
      delegations: stored?.delegations ?? 0,
      dictationSeconds: stored?.dictationSeconds ?? 0,
      dictationCleanups: stored?.dictationCleanups ?? 0,
    };
  }

  async addMeter(
    at: Date,
    delta: Partial<
      Pick<
        VoiceMeterV1,
        "audioInSeconds" | "audioOutSeconds" | "dictationSeconds"
      >
    >,
  ): Promise<VoiceMeterV1> {
    const meter = await this.meter(at);
    const next: VoiceMeterV1 = {
      ...meter,
      audioInSeconds: Math.max(
        0,
        meter.audioInSeconds + (delta.audioInSeconds ?? 0),
      ),
      audioOutSeconds: Math.max(
        0,
        meter.audioOutSeconds + (delta.audioOutSeconds ?? 0),
      ),
      dictationSeconds: Math.max(
        0,
        meter.dictationSeconds + (delta.dictationSeconds ?? 0),
      ),
    };
    await this.storage.put(meterKey(meter.day), next);
    return next;
  }

  /**
   * Books a window of provider seconds before it is spent.
   *
   * Spend is recorded ahead, in bounded windows, and renewed while the
   * upstream is open, so an eviction mid-window loses at most the refund of
   * the part not used — never the record that the window was opened. A
   * window past the cap is refused, and the caller closes the upstream.
   */
  async reserveSeconds(
    at: Date,
    kind: "dictationSeconds",
    seconds: number,
  ): Promise<
    { status: "reserved"; meter: VoiceMeterV1 } | { status: "refused" }
  > {
    const meter = await this.meter(at);
    if ((meter[kind] ?? 0) + seconds > this.caps[kind]) {
      return { status: "refused" };
    }
    const next = await this.addMeter(at, { [kind]: seconds });
    return { status: "reserved", meter: next };
  }

  /** Gives back the part of a reserved window that was not used. */
  async refundSeconds(
    at: Date,
    kind: "dictationSeconds",
    seconds: number,
  ): Promise<void> {
    if (seconds <= 0) return;
    await this.addMeter(at, { [kind]: -seconds });
  }

  /**
   * Books one transcript tidy-up, or refuses it.
   *
   * Counted before the model is asked and never refunded, so an eviction
   * between the booking and the answer costs the account one call rather than
   * losing the record that a call was made. There is no idempotency key
   * because there is no retry: a tidy-up that fails is not tried again, the
   * raw transcript simply stands.
   *
   * Deliberately its own admission rather than a line in [exceededCap]: that
   * one decides whether a voice *call* may go on, and a day of tidy-ups is no
   * reason to refuse somebody a conversation.
   */
  async admitDictationCleanup(
    at: Date,
  ): Promise<{ status: "admitted" } | { status: "refused" }> {
    const meter = await this.meter(at);
    const spent = meter.dictationCleanups ?? 0;
    if (spent >= this.caps.dictationCleanups) return { status: "refused" };
    await this.storage.put(meterKey(meter.day), {
      ...meter,
      dictationCleanups: spent + 1,
    });
    return { status: "admitted" };
  }

  /** The first cap the day has hit, or nothing. */
  async exceededCap(at: Date): Promise<keyof VoiceMeterCapsV1 | undefined> {
    const meter = await this.meter(at);
    if (meter.audioInSeconds >= this.caps.audioInSeconds) {
      return "audioInSeconds";
    }
    if (meter.audioOutSeconds >= this.caps.audioOutSeconds) {
      return "audioOutSeconds";
    }
    if (meter.turns >= this.caps.turns) return "turns";
    if (meter.delegations >= this.caps.delegations) return "delegations";
    if (meter.dictationSeconds >= this.caps.dictationSeconds) {
      return "dictationSeconds";
    }
    return undefined;
  }

  // -- dictation lease ------------------------------------------------------

  async dictationLease(): Promise<VoiceDictationLeaseRecordV1 | undefined> {
    return this.storage.get<VoiceDictationLeaseRecordV1>(
      VOICE_DICTATION_LEASE_KEY_V1,
    );
  }

  /**
   * One dictation at a time per account, with a window of seconds booked
   * before the provider is opened. A lease nobody renews expires on its own,
   * so a relay that died holding one does not lock the account out.
   */
  async acquireDictationLease(input: {
    leaseId: string;
    at: Date;
    ttlMs: number;
    reserveSeconds: number;
  }): Promise<
    | { status: "acquired"; lease: VoiceDictationLeaseRecordV1 }
    | { status: "refused"; reason: string }
  > {
    const current = await this.dictationLease();
    if (
      current &&
      current.leaseId !== input.leaseId &&
      Date.parse(current.expiresAt) > input.at.getTime()
    ) {
      return {
        status: "refused",
        reason: "Dictation is already running somewhere else on this account.",
      };
    }
    const reserved = await this.reserveSeconds(
      input.at,
      "dictationSeconds",
      input.reserveSeconds,
    );
    if (reserved.status === "refused") {
      return {
        status: "refused",
        reason:
          "Today's dictation allowance is used up. It resets at midnight UTC.",
      };
    }
    const lease: VoiceDictationLeaseRecordV1 = {
      schemaVersion: 1,
      leaseId: input.leaseId,
      acquiredAt: input.at.toISOString(),
      expiresAt: new Date(input.at.getTime() + input.ttlMs).toISOString(),
      reservedSeconds: input.reserveSeconds,
    };
    await this.storage.put(VOICE_DICTATION_LEASE_KEY_V1, lease);
    return { status: "acquired", lease };
  }

  /** Extends the lease and books the next window. False ends the capture. */
  async renewDictationLease(input: {
    leaseId: string;
    at: Date;
    ttlMs: number;
    reserveSeconds: number;
  }): Promise<boolean> {
    const current = await this.dictationLease();
    if (!current || current.leaseId !== input.leaseId) return false;
    const reserved = await this.reserveSeconds(
      input.at,
      "dictationSeconds",
      input.reserveSeconds,
    );
    if (reserved.status === "refused") {
      await this.storage.delete(VOICE_DICTATION_LEASE_KEY_V1);
      return false;
    }
    await this.storage.put(VOICE_DICTATION_LEASE_KEY_V1, {
      ...current,
      expiresAt: new Date(input.at.getTime() + input.ttlMs).toISOString(),
      reservedSeconds: current.reservedSeconds + input.reserveSeconds,
    });
    return true;
  }

  /** Frees the lease and refunds the reserved seconds that were not used. */
  async releaseDictationLease(input: {
    leaseId: string;
    at: Date;
    activeSeconds: number;
  }): Promise<void> {
    const current = await this.dictationLease();
    if (!current || current.leaseId !== input.leaseId) return;
    await this.storage.delete(VOICE_DICTATION_LEASE_KEY_V1);
    const unused = current.reservedSeconds - Math.max(0, input.activeSeconds);
    await this.refundSeconds(input.at, "dictationSeconds", unused);
  }

  // -- recovery -------------------------------------------------------------

  /**
   * What the object does on waking: abandon model calls it cannot safely
   * repeat, expire delegations past retention, trim settled history, and hand
   * back the delegations still worth looking up.
   */
  async recover(
    at: Date,
    /**
     * Calls whose turns are still the only copy of what was said — the live
     * call, and any call whose end-of-session memory has not been taken yet.
     * Retention must not delete source the session's memory still needs.
     */
    protectedCalls: ReadonlySet<string> = new Set(),
  ): Promise<{
    abandonedTurns: string[];
    pending: VoiceDelegationRecordV1[];
  }> {
    const abandonedTurns: string[] = [];
    const turns = await this.storage.list<VoiceTurnRecordV1>({
      prefix: VOICE_TURN_PREFIX_V1,
    });
    const turnRows = [...turns.entries()].sort(([, left], [, right]) =>
      left.admittedAt.localeCompare(right.admittedAt),
    );
    for (const [key, turn] of turnRows) {
      if (turn.state === "admitted") {
        abandonedTurns.push(turn.turnId);
        await this.storage.put(key, { ...turn, state: "abandoned" });
      }
    }
    const disposable = turnRows.filter(
      ([, turn]) => !protectedCalls.has(turn.callId),
    );
    const stale = disposable.filter(
      ([, turn]) =>
        at.getTime() - Date.parse(turn.admittedAt) >
        VOICE_LEDGER_RETENTION_MS_V1,
    );
    const overflow = Math.max(
      0,
      turnRows.length - stale.length - VOICE_LEDGER_MAX_RECORDS_V1,
    );
    for (const [key] of [
      ...stale,
      ...disposable
        .filter(([k]) => !stale.some(([s]) => s === k))
        .slice(0, overflow),
    ]) {
      await this.storage.delete(key);
    }

    const pending: VoiceDelegationRecordV1[] = [];
    for (const delegation of await this.delegations()) {
      const age = at.getTime() - Date.parse(delegation.admittedAt);
      const open =
        delegation.state === "admitted" || delegation.state === "settled";
      if (age > VOICE_LEDGER_RETENTION_MS_V1) {
        if (open) {
          await this.storage.put(delegationKey(delegation.runId), {
            ...delegation,
            state: "expired",
          });
        } else {
          await this.storage.delete(delegationKey(delegation.runId));
        }
        continue;
      }
      if (delegation.state === "admitted") pending.push(delegation);
    }
    // Old meters: keep today and yesterday.
    const meters = await this.storage.list<VoiceMeterV1>({
      prefix: VOICE_METER_PREFIX_V1,
    });
    const keep = new Set([
      voiceMeterDayV1(at),
      voiceMeterDayV1(new Date(at.getTime() - 24 * 60 * 60_000)),
    ]);
    for (const [key, meter] of meters) {
      if (!keep.has(meter.day)) await this.storage.delete(key);
    }
    return { abandonedTurns, pending };
  }
}

function turnSequence(turn: VoiceTurnRecordV1): number {
  return voiceTurnOrdinalV1(turn.turnId);
}

function turnKey(turnId: string): string {
  return `${VOICE_TURN_PREFIX_V1}${turnId}`;
}

function delegationKey(runId: string): string {
  return `${VOICE_DELEGATION_PREFIX_V1}${runId}`;
}

function meterKey(day: string): string {
  return `${VOICE_METER_PREFIX_V1}${day}`;
}

/** An in-memory storage for tests and for hosts that hold nothing durable. */
export function createMemoryVoiceLedgerStorageV1(): VoiceLedgerStorageV1 & {
  readonly entries: Map<string, unknown>;
} {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: async <T>(key: string) =>
      entries.get(key) === undefined
        ? undefined
        : (structuredClone(entries.get(key)) as T),
    put: async (key, value) => {
      entries.set(key, structuredClone(value));
    },
    delete: async (key) => entries.delete(key),
    list: async <T>({ prefix }: { prefix: string }) => {
      const found = new Map<string, T>();
      for (const [key, value] of [...entries.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (key.startsWith(prefix)) found.set(key, structuredClone(value) as T);
      }
      return found;
    },
  };
}
