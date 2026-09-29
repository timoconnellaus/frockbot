import { describe, expect, test } from "bun:test";
import type { PaymentsAccountV1 } from "@frockbot/core/contracts";
import {
  clientOfHelloV1,
  emitProductEventV1,
  productEventDataPointV1,
  productEventsFromAccountChangeV1,
  productEventsFromSettledRunV1,
} from "./events.ts";

describe("product event data points", () => {
  test("lay each field in its fixed column, indexed by User", () => {
    expect(
      productEventDataPointV1({
        name: "tool_used",
        userId: "user-1",
        botId: "bot-1",
        kind: "memory_write",
        detail: "chat",
        platform: "android",
        appVersion: "1.9.0",
        count: 3,
      }),
    ).toEqual({
      indexes: ["user-1"],
      blobs: [
        "tool_used",
        "user-1",
        "bot-1",
        "memory_write",
        "chat",
        "android",
        "1.9.0",
      ],
      doubles: [0, 0, 3],
    });
  });

  test("an event is written once, and a failing sink never throws", () => {
    const written: unknown[] = [];
    emitProductEventV1(
      { writeDataPoint: (point) => written.push(point) },
      { name: "app_opened", userId: "user-1" },
    );
    expect(written).toHaveLength(1);
    expect(() =>
      emitProductEventV1(
        {
          writeDataPoint: () => {
            throw new Error("unavailable");
          },
        },
        { name: "app_opened", userId: "user-1" },
      ),
    ).not.toThrow();
    expect(() =>
      emitProductEventV1(undefined, { name: "app_opened", userId: "user-1" }),
    ).not.toThrow();
  });
});

test("a hello names only a platform the schema knows", () => {
  expect(clientOfHelloV1({ platform: "ios", nativeVersion: "1.9.0" })).toEqual({
    platform: "ios",
    appVersion: "1.9.0",
  });
  expect(clientOfHelloV1({ platform: "fuchsia" })).toEqual({});
  expect(clientOfHelloV1("desktop")).toEqual({});
});

test("a settled Turn is its status and origin, and each tool it called", () => {
  const events = productEventsFromSettledRunV1(
    { userId: "user-1", botId: "bot-1" },
    {
      runId: "run-1",
      acceptedAt: "2026-09-28T00:00:00.000Z",
      status: "completed",
      origin: "routine",
      events: [
        {
          type: "tool/call",
          name: "memory_write",
          input: { text: "never read" },
          timestamp: "2026-09-28T00:00:01.000Z",
        },
        { type: "tool/call", name: "memory_write" },
        { type: "tool/call", name: "send_to_user" },
        { type: "tool/result", timestamp: "2026-09-28T00:00:04.000Z" },
      ],
    },
  );
  expect(events).toEqual([
    {
      name: "turn_settled",
      userId: "user-1",
      botId: "bot-1",
      kind: "completed",
      detail: "routine",
      durationMs: 4000,
    },
    {
      name: "tool_used",
      userId: "user-1",
      botId: "bot-1",
      kind: "memory_write",
      detail: "routine",
      count: 2,
    },
    {
      name: "tool_used",
      userId: "user-1",
      botId: "bot-1",
      kind: "send_to_user",
      detail: "routine",
      count: 1,
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("never read");
});

describe("an account's payment changes", () => {
  const none: PaymentsAccountV1 = {
    subscription: null,
    paidPeriod: null,
    subscribed: false,
    suspended: false,
    trialUsed: false,
  };
  const subscription = {
    customerId: "cus_1",
    subscriptionId: "sub_1",
    planId: "standard",
    status: "trialing",
    periodStart: 0,
    periodEnd: 7,
    trialEnd: 7,
    cancelAtPeriodEnd: false,
  };
  const trialling: PaymentsAccountV1 = {
    ...none,
    subscription,
    trialUsed: true,
  };

  test("a trial begins with its subscription", () => {
    expect(productEventsFromAccountChangeV1("user-1", none, trialling)).toEqual(
      [
        { name: "trial_started", userId: "user-1", kind: "standard" },
        {
          name: "subscription_changed",
          userId: "user-1",
          kind: "trialing",
          detail: "standard",
        },
      ],
    );
  });

  test("a cancellation at period end reads as cancelling", () => {
    expect(
      productEventsFromAccountChangeV1("user-1", trialling, {
        ...trialling,
        subscription: { ...subscription, cancelAtPeriodEnd: true },
      }),
    ).toEqual([
      {
        name: "subscription_changed",
        userId: "user-1",
        kind: "cancelling",
        detail: "standard",
      },
    ]);
  });

  test("a paid month and a suspension are each counted once", () => {
    const paid: PaymentsAccountV1 = {
      ...trialling,
      subscribed: true,
      paidPeriod: {
        subscriptionId: "sub_1",
        planId: "standard",
        periodStart: 7,
        periodEnd: 37,
      },
    };
    expect(productEventsFromAccountChangeV1("user-1", trialling, paid)).toEqual(
      [{ name: "paid_period", userId: "user-1", kind: "standard" }],
    );
    expect(productEventsFromAccountChangeV1("user-1", paid, paid)).toEqual([]);
    expect(
      productEventsFromAccountChangeV1("user-1", paid, {
        ...paid,
        suspended: true,
      }),
    ).toEqual([{ name: "account_suspended", userId: "user-1" }]);
  });
});
