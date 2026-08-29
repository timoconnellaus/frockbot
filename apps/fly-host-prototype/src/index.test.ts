import { describe, expect, test } from "bun:test";
import { routeFlyHostRequest } from "./router.ts";

const requestBody = {
  version: 1,
  effectId: "effect-123",
  botId: "bot-123",
  credentialRef: "sprites:prototype",
  probe: "hello",
};

describe("shared Fly host Worker", () => {
  test("routes a decoded v1 DTO to a stable shared shard", async () => {
    let selectedShard = "";
    let forwarded: unknown;
    const response = await routeFlyHostRequest(
      new Request("http://localhost/v1/computer/smoke", {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
      {
        credentialRef: "sprites:prototype",
        shards: 3,
      },
      (shard: string) => {
        selectedShard = shard;
        return {
          async fetch(request: Request) {
            forwarded = await request.json();
            return Response.json({ ok: true });
          },
        };
      },
    );

    expect(response.status).toBe(200);
    expect(selectedShard).toBe("shared-2");
    expect(forwarded).toEqual(requestBody);
  });

  test("rejects invalid routes, DTOs, and credential references", async () => {
    const route = (request: Request) =>
      routeFlyHostRequest(
        request,
        { credentialRef: "sprites:prototype", shards: 1 },
        () => ({ fetch: () => Promise.resolve(new Response()) }),
      );

    expect((await route(new Request("http://localhost/nope"))).status).toBe(
      404,
    );
    expect(
      (
        await route(
          new Request("http://localhost/v1/computer/smoke", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await route(
          new Request("http://localhost/v1/computer/smoke", {
            method: "POST",
            body: JSON.stringify({
              ...requestBody,
              credentialRef: "sprites:someone-else",
            }),
          }),
        )
      ).status,
    ).toBe(403);
  });
});
