import { describe, expect, test } from "bun:test";
import { OllamaCloudClient } from "./client.js";

describe("Ollama Cloud client", () => {
  test("discovers account models and normalizes provider capabilities", async () => {
    const requests: Request[] = [];
    const client = new OllamaCloudClient({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/tags")) {
          return Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] });
        }
        return Response.json({
          capabilities: ["completion", "tools", "thinking"],
          model_info: { "glm.context_length": 1_048_576 },
        });
      },
    });

    expect(await client.listModels("account-key")).toEqual([
      {
        providerModelId: "glm-5.3-flash:cloud",
        displayName: "glm-5.3-flash",
        contextWindow: 1_048_576,
        capabilities: { tools: true, vision: false, reasoning: true },
        source: "discovered",
      },
    ]);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer account-key",
      ),
    ).toBe(true);
  });

  test("rejects provider model metadata outside the catalog contract", async () => {
    let requests = 0;
    const client = new OllamaCloudClient({
      fetch: (input) => {
        requests += 1;
        return Promise.resolve(
          String(input).endsWith("/tags")
            ? Response.json({ models: [{ model: "x".repeat(257) }] })
            : Response.json({ capabilities: [] }),
        );
      },
    });

    await expect(client.listModels("account-key")).rejects.toThrow(
      "Ollama Cloud model id is invalid",
    );
    expect(requests).toBe(1);
  });

  test("does not expose provider response bodies in errors", async () => {
    const client = new OllamaCloudClient({
      fetch: () =>
        Promise.resolve(
          new Response("credential=do-not-leak", { status: 401 }),
        ),
    });

    await expect(client.listModels("secret")).rejects.toThrow(
      "Ollama Cloud request failed (401)",
    );
  });
});
