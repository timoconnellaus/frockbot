import { describe, expect, test } from "bun:test";
import {
  compatChatCompletionsUrlV1,
  createFlockAiGatewayHostV1,
} from "./flock-ai.js";

const ACCOUNT_ID = "account-under-test";
const TOKEN = "gateway-token";

/**
 * A stand-in for the `AI` binding's Gateway seam. Only `gateway(id).run()` is
 * reached from here, and the generated `Ai` type is far wider than the one
 * operation this host consumes.
 */
function gatewayHost(respond: () => Response) {
  const gatewayIds: string[] = [];
  const ai = {
    gateway(gatewayId: string) {
      gatewayIds.push(gatewayId);
      return { run: () => Promise.resolve(respond()) };
    },
  } as unknown as Pick<Ai, "gateway">;
  return { ai, gatewayIds };
}

/** An `AI` binding that fails the test if the compat transport ever leaves it. */
function unusedBinding(): Pick<Ai, "gateway"> {
  return {
    gateway() {
      throw new Error(
        "the AI binding must not be used by the compat transport",
      );
    },
  } as unknown as Pick<Ai, "gateway">;
}

function compatHost(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const host = createFlockAiGatewayHostV1(unusedBinding(), {
    gatewayId: "flock-test",
    accountId: ACCOUNT_ID,
    token: TOKEN,
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    }) as unknown as typeof fetch,
  });
  return { host, calls };
}

describe("Flock AI Gateway host, compat transport", () => {
  // The `AI` binding's `gateway(...).run()` reaches the universal endpoint,
  // whose translation rejects a `dynamic/<route>` model before inference
  // (cloudflare/ai#617). Configuring an account and token has to move the
  // request onto the compat HTTP endpoint, which accepts it.
  test("posts to the compat endpoint with the Gateway authorization", async () => {
    const { host, calls } = compatHost(() => new Response("data: [DONE]\n\n"));

    const body = await host.runChatCompletion("dynamic/flock-auto", {
      messages: [],
      stream: true,
    });

    expect(await new Response(body).text()).toBe("data: [DONE]\n\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      compatChatCompletionsUrlV1(ACCOUNT_ID, "flock-test"),
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(
      (calls[0]!.init.headers as Record<string, string>)[
        "cf-aig-authorization"
      ],
    ).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messages: [],
      stream: true,
      model: "dynamic/flock-auto",
    });
  });

  test("rejects a compat error response before it reaches the stream decoder", async () => {
    const { host } = compatHost(
      () =>
        new Response(JSON.stringify({ error: "upstream said no" }), {
          status: 400,
        }),
    );

    const failure = await host
      .runChatCompletion("dynamic/flock-auto", { messages: [] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).message).toBe(
      'AI Gateway rejected the request (400): {"error":"upstream said no"}',
    );
  });

  test("stays on the binding when only one half of the credentials is set", async () => {
    const { ai, gatewayIds } = gatewayHost(
      () => new Response("data: [DONE]\n\n"),
    );
    const host = createFlockAiGatewayHostV1(ai, {
      gatewayId: "flock-test",
      accountId: ACCOUNT_ID,
    });

    await host.runChatCompletion("dynamic/flock-auto", { messages: [] });

    expect(gatewayIds).toEqual(["flock-test"]);
  });
});

describe("Flock AI Gateway host, binding transport", () => {
  test("returns the response stream for an accepted request", async () => {
    const { ai, gatewayIds } = gatewayHost(
      () => new Response("data: [DONE]\n\n"),
    );
    const host = createFlockAiGatewayHostV1(ai, { gatewayId: "flock-test" });

    const body = await host.runChatCompletion("dynamic/auto", {
      messages: [],
    });

    expect(await new Response(body).text()).toBe("data: [DONE]\n\n");
    expect(gatewayIds).toEqual(["flock-test"]);
  });

  // A rejected request answers with a JSON error body, not an SSE stream.
  // Returned as a stream it decodes as one that ends before its terminal
  // marker, which the Agent reads as an *uncertain* outcome and parks the run
  // on — so this has to fail here, where it is still definitive.
  test.each([400, 401, 429, 500, 503])(
    "rejects a %i gateway response before it reaches the stream decoder",
    async (status) => {
      const { ai } = gatewayHost(
        () =>
          new Response(JSON.stringify({ error: "upstream said no" }), {
            status,
          }),
      );
      const host = createFlockAiGatewayHostV1(ai, {});

      const failure = await host
        .runChatCompletion("dynamic/auto", { messages: [] })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        `AI Gateway rejected the request (${status}): {"error":"upstream said no"}`,
      );
    },
  );

  test("names the status when the rejection carries no body", async () => {
    const { ai } = gatewayHost(() => new Response(null, { status: 502 }));
    const host = createFlockAiGatewayHostV1(ai, {});

    const failure = await host
      .runChatCompletion("dynamic/auto", { messages: [] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).message).toBe(
      "AI Gateway rejected the request (502)",
    );
  });

  test("truncates an oversized rejection body", async () => {
    const { ai } = gatewayHost(
      () => new Response("x".repeat(2000), { status: 500 }),
    );
    const host = createFlockAiGatewayHostV1(ai, {});

    const failure = await host
      .runChatCompletion("dynamic/auto", { messages: [] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).message).toBe(
      `AI Gateway rejected the request (500): ${"x".repeat(512)}`,
    );
  });
});

describe("Flock AI gateway deadline", () => {
  test("a gateway that never answers fails the request", async () => {
    const ai = {
      gateway() {
        return { run: () => new Promise<Response>(() => {}) };
      },
    } as unknown as Pick<Ai, "gateway">;
    const host = createFlockAiGatewayHostV1(ai, { timeoutMs: 20 });

    await expect(
      host.runChatCompletion("dynamic/auto", { messages: [] }),
    ).rejects.toThrow("AI Gateway did not respond within 20ms");
  });

  test("a compat transport that never answers fails the request", async () => {
    const host = createFlockAiGatewayHostV1(unusedBinding(), {
      accountId: ACCOUNT_ID,
      token: TOKEN,
      timeoutMs: 20,
      fetch: ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        })) as typeof fetch,
    });

    await expect(
      host.runChatCompletion("dynamic/auto", { messages: [] }),
    ).rejects.toThrow("AI Gateway did not respond within 20ms");
  });
});
