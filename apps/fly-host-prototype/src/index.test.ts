import { describe, expect, test } from "bun:test";
import {
  computerHostEffectRequestWireV1,
  computerHostEffectResponseWireV1,
} from "@frockbot/computer-core/host-protocol";
import { ComputerEffectJournal } from "./effect-journal.ts";
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

  test("journals one shared-host effect and replays its durable outcome", async () => {
    const values = new Map<string, unknown>();
    const storage = {
      get: <T>(key: string) =>
        Promise.resolve(values.get(key) as T | undefined),
      put: (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
        return Promise.resolve();
      },
      transaction: async <T>(
        run: (transaction: {
          get<V>(key: string): Promise<V | undefined>;
          put(key: string, value: unknown): Promise<void>;
        }) => Promise<T>,
      ) => run(storage),
    };
    let executions = 0;
    const env = {
      FLY_HOST_SHARDS: "1",
      FLY_HOST: {
        getByName: () => ({
          fetch: async () => {
            executions += 1;
            return Response.json(
              computerHostEffectResponseWireV1({
                schemaVersion: 1,
                effectId: "tool:1:1:0",
                status: "completed",
                result: {
                  type: "browser",
                  result: { accessibilitySnapshot: "ready" },
                },
              }),
            );
          },
        }),
      },
    };
    const journal = new ComputerEffectJournal(
      { storage } as unknown as DurableObjectState,
      env as never,
    );
    const effect = computerHostEffectRequestWireV1({
      schemaVersion: 1,
      effectId: "tool:1:1:0",
      target: { userId: "user-1", botId: "bot-1" },
      assignment: { providerId: "shared-computer", generation: 1 },
      operation: { type: "browser", action: { type: "snapshot" } },
    });
    const invoke = () =>
      journal.fetch(
        new Request("https://computer-host.internal/v1/effects", {
          method: "POST",
          body: JSON.stringify(effect),
        }),
      );

    expect(await (await invoke()).json()).toMatchObject({
      status: "completed",
      effectId: "tool:1:1:0",
    });
    expect(await (await invoke()).json()).toMatchObject({
      status: "completed",
      effectId: "tool:1:1:0",
    });
    expect(executions).toBe(1);
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
