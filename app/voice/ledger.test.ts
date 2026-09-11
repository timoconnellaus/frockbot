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
    expect(await l.endCall("c1")).toBe(false);
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

  test("settle, speak, and list what is pending or unheard", async () => {
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
    expect((await l.pendingDelegations()).map((d) => d.runId)).toEqual([
      a.delegation.runId,
    ]);
    await l.settleDelegation(
      a.delegation.runId,
      { answer: "done" },
      later(100),
    );
    expect(await l.pendingDelegations()).toEqual([]);
    expect((await l.unspokenDelegations()).map((d) => d.answer)).toEqual([
      "done",
    ]);
    // Settling twice does not overwrite the first outcome.
    await l.settleDelegation(
      a.delegation.runId,
      { failure: "late" },
      later(200),
    );
    expect((await l.readDelegation(a.delegation.runId))?.answer).toBe("done");
    await l.markSpoken(a.delegation.runId, later(300));
    expect(await l.unspokenDelegations()).toEqual([]);
    expect((await l.readDelegation(a.delegation.runId))?.state).toBe("spoken");
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
