import { describe, expect, test } from "bun:test";
import {
  BILLING_PLAN,
  BillingError,
  type UsageReservation,
  type UsageSettlement,
} from "@frockbot/app/billing/ledger";
import {
  createAgentRuntimeHarness,
  frockbotToolCall,
} from "@frockbot/app/testkit";
import { createComputerAgentFeature } from "@frockbot/computer/agent";
import { computerOperationIdV1 } from "@frockbot/computer/core";
import {
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_STREAM_MEDIA_TYPE,
  decodeComputerHostHttpRequestV1,
  encodeComputerHostExecFrameV1,
  encodeComputerHostOpenFrameV1,
  encodeComputerHostRequestV1,
  type ComputerHostOperationV1,
} from "@frockbot/computer/host-protocol";
import type { BillingAccountRpc } from "./billing";
import {
  COMPUTER_ACTIVE_MICROS_PER_HOUR,
  COMPUTER_RATE_DESCRIPTION,
  prepaidComputerHost,
} from "./billing-computer";
import { createComputerHostV1 } from "./computer-host";

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
  test("a missing warm viewer bills only the probe, not a viewing window", async () => {
    const account = new AccountSpy();
    const computer = host(() =>
      Response.json({ code: "not-found" }, { status: 404 }),
    );
    const billed = prepaidComputerHost(
      computer.fetcher,
      () => account.rpc(),
      () => 100,
    );
    expect(
      (await billed.fetch(request({ kind: "viewer", action: "open" }))).status,
    ).toBe(404);
    expect(account.settlements[0]?.quantities).toEqual({ activeSeconds: 1 });
  });

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

describe("a Computer tool call's reservation", () => {
  /** A host that opens the Computer, mints a viewer, and runs every command. */
  function computerHost(): Fetcher {
    return host(async (request) => {
      const decoded = await decodeComputerHostHttpRequestV1(
        request as unknown as Parameters<
          typeof decodeComputerHostHttpRequestV1
        >[0],
      );
      if (!decoded.ok) return decoded.response;
      const { effectId, operation } = decoded.value;
      if (operation.kind === "open") {
        const result = {
          version: 1 as const,
          effectId,
          instanceId: "computer-1",
          directory: "agent-data/agents/tenant",
          display: ":100",
          generation: 1,
        };
        return operation.stream
          ? new Response(
              encodeComputerHostOpenFrameV1({ type: "result", result }),
              { headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE } },
            )
          : Response.json(result);
      }
      if (operation.kind === "viewer") {
        return Response.json({
          version: 1,
          effectId,
          session: { id: "viewer-1", url: "https://viewer.invalid/" },
        });
      }
      if (operation.kind === "exec" && operation.stream) {
        return new Response(
          encodeComputerHostExecFrameV1({
            type: "exit",
            exitCode: 0,
            outputTruncated: false,
          }),
          { headers: { "content-type": COMPUTER_HOST_STREAM_MEDIA_TYPE } },
        );
      }
      return Response.json({
        version: 1,
        effectId,
        exitCode: 0,
        stdoutBase64: "",
        stderrBase64: "",
        outputTruncated: false,
      });
    }).fetcher;
  }

  /** One `computer_exec` call from one Turn of one Bot, through billing. */
  async function exec(
    account: AccountSpy,
    call: { botId: string; runId: string; sessionId: string },
  ): Promise<void> {
    const harness = createAgentRuntimeHarness();
    harness.computers.register(
      createComputerHostV1({
        fetcher: prepaidComputerHost(computerHost(), () => account.rpc()),
        hostToken: "host-token",
      }),
    );
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "computer-host",
        writer: {
          sessionId: call.sessionId,
          turnId: call.runId,
          runId: call.runId,
        },
      }),
    );
    const context = {
      botId: call.botId,
      agentId: call.runId,
      compositionGenerationId: "bootstrap",
      turnType: "chat" as const,
      sessionId: call.sessionId,
      // Every Session's first tool call.
      effectId: "tool:1:1:0",
      signal: new AbortController().signal,
    };
    const prepared = await harness.tools.prepare(
      frockbotToolCall("computer_exec", { command: "true" }),
      context,
    );
    if (prepared.kind !== "ready") throw new Error(prepared.result.content);
    await harness.tools.executePrepared(prepared, context);
    await harness.dispose();
  }

  /**
   * The ids the tool call itself was billed under. Attaching the Computer
   * names no call, so the transport gives each of its requests a random one.
   */
  function operationIds(billed: readonly { id: string }[]): string[] {
    return billed
      .map((entry) => entry.id)
      .filter((id) => !/^computer:[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id));
  }

  test("is the durable call's, so a second Session or Bot never shares it", async () => {
    const account = new AccountSpy();
    const chat = { botId: "bot-1", runId: "run-1", sessionId: "user-1:bot-1" };

    await exec(account, chat);
    await exec(account, {
      botId: "bot-1",
      runId: "run-2",
      sessionId: "routine:daily",
    });
    // Run ids are only unique per Bot, so another Bot may reuse this one.
    await exec(account, { ...chat, botId: "bot-2", sessionId: "user-1:bot-2" });
    // A re-dispatched call is the same durable call.
    await exec(account, chat);

    const reserved = operationIds(account.reservations);
    expect(reserved).toHaveLength(4);
    expect(reserved[0]).toBe(
      `computer:${await computerOperationIdV1({
        botId: "bot-1",
        runId: "run-1",
        effectId: "tool:1:1:0",
      })}`,
    );
    expect(new Set(reserved.slice(0, 3)).size).toBe(3);
    expect(reserved[3]).toBe(reserved[0]);
    expect(operationIds(account.settlements)).toEqual(reserved);
  });
});
