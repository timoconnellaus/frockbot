import { describe, expect, test } from "bun:test";
import { createFlockAiGatewayHostV1 } from "./flock-ai.js";

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

describe("Flock AI Gateway host", () => {
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
