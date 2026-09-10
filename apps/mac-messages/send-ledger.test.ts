import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MachineCommandV1 } from "@frockbot/core/machine-protocol";
import { withSendLedger } from "./send-ledger";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function path() {
  const root = await mkdtemp(join(tmpdir(), "send-ledger-test-"));
  roots.push(root);
  return join(root, "receipts.sqlite");
}
const command: MachineCommandV1 = {
  schemaVersion: 1,
  commandId: "tool-0-1-0",
  machineId: "m-1",
  botId: "scout",
  runId: "run-1",
  turn: 1,
  approvalId: "tool-0-1-0",
  op: {
    kind: "messages",
    call: { kind: "send", to: "+61400000000", text: "synthetic" },
  },
  issuedAt: "2026-09-01T00:00:00.000Z",
  status: "claimed",
};
const signal = new AbortController().signal;
const report = {
  finishedAt: "2026-09-01T00:00:01.000Z",
  outcome: "ok" as const,
  truncated: false,
  stdout: '{"kind":"sent"}',
};
test("a new process returns the saved receipt rather than sending again", async () => {
  const file = await path();
  let sends = 0;
  const effect = {
    run: async () => {
      sends++;
      return report;
    },
  };
  expect(await withSendLedger(file, effect).run(command, signal)).toEqual(
    report,
  );
  expect(await withSendLedger(file, effect).run(command, signal)).toEqual(
    report,
  );
  expect(sends).toBe(1);
});
test("an ambiguous send never runs again after reopening the ledger", async () => {
  const file = await path();
  let sends = 0;
  await expect(
    withSendLedger(file, {
      run: async () => {
        sends++;
        throw new Error("crash after sending");
      },
    }).run(command, signal),
  ).rejects.toThrow();
  const retry = await withSendLedger(file, {
    run: async () => {
      sends++;
      return report;
    },
  }).run(command, signal);
  expect(retry.outcome).toBe("refused");
  expect(retry.message).toContain("unknown");
  expect(sends).toBe(1);
});
test("two agents racing for a send only invoke the effect once", async () => {
  const file = await path();
  let sends = 0;
  const effect = {
    run: async () => {
      sends++;
      await Bun.sleep(10);
      return report;
    },
  };
  const a = withSendLedger(file, effect),
    b = withSendLedger(file, effect);
  await Promise.all([a.run(command, signal), b.run(command, signal)]);
  expect(sends).toBe(1);
});
