import { describe, expect, it } from "bun:test";
import { performHttpGrant } from "../src/http";

const services = {
  api: {
    origin: "https://api.example",
    credential: { header: "authorization", value: "Bearer synthetic" },
  },
};

const operation = (options?: unknown) => ({
  method: "fetch",
  args: ["api", "/records", options],
});

describe("the Cloudflare HTTP grant boundary", () => {
  it("does not forward a credential through a cross-origin redirect", async () => {
    const seen: Array<{
      origin: string;
      authorization: string | null;
      redirect: string;
    }> = [];
    const binding = {
      fetch(request: Request): Response {
        seen.push({
          origin: new URL(request.url).origin,
          authorization: request.headers.get("authorization"),
          redirect: request.redirect,
        });
        return Response.redirect("https://attacker.example/stolen", 302);
      },
    };

    await expect(
      performHttpGrant({ services, bindings: { api: binding } }, operation()),
    ).rejects.toThrow("redirect");
    expect(seen).toEqual([
      {
        origin: "https://api.example",
        authorization: "Bearer synthetic",
        redirect: "manual",
      },
    ]);
    expect(
      seen.some(({ origin }) => origin === "https://attacker.example"),
    ).toBe(false);
  });

  it("rejects RequestInit fields outside the wire whitelist", async () => {
    let called = false;
    await expect(
      performHttpGrant(
        {
          services,
          fetch: () => {
            called = true;
            return new Response("unexpected");
          },
        },
        operation({ redirect: "follow" }),
      ),
    ).rejects.toThrow('field "redirect" is not allowed');
    expect(called).toBe(false);
  });

  it("enforces a wall-clock deadline", async () => {
    await expect(
      performHttpGrant(
        {
          services,
          timeoutMs: 10,
          fetch: () => new Promise<Response>(() => undefined),
        },
        operation(),
      ),
    ).rejects.toThrow("exceeded 10 ms");
  });

  it("bounds the response body read", async () => {
    await expect(
      performHttpGrant(
        {
          services,
          maxResponseBytes: 4,
          fetch: () => new Response("12345"),
        },
        operation(),
      ),
    ).rejects.toThrow("exceeds 4 bytes");
  });
});
