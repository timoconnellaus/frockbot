/**
 * Spike S2 (`docs/plans/applets.md` D12c): Miniflare embedded in a Node process,
 * running an Applet class as a SQLite Durable Object with function service
 * bindings and a hibernating WebSocket.
 *
 * Findings, against `miniflare@5.20260828.0-alpha` / `workerd@1.20260828.1`:
 *
 * 1. **It works.** A `DurableObject` subclass from `cloudflare:workers`, loaded
 *    as a plain ESM module, gets SQLite storage, `ctx.acceptWebSocket`, and
 *    `ctx.storage.transactionSync`, and answers RPC from the dev worker.
 * 2. **Miniflare 5 changed its option shape.** The flat v4 object
 *    (`{ modules, durableObjects, serviceBindings, … }`) is rejected: v5's
 *    schema is the wrangler config (`{ workers: [{ config: { … } }] }`).
 *    `convertV4MiniflareOptions()` is exported for exactly this and is what
 *    `src/cli/runtime.ts` uses, so the SDK keeps speaking the documented shape.
 * 3. `useSQLite: true` on the DO binding is required; without it
 *    `ctx.storage.sql` is absent.
 * 4. Function `serviceBindings` work as documented — `async (request) =>
 *    Response` — which is how `applet dev` answers `CAPABILITIES` with
 *    `{ status: "unavailable", reason: "dev" }` in this slice.
 * 5. A WebSocket upgrade forwarded from the worker to `stub.fetch(request)`
 *    reaches `webSocketMessage` on the hibernation API, and a Node client
 *    (the global `WebSocket`) can drive it over the port `await mf.ready`
 *    reports. `port: 0` picks a free port.
 * 6. One instance per process. Two `Miniflare` instances alive at once in the
 *    same Node process made `await mf.ready` hang here; disposing before
 *    starting the next is reliable, and is what this file and `applet dev` do.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import { startAppletRuntime } from "../src/cli/runtime.js";

/** A hand-written Applet, so the spike does not depend on the bundler. */
const SERVER = `
import { DurableObject } from "cloudflare:workers";

export class Applet extends DurableObject {
  #ready() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS notes ("id" TEXT PRIMARY KEY NOT NULL, "text" TEXT NOT NULL)',
    );
  }
  async health() {
    this.#ready();
    const capability = await this.env.CAPABILITIES.fetch("https://capabilities/model");
    return { contract: 1, tools: [], schemaRevision: 1, capability: await capability.json() };
  }
  async invokeTool(name, input) {
    this.#ready();
    return JSON.stringify({ name, input });
  }
  async fetch(request) {
    this.#ready();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "hello" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(socket, message) {
    const note = JSON.parse(message);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO notes ("id", "text") VALUES (?, ?)', note.id, note.text);
    });
    const rows = this.ctx.storage.sql.exec("SELECT * FROM notes").toArray();
    for (const peer of this.ctx.getWebSockets()) {
      peer.send(JSON.stringify({ type: "rows", rows }));
    }
  }
}
`;

describe("Miniflare embedded in Node", () => {
  const token = randomUUID();
  let runtime: Awaited<ReturnType<typeof startAppletRuntime>>;

  beforeAll(async () => {
    runtime = await startAppletRuntime({
      serverCode: SERVER,
      appletId: "spike",
      token,
      html: "<!doctype html><body>spike</body>",
    });
  }, 120_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  it("runs an Applet class as a SQLite DO with a function service binding", async () => {
    expect(runtime.url.port).not.toBe("0");

    const health = await (await runtime.fetch("/health")).json();
    expect(health).toMatchObject({
      contract: 1,
      // The service binding answered, so model calls are unavailable in dev.
      capability: { status: "unavailable", reason: "dev" },
    });

    const tool = await (
      await runtime.fetch("/tool", {
        method: "POST",
        body: JSON.stringify({ name: "noop", input: { a: 1 } }),
      })
    ).json();
    expect(tool).toEqual({
      ok: true,
      result: '{"name":"noop","input":{"a":1}}',
    });
  }, 120_000);

  it("upgrades a WebSocket from a plain Node client and persists a write", async () => {
    const url = `${runtime.url.toString().replace(/^http/, "ws")}socket?token=${token}`;
    const socket = new WebSocket(url);
    const frames: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) =>
      frames.push(JSON.parse(String(event.data)) as Record<string, unknown>),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("upgrade failed")),
        {
          once: true,
        },
      );
    });

    socket.send(JSON.stringify({ id: "1", text: "hello" }));
    const deadline = Date.now() + 10_000;
    while (
      !frames.some((frame) => frame.type === "rows") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(frames.find((frame) => frame.type === "rows")).toEqual({
      type: "rows",
      rows: [{ id: "1", text: "hello" }],
    });
    socket.close();
  }, 120_000);
});
