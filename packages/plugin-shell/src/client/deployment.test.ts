import { describe, expect, test } from "bun:test";
import {
  DEPLOYMENT_RELOAD_INTERVAL_MS_V1,
  DEPLOYMENT_RELOAD_MARKER_V1,
  DEPLOYMENT_UPDATED_MESSAGE_V1,
  deploymentFollowV1,
  deploymentStaleV1,
  readDeploymentReloadV1,
  writeDeploymentReloadV1,
  type DeploymentFollowInputV1,
  type DeploymentReloadStoreV1,
} from "./deployment.ts";

const idle: DeploymentFollowInputV1 = {
  stale: true,
  turnRunning: false,
  draft: "",
  overlayOpen: false,
  listening: false,
  holds: 0,
  now: 10_000_000,
};

describe("deploymentStaleV1", () => {
  test("a page whose application still answers is current", () => {
    expect(deploymentStaleV1("hash-a", "hash-a")).toBe(false);
  });

  test("a page answered by another application is behind", () => {
    expect(deploymentStaleV1("hash-a", "hash-b")).toBe(true);
  });

  test("a document that names no application is never behind", () => {
    // The vite development document stamps no application hash, and local
    // development reloads itself.
    expect(deploymentStaleV1(undefined, "hash-b")).toBe(false);
  });

  test("an answer that names no application says nothing", () => {
    expect(deploymentStaleV1("hash-a", undefined)).toBe(false);
  });
});

describe("deploymentFollowV1", () => {
  test("a current page is left alone", () => {
    expect(deploymentFollowV1({ ...idle, stale: false })).toBe("none");
  });

  test("an idle page follows the release by itself", () => {
    expect(deploymentFollowV1(idle)).toBe("reload");
  });

  test("a running Turn is offered the reload rather than given it", () => {
    expect(deploymentFollowV1({ ...idle, turnRunning: true })).toBe("offer");
  });

  test("a typed message is not thrown away", () => {
    expect(deploymentFollowV1({ ...idle, draft: "half a thought" })).toBe(
      "offer",
    );
  });

  test("whitespace is not a message", () => {
    expect(deploymentFollowV1({ ...idle, draft: "   \n " })).toBe("reload");
  });

  test("an open overlay is not closed underneath the User", () => {
    expect(deploymentFollowV1({ ...idle, overlayOpen: true })).toBe("offer");
  });

  test("a live capture is not cut off", () => {
    expect(deploymentFollowV1({ ...idle, listening: true })).toBe("offer");
  });

  test("live work another Package holds is respected", () => {
    expect(deploymentFollowV1({ ...idle, holds: 1 })).toBe("offer");
  });

  test("a tab that just reloaded offers instead of looping", () => {
    expect(
      deploymentFollowV1({
        ...idle,
        reloadedAt: idle.now - (DEPLOYMENT_RELOAD_INTERVAL_MS_V1 - 1),
      }),
    ).toBe("offer");
  });

  test("a tab may reload again once the guard has passed", () => {
    expect(
      deploymentFollowV1({
        ...idle,
        reloadedAt: idle.now - DEPLOYMENT_RELOAD_INTERVAL_MS_V1,
      }),
    ).toBe("reload");
  });
});

function memoryStore(initial?: string): DeploymentReloadStoreV1 & {
  written: string[];
} {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(DEPLOYMENT_RELOAD_MARKER_V1, initial);
  const written: string[] = [];
  return {
    written,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
      written.push(value);
    },
  };
}

describe("the reload marker", () => {
  test("round-trips through storage", () => {
    const store = memoryStore();
    writeDeploymentReloadV1(store, 1234);
    expect(readDeploymentReloadV1(store)).toBe(1234);
  });

  test("a tab that has never reloaded reads as never", () => {
    expect(readDeploymentReloadV1(memoryStore())).toBeUndefined();
  });

  test("a value that is not a time reads as never", () => {
    expect(readDeploymentReloadV1(memoryStore("later"))).toBeUndefined();
  });

  test("no storage at all reads as never and swallows the write", () => {
    expect(readDeploymentReloadV1(undefined)).toBeUndefined();
    expect(() => writeDeploymentReloadV1(undefined, 1)).not.toThrow();
  });

  test("storage that throws does not stop the page following a release", () => {
    const broken: DeploymentReloadStoreV1 = {
      getItem: () => {
        throw new Error("storage is unavailable");
      },
      setItem: () => {
        throw new Error("storage is full");
      },
    };
    expect(readDeploymentReloadV1(broken)).toBeUndefined();
    expect(() => writeDeploymentReloadV1(broken, 1)).not.toThrow();
  });
});

test("the bar says what happened in plain words", () => {
  expect(DEPLOYMENT_UPDATED_MESSAGE_V1).toBe(
    "FrockBot has updated. Reload when you're ready.",
  );
});
