import { describe, expect, test } from "bun:test";
import type { FrockBotManifest } from "@frockbot/kernel-composition";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.ts";

function pkg(
  id: string,
  version: string,
  roots?: FrockBotManifest["roots"],
): { id: string; version: string; manifest: FrockBotManifest } {
  return {
    id,
    version,
    manifest: {
      schemaVersion: 4,
      id,
      displayName: id,
      version,
      compatibility: { frockbot: "*" },
      dependencies: {},
      contributions: {},
      permissions: [],
      ...(roots ? { roots } : {}),
    },
  };
}

const packages = [
  pkg("image", "0.0.1", [{ id: "generated", scope: "user" }]),
  pkg("applets", "0.0.1", [{ id: "source", scope: "user" }]),
  pkg("clock", "0.0.1"),
];

describe("the durable roots a User's Packages declare", () => {
  test("supplies every enabled Package's declared roots, sorted", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "applets", version: "0.0.1", state: "installed" },
          { packageId: "image", version: "0.0.1", state: "installed" },
          { packageId: "clock", version: "0.0.1", state: "installed" },
        ],
        packages,
      }),
    ).toEqual([
      { packageId: "applets", rootId: "source" },
      { packageId: "image", rootId: "generated" },
    ]);
  });

  test("a Package that declares no root contributes none", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "clock", version: "0.0.1", state: "installed" },
        ],
        packages,
      }),
    ).toEqual([]);
  });

  test("enablement decides: a disabled or failed install syncs nothing", () => {
    // Materializing files for a Package that cannot run would leave
    // directories on a Computer that no Bot on it could explain, and would
    // keep syncing them after an uninstall.
    for (const state of ["disabled", "failed"] as const) {
      expect(
        declaredPackageRootsV1({
          installations: [{ packageId: "image", version: "0.0.1", state }],
          packages,
        }),
      ).toEqual([]);
    }
  });

  test("the installed version decides which manifest declares the roots", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "image", version: "0.0.2", state: "installed" },
        ],
        packages,
      }),
    ).toEqual([]);
  });

  test("one entry per root, whatever the installations say", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "image", version: "0.0.1", state: "installed" },
          { packageId: "image", version: "0.0.1", state: "installed" },
        ],
        packages,
      }),
    ).toEqual([{ packageId: "image", rootId: "generated" }]);
  });
});

describe("the Computer sync seam", () => {
  const store = {} as never;

  test("carries the declared roots to the provider", () => {
    const host = createBotComputerSyncHost({ WORKSPACE_SYNC_FILES: store }, [
      { packageId: "applets", rootId: "source" },
    ]);
    expect(host?.packageRoots).toEqual([
      { packageId: "applets", rootId: "source" },
    ]);
  });

  test("omits the field entirely when no Package declared a root", () => {
    // Absent rather than empty: a provider then behaves exactly as it did
    // before any host supplied a list.
    const host = createBotComputerSyncHost({ WORKSPACE_SYNC_FILES: store });
    expect(host && "packageRoots" in host).toBe(false);
  });

  test("no store binding is no sync at all, roots or not", () => {
    expect(
      createBotComputerSyncHost({}, [
        { packageId: "applets", rootId: "source" },
      ]),
    ).toBeUndefined();
  });
});
