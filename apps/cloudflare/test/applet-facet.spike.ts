// SPIKE (lane S1): does the `AppletState` design of `docs/plans/applets.md` §2
// actually work under the workerd this repo pins?
//
// Findings land in `docs/research/spike-applet-facets.md`.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { AppletStateSpike } from "./spike-applet-facet-worker.ts";

interface SpikeEnv {
  APPLET_FACETS: DurableObjectNamespace<AppletStateSpike>;
}

const spikeEnv = env as unknown as SpikeEnv;

/**
 * One kernel object plus the two loader ids for it. Loader ids are
 * process-wide and their `env` is captured on first load (result 7), so every
 * result gets its own.
 */
function applet(label: string) {
  const name = `${label}-${crypto.randomUUID()}`;
  return {
    name,
    stub: spikeEnv.APPLET_FACETS.getByName(name),
    a: { loaderId: `${name}:hash-a`, version: "A" },
    b: { loaderId: `${name}:hash-b`, version: "B" },
  };
}

describe("an Applet as a facet of a kernel Durable Object", () => {
  test("1. the kernel DO loads a module map and mounts its class as a facet", async () => {
    const { name, stub, a } = applet("mount");

    expect(await stub.mountAndVersion(a)).toBe("A");
    expect(await stub.addNote(a, "milk")).toEqual(["milk"]);
    expect(await stub.lastNote(a)).toBe("milk");
    expect(await stub.facetIdentity(a)).toEqual({
      appletId: name,
      generationId: "gen-A",
      contract: 1,
    });
  });

  test("2. facet storage survives abort + remount of different code", async () => {
    const { stub, a, b } = applet("remount");
    await stub.seedParentStorage("kernel-only");

    expect(await stub.addNote(a, "before")).toEqual(["before"]);

    stub.abortFacet("remount");

    // A different loader id, a different module map, the same facet name.
    expect(await stub.mountAndVersion(b)).toBe("B");
    expect(await stub.listNotes(b)).toEqual(["before"]);
    expect(await stub.lastNote(b)).toBe("before");
    expect(await stub.addNote(b, "after")).toEqual(["before", "after"]);

    // The parent's own storage is untouched, and invisible from inside.
    expect(await stub.readParentStorage()).toBe("kernel-only");
    const leak = await stub.facetLeakProbe(b);
    expect(leak.parentOnly).toBeNull();
    expect(leak.secretToken).toBe("undefined");
    expect(leak.loader).toBe("undefined");
    expect(leak.namespace).toBe("undefined");
  });

  test("3. facets.delete removes the facet's storage", async () => {
    const { stub, a } = applet("delete");
    await stub.seedParentStorage("kernel-only");

    expect(await stub.addNote(a, "doomed")).toEqual(["doomed"]);

    stub.abortFacet("delete");
    stub.deleteFacet();

    expect(await stub.listNotes(a)).toEqual([]);
    expect(await stub.lastNote(a)).toBeNull();
    // Deleting the facet leaves the kernel's own records alone.
    expect(await stub.readParentStorage()).toBe("kernel-only");
  });

  test("4. the facet's env is exactly IDENTITY + CAPABILITIES, egress is blocked, the loopback stub works", async () => {
    const { name, stub, a } = applet("env");

    expect(await stub.facetEnvKeys(a)).toEqual(["CAPABILITIES", "IDENTITY"]);

    const egress = await stub.facetEgress(a);
    expect(egress.blocked).toBe(true);
    expect(egress.detail).toContain("not permitted to access the internet");

    expect(await stub.facetCapabilityCall(a, "hello")).toBe(`${name}:HELLO`);
  });

  test("5a. a WebSocket upgrade reaches the facet's hibernation API through the parent", async () => {
    const { stub, a } = applet("socket");

    const response = await stub.fetch(
      new Request(
        `https://applet.invalid/socket?version=${a.version}&loaderId=${encodeURIComponent(a.loaderId)}`,
        { headers: { Upgrade: "websocket" } },
      ),
    );

    expect(response.status).toBe(101);
    const client = response.webSocket;
    expect(client).not.toBeNull();
    if (!client) return;
    client.accept();

    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 10_000);
      client.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      });
      client.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(String(event)));
      });
      client.send("ping");
    });

    expect(echoed).toBe("A:echo:ping");
    client.close(1000, "done");
  });

  test("5b. the kernel object holds the alarm for the facet and delivers the tick", async () => {
    const { stub, a } = applet("alarm");

    // The facet asks through `CAPABILITIES`, the kernel object sets the alarm,
    // and its `alarm()` handler remounts the facet and ticks it.
    expect(await stub.facetAlarmReport(a)).toEqual({ count: 0, version: null });
    await stub.scheduleFacetAlarm(a, 50);

    const deadline = Date.now() + 20_000;
    let report = await stub.facetAlarmReport(a);
    while (report.count === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      report = await stub.facetAlarmReport(a);
    }

    expect(await stub.parentAlarmDiagnostics()).toEqual({
      runs: 1,
      error: null,
    });
    expect(report).toEqual({ count: 1, version: "A" });
    expect(await stub.parentAlarm()).toBeNull();
  });

  test("6. loader identity: same id is cached code, a distinct id is new code", async () => {
    const { stub, a, b } = applet("loader");
    await stub.resetLoaderCalls();

    expect(await stub.loadedWorkerVersion(a)).toBe("A");
    // Same id, a callback that would return different code: the cache wins.
    expect(
      await stub.loadedWorkerVersion({ loaderId: a.loaderId, version: "B" }),
    ).toBe("A");
    // A distinct id loads the new code.
    expect(await stub.loadedWorkerVersion(b)).toBe("B");
    expect(await stub.loaderCalls()).toBe(2);
  });

  test("7. a loader id captures the FIRST caller's env, across Durable Objects", async () => {
    const first = applet("shared-first");
    const second = applet("shared-second");
    // Deliberately the same loader id from two different kernel objects.
    const shared = { loaderId: `shared-${crypto.randomUUID()}`, version: "A" };

    expect((await first.stub.facetIdentity(shared)).appletId).toBe(first.name);

    // The second object's facet is handed the *first* object's IDENTITY and
    // its `ctx.exports` capability stub. Recorded, not desirable.
    expect((await second.stub.facetIdentity(shared)).appletId).toBe(first.name);
    expect(await second.stub.facetCapabilityCall(shared, "hi")).toBe(
      `${first.name}:HI`,
    );
  });

  // Deliberately last: the refusal below is not catchable inside the facet and
  // is easiest to read when nothing runs after it.
  test("8. a facet cannot set its own alarm", async () => {
    const { stub, a } = applet("own-alarm");

    const refused = await stub.facetOwnAlarm(a, 50);
    expect(refused.set).toBe(false);
    expect(refused.detail).toContain("Facets currently cannot set alarms");
    // The refusal is not catchable inside the facet: it surfaces at the caller.
    expect(refused.caughtInFacet).toBe(false);
  });
});
