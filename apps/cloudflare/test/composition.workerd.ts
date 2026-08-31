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

  test("a revert records a new generation the next admitted Turn pins", async () => {
    const stub = probe(`revert-${crypto.randomUUID()}`);
    const bootstrap = await stub.currentGenerationId();
    const authored = await stub.proposeGeneration("2026-09-01T00:00:00.000Z");
    await stub.commitGeneration(authored);
    await stub.runTurn("run-1");

    const reverted = await stub.revertGeneration(bootstrap);

    expect(reverted).not.toBe(bootstrap);
    expect(reverted).not.toBe(authored);
    // The target is a record: reverting to it never mutates or reactivates it.
    expect(await stub.generationStatus(bootstrap)).toBe("superseded");
    expect(await stub.generationStatus(reverted)).toBe("pending");
    expect(await stub.currentGenerationId()).toBe(authored);

    await evictDurableObject(stub);
    await stub.commitGeneration(reverted);
    await stub.runTurn("run-2");

    expect(await stub.currentGenerationId()).toBe(reverted);
    expect(await stub.storedPin("run-1")).toBe(authored);
    expect(await stub.storedPin("run-2")).toBe(reverted);
  });

  test("refuses reverting to an unknown or already current generation", async () => {
    const stub = probe(`revert-refuse-${crypto.randomUUID()}`);
    const bootstrap = await stub.currentGenerationId();

    expect(await stub.revertRefusal("missing")).toContain("is unknown");
    expect(await stub.revertRefusal(bootstrap)).toContain("is already current");
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
