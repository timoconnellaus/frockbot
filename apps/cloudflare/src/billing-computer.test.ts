import { describe, expect, test } from "bun:test";
import {
  BILLING_PLAN,
  BillingError,
  type UsageReservation,
  type UsageSettlement,
} from "@frockbot/app/billing/ledger";
import {
  COMPUTER_HOST_ROUTES,
  decodeComputerHostHttpRequestV1,
  encodeComputerHostRequestV1,
  type ComputerHostOperationV1,
} from "@frockbot/computer/host-protocol";
import type { BillingAccountRpc } from "./billing";
import {
  COMPUTER_ACTIVE_MICROS_PER_HOUR,
  COMPUTER_RATE_DESCRIPTION,
  prepaidComputerHost,
} from "./billing-computer";

function request(
  operation: ComputerHostOperationV1,
  effectId = "effect-1",
): Request {
  return new Request(
    `https://computer.invalid${COMPUTER_HOST_ROUTES[operation.kind]}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        encodeComputerHostRequestV1({
          version: 1,
          effectId,
          identity: { userId: "user-1" },
          tenant: { botId: "bot-1" },
          credentialRef: "credential-1",
          operation,
        }),
      ),
    },
  );
}

class AccountSpy {
  reservations: UsageReservation[] = [];
  settlements: UsageSettlement[] = [];
  created = true;
  reserveError: Error | undefined;

  async reserveUsage(input: {
    userId: string;
    reservation: UsageReservation;
  }): Promise<{ status: "reserved"; created: boolean }> {
    expect(input.userId).toBe("user-1");
    this.reservations.push(input.reservation);
    if (this.reserveError) throw this.reserveError;
    return { status: "reserved", created: this.created };
  }

  async settleUsage(input: {
    userId: string;
    settlement: UsageSettlement;
  }): Promise<void> {
    expect(input.userId).toBe("user-1");
    this.settlements.push(input.settlement);
  }

  rpc(): BillingAccountRpc {
    return this as unknown as BillingAccountRpc;
  }
}

function host(
  respond: (request: Request) => Response | Promise<Response> = () =>
    new Response("host", { status: 200 }),
): { fetcher: Fetcher; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    fetcher: {
      async fetch(
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const incoming =
          input instanceof Request
            ? input
            : new Request(input.toString(), init);
        const request = incoming as unknown as Request;
        requests.push(request.clone() as unknown as Request);
        return respond(request);
      },
    } as Fetcher,
  };
}

function exec(timeoutMs: number, stream = false): ComputerHostOperationV1 {
  return {
    kind: "exec",
    script: "printf hello",
    timeoutMs,
    maxOutputBytes: 1_024,
    stream,
  };
}

describe("prepaidComputerHost", () => {
  test("reserves the operation maximum and settles rounded active time", async () => {
    const account = new AccountSpy();
    let now = 1_000;
    const computer = host(() => {
      now += 1_201;
      return new Response("done");
    });
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => now,
    );

    expect(await (await billed.fetch(request(exec(2_500)))).text()).toBe(
      "done",
    );

    expect(account.reservations).toEqual([
      {
        id: "computer:effect-1",
        kind: "computer",
        botId: "bot-1",
        maximumMicros: 6_494,
        description: COMPUTER_RATE_DESCRIPTION,
        pricingVersion: BILLING_PLAN.pricingVersion,
        unitRates: {
          activeMicrosPerHour: COMPUTER_ACTIVE_MICROS_PER_HOUR,
        },
      },
    ]);
    expect(account.settlements).toEqual([
      {
        id: "computer:effect-1",
        chargeMicros: 1_528,
        costMicros: 738,
        quantities: { activeSeconds: 2 },
      },
    ]);
    expect(computer.requests).toHaveLength(1);
  });

  test("prepays viewer open and renewal windows", async () => {
    const account = new AccountSpy();
    let now = 10;
    const computer = host(() => {
      now += 1;
      return new Response("viewer");
    });
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => now,
    );

    await billed.fetch(
      request({
        kind: "viewer",
        action: "open",
        sessionId: "session-1",
      }),
    );
    await billed.fetch(
      request(
        {
          kind: "viewer",
          action: "renew",
          sessionId: "session-1",
        },
        "effect-2",
      ),
    );

    expect(
      account.reservations.map(({ maximumMicros }) => maximumMicros),
    ).toEqual([22_917, 22_917]);
    expect(account.settlements.map(({ chargeMicros }) => chargeMicros)).toEqual(
      [22_917, 22_917],
    );
    expect(account.settlements.map(({ costMicros }) => costMicros)).toEqual([
      11_070, 11_070,
    ]);
    expect(account.settlements.map(({ quantities }) => quantities)).toEqual([
      { activeSeconds: 30 },
      { activeSeconds: 30 },
    ]);
  });

  test("revokes a viewer when renewal prepayment is rejected", async () => {
    const account = new AccountSpy();
    account.reserveError = new BillingError("credit exhausted", 402);
    const computer = host();
    const billed = prepaidComputerHost(computer.fetcher, () => account.rpc());

    const response = await billed.fetch(
      request({
        kind: "viewer",
        action: "renew",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(402);
    expect(account.settlements).toEqual([]);
    expect(computer.requests).toHaveLength(1);
    const decoded = await decodeComputerHostHttpRequestV1(
      computer.requests[0]! as unknown as Parameters<
        typeof decodeComputerHostHttpRequestV1
      >[0],
    );
    expect(decoded.ok && decoded.value.operation).toEqual({
      kind: "viewer",
      action: "revoke",
      sessionId: "session-1",
    });
  });

  test("forwards cleanup operations without billing", async () => {
    const account = new AccountSpy();
    const computer = host();
    const billed = prepaidComputerHost(computer.fetcher, () => account.rpc());

    const operations: ComputerHostOperationV1[] = [
      { kind: "cancel" },
      { kind: "viewer", action: "revoke", sessionId: "session-1" },
      {
        kind: "control",
        action: "release",
        ownerId: "owner-1",
        maxAgeSeconds: 30,
      },
    ];
    for (const [index, operation] of operations.entries()) {
      expect(
        (await billed.fetch(request(operation, `cleanup-${index}`))).status,
      ).toBe(200);
    }

    expect(account.reservations).toEqual([]);
    expect(account.settlements).toEqual([]);
    expect(computer.requests).toHaveLength(3);
  });

  test("forwards duplicate reservations without settling them twice", async () => {
    const account = new AccountSpy();
    account.created = false;
    const computer = host();
    const billed = prepaidComputerHost(computer.fetcher, () => account.rpc());

    expect((await billed.fetch(request(exec(1_000)))).status).toBe(200);

    expect(account.reservations).toHaveLength(1);
    expect(account.settlements).toEqual([]);
    expect(computer.requests).toHaveLength(1);
  });

  test("reserves the host's full service-operation bound", async () => {
    const account = new AccountSpy();
    account.created = false;
    const computer = host();
    const billed = prepaidComputerHost(computer.fetcher, () => account.rpc());

    expect(
      (
        await billed.fetch(
          request({ kind: "service", name: "renderer-watchdog" }),
        )
      ).status,
    ).toBe(200);

    expect(account.reservations).toHaveLength(1);
    expect(account.reservations[0]?.maximumMicros).toBe(91_667);
    expect(account.settlements).toEqual([]);
  });

  test("settles a streaming response only after its body completes", async () => {
    const account = new AccountSpy();
    let now = 0;
    const computer = host(() => {
      now += 500;
      return new Response("two chunks");
    });
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => now,
    );

    const response = await billed.fetch(request(exec(10_000, true)));
    expect(account.settlements).toEqual([]);

    expect(await response.text()).toBe("two chunks");
    expect(account.settlements).toEqual([
      {
        id: "computer:effect-1",
        chargeMicros: 764,
        costMicros: 369,
        quantities: { activeSeconds: 1 },
      },
    ]);
  });

  test("settles a streaming response with no body immediately", async () => {
    const account = new AccountSpy();
    const computer = host(() => new Response(null, { status: 204 }));
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => 100,
    );

    const response = await billed.fetch(request(exec(10_000, true)));

    expect(response.status).toBe(204);
    expect(account.settlements).toEqual([
      {
        id: "computer:effect-1",
        chargeMicros: 764,
        costMicros: 369,
        quantities: { activeSeconds: 1 },
      },
    ]);
  });

  test("rejects malformed input before touching billing or the host", async () => {
    const account = new AccountSpy();
    const computer = host();
    const billed = prepaidComputerHost(computer.fetcher, () => account.rpc());

    const response = await billed.fetch(
      new Request(`https://computer.invalid${COMPUTER_HOST_ROUTES.exec}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }),
    );

    expect(response.status).toBe(400);
    expect(account.reservations).toEqual([]);
    expect(account.settlements).toEqual([]);
    expect(computer.requests).toEqual([]);
  });

  test("keeps a thrown host failure reserved for reconciliation", async () => {
    const account = new AccountSpy();
    const failure = new Error("host unavailable");
    const computer = host(() => {
      throw failure;
    });
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => 100,
    );

    await expect(billed.fetch(request(exec(1_000)))).rejects.toBe(failure);

    expect(account.reservations).toHaveLength(1);
    expect(account.settlements).toEqual([]);
  });
});
