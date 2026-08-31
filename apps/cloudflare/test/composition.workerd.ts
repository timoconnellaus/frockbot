import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

function probe(name: string) {
  return env.COMPOSITIONS.getByName(name);
}

describe("Composition generations in Workerd", () => {
  test("an admitted Turn records its Composition generation", async () => {
    const stub = probe(`admit-${crypto.randomUUID()}`);
    const current = await stub.currentGenerationId();

    const result = await stub.runTurn("run-1");

    expect(result.pinned).toBe(current);
    expect(await stub.storedPin("run-1")).toBe(current);
  });

  test("the pinned generation is stable across Durable Object eviction", async () => {
    const stub = probe(`evict-${crypto.randomUUID()}`);
    await stub.runTurn("run-1");
    const pinned = await stub.storedPin("run-1");
    const next = await stub.proposeGeneration("2026-09-01T00:00:00.000Z");
    await stub.commitGeneration(next);

    await evictDurableObject(stub);

    expect(await stub.storedPin("run-1")).toBe(pinned);
    expect(await stub.currentGenerationId()).toBe(next);
    await stub.runTurn("run-2");
    expect(await stub.storedPin("run-2")).toBe(next);
    expect(await stub.storedPin("run-1")).toBe(pinned);
  });

  test("committing a generation during a Turn does not move that Turn", async () => {
    const stub = probe(`inflight-${crypto.randomUUID()}`);
    const admitted = await stub.currentGenerationId();
    await stub.commitDuringNextTurn("2026-09-02T00:00:00.000Z");

    const result = await stub.runTurn("run-1");

    expect(result.pinned).toBe(admitted);
    expect(await stub.storedPin("run-1")).toBe(admitted);
    expect(await stub.currentGenerationId()).not.toBe(admitted);
    await evictDurableObject(stub);
    expect(await stub.storedPin("run-1")).toBe(admitted);
  });

  test("lists generations newest first and paginates by cursor", async () => {
    const stub = probe(`list-${crypto.randomUUID()}`);
    const bootstrap = await stub.currentGenerationId();
    const created: string[] = [];
    for (const day of ["01", "02", "03"]) {
      created.push(
        await stub.proposeGeneration(`2026-09-${day}T00:00:00.000Z`),
      );
    }

    const first = await stub.listGenerations({ limit: 2 });
    expect(first.generationIds).toEqual([created[2], created[1]]);
    expect(first.cursor).toBeDefined();

    const second = await stub.listGenerations({
      limit: 2,
      cursor: first.cursor,
    });
    expect(second.generationIds).toEqual([created[0], bootstrap]);
  });
});
