import { describe, expect, test } from "bun:test";
import type { PackageDefinitionV1 } from "@frockbot/core/contracts";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.ts";

function pkg(
  id: string,
  roots?: PackageDefinitionV1["roots"],
): PackageDefinitionV1 {
  return { id, displayName: id, ...(roots ? { roots } : {}) };
}

const packages = [
  pkg("image", [{ id: "generated", scope: "user" }]),
  // Applets declares no root: its source is authored and built in the cloud,
  // and nothing on a Computer reads it.
  pkg("applets"),
  pkg("clock"),
];

describe("the durable roots a User's Packages declare", () => {
  test("supplies every enabled Package's declared roots, sorted", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "applets", state: "installed" },
          { packageId: "image", state: "installed" },
          { packageId: "clock", state: "installed" },
        ],
        packages,
      }),
    ).toEqual([{ packageId: "image", rootId: "generated" }]);
  });

  test("a Package that declares no root contributes none", () => {
    expect(
      declaredPackageRootsV1({
        installations: [{ packageId: "clock", state: "installed" }],
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
          installations: [{ packageId: "image", state }],
          packages,
        }),
      ).toEqual([]);
    }
  });

  test("one entry per root, whatever the installations say", () => {
    expect(
      declaredPackageRootsV1({
        installations: [
          { packageId: "image", state: "installed" },
          { packageId: "image", state: "installed" },
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
      { packageId: "image", rootId: "generated" },
    ]);
    expect(host?.packageRoots).toEqual([
      { packageId: "image", rootId: "generated" },
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
        { packageId: "image", rootId: "generated" },
      ]),
    ).toBeUndefined();
  });
});
