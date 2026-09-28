import { expect, test } from "bun:test";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { approvalKeyV1 } from "../shell/approvals.js";
import { approvalDeliveryDetailsV1 } from "../approvals/delivery.js";
import { pendingBotInputPreambleV1 } from "../routines/inbox.js";
import {
  CALL_APPROVAL_USE_WINDOW_MS_V1,
  callApprovalArgumentsV1,
  callApprovalDigestV1,
  callApprovalIdV1,
  createCallApprovalStoreV1,
} from "./call-approval.js";

async function asked(now = Date.now()) {
  const storage = new MemoryStorage();
  const approvals = createCallApprovalStoreV1(
    storage as unknown as Parameters<typeof createCallApprovalStoreV1>[0],
    () => now,
  );
  const args = { to: "dana@example.com", subject: "Invoice" };
  const digest = await callApprovalDigestV1("gmail/send", args);
  const approvalId = await callApprovalIdV1("run-1", "routine:1", "tool:1:2:0");
  await approvals.ask({
    schemaVersion: 1,
    approvalId,
    digest,
    tool: "gmail/send",
    arguments: callApprovalArgumentsV1(args),
    sessionId: "routine:1",
    createdAt: new Date(now).toISOString(),
  });
  const decide = (decision: "approved" | "denied", decidedAt = now) =>
    storage.put(approvalKeyV1(approvalId), {
      schemaVersion: 1,
      approvalId,
      runId: "run-1",
      sessionId: "routine:1",
      action: "Run gmail/send",
      risk: "high",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      decision,
      decidedBy: "user",
      decidedAt: new Date(decidedAt).toISOString(),
    });
  return { storage, approvals, digest, approvalId, decide };
}

test("key order is not another call, and any other particular is", async () => {
  expect(await callApprovalDigestV1("gmail/send", { a: 1, b: 2 })).toBe(
    await callApprovalDigestV1("gmail/send", { b: 2, a: 1 }),
  );
  expect(await callApprovalDigestV1("gmail/send", { a: 1, b: 2 })).not.toBe(
    await callApprovalDigestV1("gmail/send", { a: 1, b: 3 }),
  );
});

test("a card not yet settled is asked, then pending until the person answers", async () => {
  const { approvals, digest, approvalId, decide } = await asked();
  expect(await approvals.find(digest)).toEqual({ approvalId, status: "asked" });
  await decide("denied");
  expect(await approvals.find(digest)).toEqual({
    approvalId,
    status: "denied",
  });
});

test("an approval is spent once, by one occurrence, and only for its own call", async () => {
  const { approvals, digest, approvalId, decide } = await asked();
  expect(await approvals.spend(approvalId, digest, "tool:2:1:0")).toBe(false);
  await decide("approved");
  const other = await callApprovalDigestV1("gmail/send", { to: "x@y.z" });
  expect(await approvals.spend(approvalId, other, "tool:2:1:0")).toBe(false);
  expect(await approvals.spend(approvalId, digest, "tool:2:1:0")).toBe(true);
  // A replay of the same occurrence still holds its claim; nobody else does.
  expect(await approvals.spend(approvalId, digest, "tool:2:1:0")).toBe(true);
  expect(await approvals.spend(approvalId, digest, "tool:3:1:0")).toBe(false);
  expect(await approvals.status(approvalId)).toBe("spent");
});

test("an approval left too long is stale, and spends nothing", async () => {
  const now = Date.now();
  const { approvals, digest, approvalId, decide } = await asked(now);
  await decide("approved", now - CALL_APPROVAL_USE_WINDOW_MS_V1 - 1);
  expect(await approvals.status(approvalId)).toBe("stale");
  expect(await approvals.spend(approvalId, digest, "tool:2:1:0")).toBe(false);
});

test("the Turn a decision opens is told exactly which call it covers", async () => {
  const { storage, approvalId } = await asked();
  const inputs = [
    {
      schemaVersion: 1 as const,
      kind: "approval" as const,
      approvalId,
      decision: "approved" as const,
      createdAt: new Date().toISOString(),
    },
  ];
  const preamble = pendingBotInputPreambleV1(
    inputs,
    await approvalDeliveryDetailsV1(storage, inputs),
  );
  expect(preamble).toContain(`The decision on "${approvalId}" is approved.`);
  expect(preamble).toContain(
    'gmail/send with arguments {"subject":"Invoice","to":"dana@example.com"}',
  );
  expect(preamble).toContain("Make that call now, once");
});
