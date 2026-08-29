import { describe, expect, test } from "bun:test";
import {
  createOwnedMobileDisposer,
  retainStartedResource,
} from "./owned-disposal.ts";

describe("mobile client ownership", () => {
  test("disposes a Cordis host that finishes starting after pagehide", async () => {
    let resolve!: (value: { dispose(): Promise<void> }) => void;
    let disposals = 0;
    const pending = new Promise<{ dispose(): Promise<void> }>((done) => {
      resolve = done;
    });
    const retained = retainStartedResource(pending, () => true);
    resolve({
      dispose: () => {
        disposals += 1;
        return Promise.resolve();
      },
    });
    expect(await retained).toBeUndefined();
    expect(disposals).toBe(1);
  });

  test("unmounts Vue and disposes the Cordis host exactly once", async () => {
    let unmounts = 0;
    let hostDisposals = 0;
    const dispose = createOwnedMobileDisposer(
      () => {
        unmounts += 1;
      },
      () => {
        hostDisposals += 1;
        return Promise.resolve();
      },
    );
    const first = dispose();
    const second = dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(unmounts).toBe(1);
    expect(hostDisposals).toBe(1);
  });
});
