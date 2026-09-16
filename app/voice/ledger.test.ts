import { describe, expect, test } from "bun:test";
import {
  createMemoryVoiceLedgerStorageV1,
  VOICE_LEDGER_RETENTION_MS_V1,
  VoiceLedgerV1,
} from "./ledger.js";

const t0 = new Date("2026-09-10T10:00:00.000Z");
const later = (ms: number) => new Date(t0.getTime() + ms);

function ledger(caps?: ConstructorParameters<typeof VoiceLedgerV1>[2]) {
  const storage = createMemoryVoiceLedgerStorageV1();
  return { storage, ledger: new VoiceLedgerV1(storage, "user-1", caps) };
}

async function liveCall(l: VoiceLedgerV1, connectionId = "c1") {
  const admitted = await l.beginCall({
    callId: "call-1",
    deviceKey: "phone",
    connectionId,
    at: t0,
  });
  expect(admitted.status).toBe("admitted");
  return admitted;
}

describe("voice ledger calls", () => {
  test("a second device supersedes the live call and the caller learns which", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const second = await l.beginCall({
      callId: "call-2",
      deviceKey: "laptop",
      connectionId: "c2",
      at: later(1_000),
    });
    expect(second.status).toBe("superseded");
    if (second.status !== "superseded") throw new Error("unreachable");
    expect(second.previous.connectionId).toBe("c1");
    expect((await l.currentCall())?.callId).toBe("call-2");
    // The old connection can no longer end the newer call.
    expect(await l.endCall("c1")).toBeUndefined();
    expect((await l.currentCall())?.callId).toBe("call-2");
  });

  test("the same device within the rejoin window continues the call", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const rejoined = await l.beginCall({
      callId: "call-x",
      deviceKey: "phone",
      connectionId: "c1b",
      at: later(30_000),
    });
    expect(rejoined.status).toBe("admitted");
    if (rejoined.status !== "admitted") throw new Error("unreachable");
    expect(rejoined.rejoined).toBe(true);
    expect(rejoined.call.callId).toBe("call-1");
    expect(rejoined.call.connectionId).toBe("c1b");
  });

  test("a same-device rejoin names the socket it replaced so the caller ends it", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const rejoined = await l.beginCall({
      callId: "call-x",
      deviceKey: "phone",
      connectionId: "c1b",
      at: later(5_000),
    });
    if (rejoined.status !== "admitted") throw new Error("unreachable");
    expect(rejoined.replaced?.connectionId).toBe("c1");
    // The same socket re-admitting itself replaces nothing.
    const same = await l.beginCall({
      callId: "call-y",
      deviceKey: "phone",
      connectionId: "c1b",
      at: later(6_000),
    });
    if (same.status !== "admitted") throw new Error("unreachable");
    expect(same.replaced).toBeUndefined();
  });

  test("the same device after the window starts a new call", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const fresh = await l.beginCall({
      callId: "call-2",
      deviceKey: "phone",
      connectionId: "c3",
      at: later(5 * 60_000),
    });
    expect(fresh.status).toBe("superseded");
  });
});

describe("voice ledger turns", () => {
  test("admits turns under sequential keys and refuses without a call", async () => {
    const { ledger: l } = ledger();
    expect(
      (await l.admitTurn({ connectionId: "c1", transcript: "hi", at: t0 }))
        .status,
    ).toBe("refused");
    await liveCall(l);
    const first = await l.admitTurn({
      connectionId: "c1",
      transcript: "hello",
      at: t0,
    });
    const second = await l.admitTurn({
      connectionId: "c1",
      transcript: "again",
      at: later(10),
    });
    if (first.status !== "admitted" || second.status !== "admitted") {
      throw new Error("expected admission");
    }
    expect(first.turn.key).toBe("voice-turn:user-1:call-1:1");
    expect(second.turn.key).toBe("voice-turn:user-1:call-1:2");
    expect((await l.meter(t0)).turns).toBe(2);
  });

  test("a stale connection cannot admit a turn on a newer call", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    await l.beginCall({
      callId: "call-2",
      deviceKey: "laptop",
      connectionId: "c2",
      at: later(1),
    });
    const stale = await l.admitTurn({
      connectionId: "c1",
      transcript: "x",
      at: later(2),
    });
    expect(stale.status).toBe("refused");
  });

  test("the daily turn cap refuses", async () => {
    const { ledger: l } = ledger({
      sttSeconds: 10,
      ttsCharacters: 10,
      turns: 1,
      delegations: 10,
      dictationSeconds: 10,
    });
    await liveCall(l);
    await l.admitTurn({ connectionId: "c1", transcript: "a", at: t0 });
    const refused = await l.admitTurn({
      connectionId: "c1",
      transcript: "b",
      at: t0,
    });
    expect(refused.status).toBe("refused");
    expect(await l.exceededCap(t0)).toBe("turns");
  });
});

describe("voice ledger delegations", () => {
  async function turn(l: VoiceLedgerV1) {
    await liveCall(l);
    const admitted = await l.admitTurn({
      connectionId: "c1",
      transcript: "ask remy to plan",
      at: t0,
    });
    if (admitted.status !== "admitted") throw new Error("expected admission");
    return admitted.turn;
  }

  test("the same ask is one delegation, and it is written before anything runs", async () => {
    const { ledger: l, storage } = ledger();
    const admitted = await turn(l);
    const first = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "plan tomorrow",
      at: t0,
    });
    const again = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "plan tomorrow",
      at: later(5),
    });
    expect(first.status).toBe("admitted");
    expect(again.status).toBe("duplicate");
    if (first.status !== "admitted" || again.status !== "duplicate") {
      throw new Error("unreachable");
    }
    expect(again.delegation.runId).toBe(first.delegation.runId);
    expect(first.delegation.runId).toMatch(/^voice-[0-9a-f]{32}$/);
    expect(
      storage.entries.has(`voice:delegation:${first.delegation.runId}`),
    ).toBe(true);
    expect((await l.readTurn(admitted.turnId))?.delegations).toBe(1);
    expect((await l.meter(t0)).delegations).toBe(1);
  });

  test("a different question to the same Bot is a different run", async () => {
    const { ledger: l } = ledger();
    const admitted = await turn(l);
    const a = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "one",
      at: t0,
    });
    const b = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "two",
      at: t0,
    });
    if (a.status !== "admitted" || b.status !== "admitted") throw new Error();
    expect(a.delegation.runId).not.toBe(b.delegation.runId);
  });

  test("settle, tell the assistant once, and never carry it further", async () => {
    const { ledger: l } = ledger();
    const admitted = await turn(l);
    const a = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "one",
      at: t0,
    });
    if (a.status !== "admitted") throw new Error();
    const runId = a.delegation.runId;
    expect((await l.pendingDelegations()).map((d) => d.runId)).toEqual([runId]);
    await l.settleDelegation(runId, { answer: "done" }, later(100));
    expect(await l.pendingDelegations()).toEqual([]);
    expect((await l.readDelegation(runId))?.state).toBe("settled");
    // Settling twice does not overwrite the first outcome.
    await l.settleDelegation(runId, { failure: "late" }, later(200));
    expect((await l.readDelegation(runId))?.answer).toBe("done");
    // Told to the assistant, by the event turn that carried it: once.
    expect(await l.markDelegationSpoken(runId, "call-1:2", later(300))).toBe(
      true,
    );
    expect(await l.readDelegation(runId)).toMatchObject({
      state: "spoken",
      spokenTurnId: "call-1:2",
      spokenAt: later(300).toISOString(),
    });
    expect(await l.markDelegationSpoken(runId, "call-1:3", later(400))).toBe(
      false,
    );
    // Dropping applies to a settled answer nobody can be told, not to one
    // already told.
    await l.dropDelegation(runId);
    expect((await l.readDelegation(runId))?.state).toBe("spoken");
  });

  test("a call that ends takes its open requests with it, and a late answer changes nothing", async () => {
    const { ledger: l } = ledger();
    const admitted = await turn(l);
    const asked = async (text: string) => {
      const admission = await l.admitDelegation({
        turnId: admitted.turnId,
        botId: "remy",
        botName: "Remy",
        text,
        at: t0,
      });
      if (admission.status !== "admitted") throw new Error();
      return admission.delegation.runId;
    };
    const waiting = await asked("one");
    const answered = await asked("two");
    await l.settleDelegation(answered, { answer: "two is done" }, later(50));
    // Hanging up: the one still being worked on and the one answered but not
    // yet told are both over. The Bot's answers stay in the Bot's thread.
    expect((await l.endCall("c1"))?.callId).toBe("call-1");
    expect((await l.readDelegation(waiting))?.state).toBe("cancelled");
    expect((await l.readDelegation(answered))?.state).toBe("cancelled");
    expect(await l.pendingDelegations()).toEqual([]);
    // The Bot finishing afterwards settles nothing.
    await l.settleDelegation(waiting, { answer: "one is done" }, later(5_000));
    expect(await l.readDelegation(waiting)).toMatchObject({
      state: "cancelled",
    });
    expect((await l.readDelegation(waiting))?.answer).toBeUndefined();
    // And a new call starts with nothing owed to it.
    const next = await l.beginCall({
      callId: "call-2",
      deviceKey: "phone",
      connectionId: "c2",
      at: later(10 * 60_000),
    });
    expect(next.status).toBe("admitted");
    expect(await l.pendingDelegations()).toEqual([]);
    expect(await l.dropDelegation(waiting)).toBeUndefined();
    expect((await l.readDelegation(waiting))?.state).toBe("cancelled");
  });

  test("another device taking the call, or the call going stale, cancels its requests too", async () => {
    const { ledger: l } = ledger();
    const admitted = await turn(l);
    const first = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "one",
      at: t0,
    });
    if (first.status !== "admitted") throw new Error();
    const taken = await l.beginCall({
      callId: "call-2",
      deviceKey: "tablet",
      connectionId: "c2",
      at: later(1_000),
    });
    expect(taken.status).toBe("superseded");
    expect((await l.readDelegation(first.delegation.runId))?.state).toBe(
      "cancelled",
    );
    // A request made on the new call is untouched by the old call's end.
    const turn2 = await l.admitTurn({
      connectionId: "c2",
      transcript: "ask again",
      at: later(2_000),
    });
    if (turn2.status !== "admitted") throw new Error();
    const second = await l.admitDelegation({
      turnId: turn2.turn.turnId,
      botId: "remy",
      botName: "Remy",
      text: "two",
      at: later(2_000),
    });
    if (second.status !== "admitted") throw new Error();
    expect(await l.endStaleCall(later(3_000))).toBeUndefined();
    expect((await l.readDelegation(second.delegation.runId))?.state).toBe(
      "admitted",
    );
    // The socket died and nobody came back: the stale end cancels it.
    expect((await l.endStaleCall(later(60 * 60_000)))?.callId).toBe("call-2");
    expect((await l.readDelegation(second.delegation.runId))?.state).toBe(
      "cancelled",
    );
  });

  test("a Bot's answer arriving is a turn of its own kind", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const event = await l.admitTurn({
      connectionId: "c1",
      transcript: "[Bot answer] Remy has answered: done",
      at: later(100),
      event: {
        kind: "bot-answer",
        botId: "remy",
        botName: "Remy",
        runId: "voice-1",
      },
    });
    if (event.status !== "admitted") throw new Error();
    expect((await l.readTurn(event.turn.turnId))?.event).toEqual({
      kind: "bot-answer",
      botId: "remy",
      botName: "Remy",
      runId: "voice-1",
    });
    // It costs a model turn like any other, and sits in the call's history.
    expect((await l.meter(t0)).turns).toBe(1);
    expect((await l.turnsForCall("call-1")).map((t) => t.turnId)).toEqual([
      event.turn.turnId,
    ]);
  });

  test("per-turn and daily caps refuse further delegations", async () => {
    const { ledger: l } = ledger({
      sttSeconds: 1e9,
      ttsCharacters: 1e9,
      turns: 1e9,
      delegations: 2,
      dictationSeconds: 1e9,
    });
    const admitted = await turn(l);
    for (const text of ["a", "b"]) {
      expect(
        (
          await l.admitDelegation({
            turnId: admitted.turnId,
            botId: "remy",
            botName: "Remy",
            text,
            at: t0,
          })
        ).status,
      ).toBe("admitted");
    }
    const refused = await l.admitDelegation({
      turnId: admitted.turnId,
      botId: "remy",
      botName: "Remy",
      text: "c",
      at: t0,
    });
    expect(refused.status).toBe("refused");
  });
});

describe("voice ledger recovery", () => {
  test("abandons admitted turns, keeps pending delegations, expires the old", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const open = await l.admitTurn({
      connectionId: "c1",
      transcript: "unfinished",
      at: t0,
    });
    if (open.status !== "admitted") throw new Error();
    const delegation = await l.admitDelegation({
      turnId: open.turn.turnId,
      botId: "remy",
      botName: "Remy",
      text: "work",
      at: t0,
    });
    if (delegation.status !== "admitted") throw new Error();
    const recovered = await l.recover(later(60_000));
    expect(recovered.abandonedTurns).toEqual([open.turn.turnId]);
    expect(recovered.pending.map((d) => d.runId)).toEqual([
      delegation.delegation.runId,
    ]);
    expect((await l.readTurn(open.turn.turnId))?.state).toBe("abandoned");
    // A second recovery re-abandons nothing and still lists the delegation.
    const again = await l.recover(later(120_000));
    expect(again.abandonedTurns).toEqual([]);
    expect(again.pending).toHaveLength(1);
    // Past retention, the delegation expires rather than being asked again.
    const old = await l.recover(later(VOICE_LEDGER_RETENTION_MS_V1 + 1));
    expect(old.pending).toEqual([]);
    expect((await l.readDelegation(delegation.delegation.runId))?.state).toBe(
      "expired",
    );
  });

  test("a request whose call is gone is cancelled on waking, not asked again", async () => {
    // The end that should have cancelled it was lost with the object: the
    // record is open and names a call that is not the live one.
    const { ledger: l, storage } = ledger();
    await liveCall(l);
    for (const [runId, state] of [
      ["voice-orphan-open", "admitted"],
      ["voice-orphan-answered", "settled"],
    ] as const) {
      storage.entries.set(`voice:delegation:${runId}`, {
        schemaVersion: 1,
        runId,
        turnId: "call-0:1",
        callId: "call-0",
        botId: "remy",
        botName: "Remy",
        text: "work",
        admittedAt: t0.toISOString(),
        state,
        attempts: 0,
      });
    }
    const recovered = await l.recover(later(1_000));
    expect(recovered.pending).toEqual([]);
    expect((await l.readDelegation("voice-orphan-open"))?.state).toBe(
      "cancelled",
    );
    expect((await l.readDelegation("voice-orphan-answered"))?.state).toBe(
      "cancelled",
    );
  });

  test("meters accumulate per UTC day and roll over", async () => {
    const { ledger: l } = ledger();
    await l.addMeter(t0, { sttSeconds: 30 });
    await l.addMeter(t0, { sttSeconds: 12, ttsCharacters: 400 });
    expect(await l.meter(t0)).toMatchObject({
      day: "2026-09-10",
      sttSeconds: 42,
      ttsCharacters: 400,
    });
    const tomorrow = new Date("2026-09-11T00:00:01.000Z");
    expect((await l.meter(tomorrow)).sttSeconds).toBe(0);
  });
});

describe("voice ledger spend windows", () => {
  test("reserves ahead, refuses past the cap, and refunds what was not used", async () => {
    const { ledger: l } = ledger({
      sttSeconds: 150,
      ttsCharacters: 1e9,
      turns: 1e9,
      delegations: 1e9,
      dictationSeconds: 1e9,
    });
    expect((await l.reserveSeconds(t0, "sttSeconds", 60)).status).toBe(
      "reserved",
    );
    expect((await l.reserveSeconds(t0, "sttSeconds", 60)).status).toBe(
      "reserved",
    );
    expect((await l.meter(t0)).sttSeconds).toBe(120);
    // The third window would cross the cap: refused, nothing booked.
    expect((await l.reserveSeconds(t0, "sttSeconds", 60)).status).toBe(
      "refused",
    );
    expect((await l.meter(t0)).sttSeconds).toBe(120);
    await l.refundSeconds(t0, "sttSeconds", 45);
    expect((await l.meter(t0)).sttSeconds).toBe(75);
    // A refund never goes below zero.
    await l.refundSeconds(t0, "sttSeconds", 500);
    expect((await l.meter(t0)).sttSeconds).toBe(0);
  });
});

describe("voice dictation lease", () => {
  const caps = {
    sttSeconds: 1e9,
    ttsCharacters: 1e9,
    turns: 1e9,
    delegations: 1e9,
    dictationSeconds: 100,
  };

  test("one capture at a time, seconds booked ahead, refunded on release", async () => {
    const { ledger: l } = ledger(caps);
    const first = await l.acquireDictationLease({
      leaseId: "lease-a",
      at: t0,
      ttlMs: 90_000,
      reserveSeconds: 60,
    });
    expect(first.status).toBe("acquired");
    const second = await l.acquireDictationLease({
      leaseId: "lease-b",
      at: later(1_000),
      ttlMs: 90_000,
      reserveSeconds: 60,
    });
    expect(second).toMatchObject({ status: "refused" });
    expect((await l.meter(t0)).dictationSeconds).toBe(60);
    // Renewal books the next window; the cap refuses the one after.
    expect(
      await l.renewDictationLease({
        leaseId: "lease-a",
        at: later(30_000),
        ttlMs: 90_000,
        reserveSeconds: 30,
      }),
    ).toBe(true);
    expect(
      await l.renewDictationLease({
        leaseId: "lease-a",
        at: later(60_000),
        ttlMs: 90_000,
        reserveSeconds: 30,
      }),
    ).toBe(false);
    expect(await l.dictationLease()).toBeUndefined();
  });

  test("release refunds the unused part and an expired lease can be taken over", async () => {
    const { ledger: l } = ledger(caps);
    await l.acquireDictationLease({
      leaseId: "lease-a",
      at: t0,
      ttlMs: 90_000,
      reserveSeconds: 60,
    });
    await l.releaseDictationLease({
      leaseId: "lease-a",
      at: later(20_000),
      activeSeconds: 20,
    });
    expect((await l.meter(t0)).dictationSeconds).toBe(20);
    expect(await l.dictationLease()).toBeUndefined();
    await l.acquireDictationLease({
      leaseId: "lease-b",
      at: later(30_000),
      ttlMs: 10_000,
      reserveSeconds: 30,
    });
    // Nobody renewed lease-b: past its ttl another capture may start.
    const takeover = await l.acquireDictationLease({
      leaseId: "lease-c",
      at: later(50_000),
      ttlMs: 10_000,
      reserveSeconds: 30,
    });
    expect(takeover.status).toBe("acquired");
    // A stranger's release changes nothing.
    await l.releaseDictationLease({
      leaseId: "lease-b",
      at: later(51_000),
      activeSeconds: 0,
    });
    expect((await l.dictationLease())?.leaseId).toBe("lease-c");
  });
});

describe("voice ledger debug snapshot", () => {
  test("replays a call: transcripts in order and the delegations each made", async () => {
    const { ledger: l } = ledger();
    await liveCall(l);
    const first = await l.admitTurn({
      connectionId: "c1",
      transcript: "what is the weather",
      at: later(1_000),
    });
    const second = await l.admitTurn({
      connectionId: "c1",
      transcript: "what is in my email",
      at: later(2_000),
    });
    if (first.status !== "admitted" || second.status !== "admitted") {
      throw new Error("unreachable");
    }
    const asked = await l.admitDelegation({
      turnId: first.turn.turnId,
      botId: "bob",
      botName: "Bob",
      text: "Tim is asking what the weather is",
      at: later(1_500),
    });
    if (asked.status !== "admitted") throw new Error("unreachable");
    await l.settleDelegation(
      asked.delegation.runId,
      { answer: "I can't check it" },
      later(10_000),
    );

    const snapshot = await l.debugSnapshot();

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.userId).toBe("user-1");
    expect(snapshot.currentCall?.callId).toBe("call-1");
    expect(snapshot.turns.map((turn) => turn.transcript)).toEqual([
      "what is the weather",
      "what is in my email",
    ]);
    expect(snapshot.delegations).toHaveLength(1);
    expect(snapshot.delegations[0]?.answer).toBe("I can't check it");
    expect(snapshot.delegations[0]?.state).toBe("settled");
    // A read changes nothing.
    expect(await l.debugSnapshot()).toEqual(snapshot);
  });

  test("an empty ledger reads as empty rather than failing", async () => {
    const { ledger: l } = ledger();
    expect(await l.debugSnapshot()).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      turns: [],
      delegations: [],
    });
  });
});
