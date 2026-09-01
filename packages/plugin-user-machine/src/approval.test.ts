// The intent record and the settlement that reads it.
import { describe, expect, test } from "bun:test";
import type { MachineCommandV1 } from "@frockbot/machine-protocol";
import {
  decodeMachineIntentRecordV1,
  dispatchedMachineIntentV1,
  machineApprovalActionV1,
  machineCommandForIntentV1,
  machineIntentKeyV1,
  settledMachineIntentV1,
  MACHINE_INTENT_PREFIX,
  type MachineIntentRecordV1,
} from "./intent.js";
import {
  decodeMachineDispatchAnswerV1,
  dispatchMachineIntentV1,
  settleMachineIntentV1,
  type MachineDispatchAnswerV1,
} from "./approval.js";
import {
  machineResultDeliveryV1,
  machineResultPreviewV1,
  decodeMachineResultDeliveryV1,
} from "./delivery.js";

const NOW = "2026-09-01T00:00:00.000Z";
const LATER = "2026-09-01T00:05:00.000Z";

function intent(
  overrides: Partial<MachineIntentRecordV1> = {},
): MachineIntentRecordV1 {
  return {
    schemaVersion: 1,
    approvalId: "tool:4:2:0",
    commandId: "tool:4:2:0",
    machineId: "mac-1",
    botId: "bot-1",
    runId: "run-1",
    turn: 4,
    op: {
      kind: "exec",
      command: "git status",
      timeoutMs: 60_000,
      maxOutputBytes: 1_024,
    },
    createdAt: NOW,
    ...overrides,
  };
}

function storage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    map,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

describe("the intent record", () => {
  test("keys on the approval id, and round-trips exactly", () => {
    expect(machineIntentKeyV1("ap-1")).toBe(`${MACHINE_INTENT_PREFIX}ap-1`);
    const record = intent();
    expect(decodeMachineIntentRecordV1(record)).toEqual(record);
  });

  test("refuses a field it does not declare and a turn that is not one", () => {
    expect(() =>
      decodeMachineIntentRecordV1({ ...intent(), stdout: "…" }),
    ).toThrow('unexpected key "stdout"');
    expect(() =>
      decodeMachineIntentRecordV1({ ...intent(), turn: -1 }),
    ).toThrow("turn is invalid");
    expect(() =>
      decodeMachineIntentRecordV1({ ...intent(), outcome: "maybe" }),
    ).toThrow("outcome is invalid");
  });

  test("the command it dispatches carries the same id, which is the effect's", () => {
    const command: MachineCommandV1 = machineCommandForIntentV1(
      intent(),
      LATER,
    );
    expect(command).toEqual({
      schemaVersion: 1,
      commandId: "tool:4:2:0",
      machineId: "mac-1",
      botId: "bot-1",
      runId: "run-1",
      turn: 4,
      approvalId: "tool:4:2:0",
      op: intent().op,
      issuedAt: LATER,
      status: "queued",
    });
  });

  test("the card names the machine and what is about to happen on it", () => {
    expect(machineApprovalActionV1(intent().op, "Tims-Mac")).toBe(
      "Run on Tims-Mac: git status",
    );
    expect(
      machineApprovalActionV1(
        { kind: "read", path: "/etc/hosts", maxBytes: 10 },
        "Tims-Mac",
      ),
    ).toBe("Read /etc/hosts from Tims-Mac");
  });
});

describe("settling an intent inside the deciding transaction", () => {
  test("an approval that is not a machine command's is nobody's business", async () => {
    const store = storage();
    expect(
      await settleMachineIntentV1(store, "ap-other", "approved", LATER),
    ).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  test("records the decision beside the command it authorized", async () => {
    const store = storage({ [machineIntentKeyV1("tool:4:2:0")]: intent() });
    const settled = await settleMachineIntentV1(
      store,
      "tool:4:2:0",
      "approved",
      LATER,
    );
    expect(settled?.decision).toBe("approved");
    expect(settled?.decidedAt).toBe(LATER);
    // Approved is not yet terminal: the queue has not answered.
    expect(settled?.outcome).toBeUndefined();
  });

  test("a denial and an expiry are terminal where they stand", async () => {
    for (const answer of ["denied", "expired"] as const) {
      const store = storage({ [machineIntentKeyV1("tool:4:2:0")]: intent() });
      const settled = await settleMachineIntentV1(
        store,
        "tool:4:2:0",
        answer,
        LATER,
      );
      expect(settled?.decision).toBe(answer);
      expect(settled?.outcome).toBe(answer);
    }
  });

  test("first write wins: an alarm racing a person changes nothing", async () => {
    const decided = intent({ decision: "approved", decidedAt: LATER });
    const store = storage({ [machineIntentKeyV1("tool:4:2:0")]: decided });
    const settled = await settleMachineIntentV1(
      store,
      "tool:4:2:0",
      "expired",
      "2026-09-01T01:00:00.000Z",
    );
    expect(settled).toEqual(decided);
    expect(store.map.get(machineIntentKeyV1("tool:4:2:0"))).toEqual(decided);
  });

  test("a record this Package cannot read does not fail a person's decision", async () => {
    const store = storage({ [machineIntentKeyV1("tool:4:2:0")]: { nope: 1 } });
    expect(
      await settleMachineIntentV1(store, "tool:4:2:0", "approved", LATER),
    ).toBeUndefined();
  });

  test("pure: the settled record is a function of its arguments", () => {
    const before = intent();
    const first = settledMachineIntentV1(before, "approved", LATER);
    const second = settledMachineIntentV1(before, "approved", LATER);
    expect(first).toEqual(second);
    expect(before.decision).toBeUndefined();
  });
});

describe("dispatching an approved intent", () => {
  const queued: MachineDispatchAnswerV1 = {
    status: "queued",
    command: machineCommandForIntentV1(intent(), LATER),
  };

  test("queues exactly once and records that it did", async () => {
    const store = storage();
    const seen: MachineCommandV1[] = [];
    const settled = await dispatchMachineIntentV1(
      store,
      intent({ decision: "approved", decidedAt: LATER }),
      async (command) => {
        seen.push(command);
        return queued;
      },
      LATER,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.commandId).toBe("tool:4:2:0");
    expect(settled.outcome).toBe("dispatched");
    expect(settled.dispatchedAt).toBe(LATER);
    expect(store.map.get(machineIntentKeyV1("tool:4:2:0"))).toEqual(settled);
  });

  test("a denial, an expiry and an already-answered intent dispatch nothing", async () => {
    for (const already of [
      intent({ decision: "denied", outcome: "denied" }),
      intent({ decision: "expired", outcome: "expired" }),
      intent({ decision: "approved", outcome: "dispatched" }),
      intent(),
    ]) {
      const store = storage();
      let called = false;
      const settled = await dispatchMachineIntentV1(
        store,
        already,
        async () => {
          called = true;
          return queued;
        },
        LATER,
      );
      expect(called).toBe(false);
      expect(settled).toEqual(already);
      expect(store.map.size).toBe(0);
    }
  });

  test("a queue that refuses is recorded as refused, with the reason", async () => {
    const store = storage();
    const settled = await dispatchMachineIntentV1(
      store,
      intent({ decision: "approved" }),
      async () => ({
        status: "refused",
        reason: "Refused: this machine is not registered.",
      }),
      LATER,
    );
    expect(settled.outcome).toBe("refused");
    expect(settled.dispatchedAt).toBeUndefined();
    expect(settled.reason).toContain("not registered");
  });

  test("a duplicate is recorded as one, never as a second command", async () => {
    const store = storage();
    const settled = await dispatchMachineIntentV1(
      store,
      intent({ decision: "approved" }),
      async () => ({ ...queued, status: "duplicate" as const }),
      LATER,
    );
    expect(settled.outcome).toBe("duplicate");
  });

  test("the answer is decoded at the seam it crosses", () => {
    expect(decodeMachineDispatchAnswerV1(queued)).toEqual(queued);
    expect(
      decodeMachineDispatchAnswerV1({ status: "refused", reason: "no" }),
    ).toEqual({ status: "refused", reason: "no" });
    expect(() => decodeMachineDispatchAnswerV1({ status: "maybe" })).toThrow(
      "status is invalid",
    );
    expect(() =>
      decodeMachineDispatchAnswerV1({ ...queued, extra: 1 }),
    ).toThrow('unexpected key "extra"');
  });

  test("the dispatched record is pure in its arguments", () => {
    const before = intent({ decision: "approved" });
    expect(dispatchedMachineIntentV1(before, "dispatched", LATER)).toEqual(
      dispatchedMachineIntentV1(before, "dispatched", LATER),
    );
    expect(before.outcome).toBeUndefined();
  });
});

describe("the delivery back to the Bot", () => {
  const command = machineCommandForIntentV1(intent(), LATER);

  test("carries a preview and never the output", () => {
    const delivery = machineResultDeliveryV1(command, {
      schemaVersion: 1,
      commandId: "tool:4:2:0",
      finishedAt: LATER,
      outcome: "ok",
      truncated: true,
      exitCode: 0,
      stdout: "x".repeat(10_000),
    });
    expect(delivery.botId).toBe("bot-1");
    expect(delivery.preview.length).toBeLessThanOrEqual(400);
    expect(delivery.preview).toStartWith("exit 0 — ");
    expect(decodeMachineResultDeliveryV1(delivery)).toEqual(delivery);
  });

  test("a result with nothing to say still says its outcome", () => {
    expect(
      machineResultPreviewV1({
        schemaVersion: 1,
        commandId: "c",
        finishedAt: LATER,
        outcome: "timeout",
        truncated: false,
      }),
    ).toBe("timeout");
  });

  test("refuses a delivery that carries a field it does not declare", () => {
    const delivery = machineResultDeliveryV1(command, {
      schemaVersion: 1,
      commandId: "tool:4:2:0",
      finishedAt: LATER,
      outcome: "error",
      truncated: false,
    });
    expect(() =>
      decodeMachineResultDeliveryV1({ ...delivery, stdout: "…" }),
    ).toThrow('unexpected key "stdout"');
    expect(() =>
      decodeMachineResultDeliveryV1({ ...delivery, outcome: "maybe" }),
    ).toThrow("outcome is invalid");
  });
});
