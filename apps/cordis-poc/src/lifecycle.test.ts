import { afterEach, describe, expect, test } from "bun:test";
import { Context, Service, type Plugin } from "cordis";

interface FoundationEvents {
  "foundation/probe": () => void;
}

declare module "cordis" {
  interface Context {
    marker: MarkerService;
  }

  interface Events extends FoundationEvents {}
}

class MarkerService extends Service {
  constructor(ctx: Context) {
    super(ctx, "marker");
  }
}

const roots: Context[] = [];

function createRoot(): Context {
  const root = new Context();
  roots.push(root);
  return root;
}

async function eventually(
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw latestError;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("pinned Cordis lifecycle", () => {
  test("owns setup and cleanup exactly once across repeated mounts", async () => {
    const root = createRoot();
    let setups = 0;
    let cleanups = 0;
    const tracked: Plugin.Function = () => {
      setups += 1;
      return () => {
        cleanups += 1;
      };
    };

    for (let index = 0; index < 100; index += 1) {
      const fiber = await root.plugin(tracked);
      await fiber.dispose();
    }

    expect(setups).toBe(100);
    expect(cleanups).toBe(100);
  });

  test("moves a dependent plugin between pending and active", async () => {
    const root = createRoot();
    let activations = 0;
    let disposals = 0;
    const dependent: Plugin.Function = () => {
      activations += 1;
      return () => {
        disposals += 1;
      };
    };
    dependent.inject = ["marker"];

    const dependentFiber = root.plugin(dependent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activations).toBe(0);

    const firstProvider = await root.plugin(MarkerService);
    await dependentFiber;
    expect(activations).toBe(1);

    await firstProvider.dispose();
    await eventually(() => expect(disposals).toBe(1));

    const secondProvider = await root.plugin(MarkerService);
    await eventually(() => expect(activations).toBe(2));

    await dependentFiber.dispose();
    await secondProvider.dispose();
    expect(disposals).toBe(2);
  });

  test("does not remove a parent listener when an isolated child unloads", async () => {
    const root = createRoot();
    let parentHits = 0;
    root.on("foundation/probe", () => {
      parentHits += 1;
    });

    const child = root.isolate("marker");
    const childFiber = await child.plugin((ctx) => {
      ctx.on("foundation/probe", () => undefined);
    });
    await childFiber.dispose();

    root.emit("foundation/probe");
    expect(parentHits).toBe(1);
  });
});
