import { describe, expect, test } from "bun:test";
import {
  decodeWorkspaceRootV1,
  workspaceRootKeyV1,
} from "@frockbot/kernel-contracts";
import {
  APPLETS_PACKAGE_ID_V1,
  APPLETS_SOURCE_ROOT_ID_V1,
  appletSourceFilePathV1,
  appletSourcePathV1,
  appletsSourceRootV1,
  assertAppletIdV1,
} from "./root.ts";

const APPLET_ID = "pub-user-1.0123456789abcdef0123456789abcdef";

describe("the Applets source root", () => {
  test("is the Package-declared root ADR 0022 names", () => {
    expect(appletsSourceRootV1("user-1")).toEqual({
      kind: "package-declared",
      userId: "user-1",
      packageId: "applets",
      rootId: "source",
    });
    expect(APPLETS_PACKAGE_ID_V1).toBe("applets");
    expect(APPLETS_SOURCE_ROOT_ID_V1).toBe("source");
  });

  test("is a root the kernel decodes and keys, not a shape of its own", () => {
    const root = appletsSourceRootV1("user-1");
    expect(decodeWorkspaceRootV1(root)).toEqual(root);
    expect(workspaceRootKeyV1(root)).toBe(
      "package-declared:user-1:applets:source",
    );
  });

  test("keys a User's root away from every other User's", () => {
    expect(workspaceRootKeyV1(appletsSourceRootV1("a/b"))).not.toBe(
      workspaceRootKeyV1(appletsSourceRootV1("a%2Fb")),
    );
  });
});

describe("an Applet's source directory", () => {
  test("is `<appletId>/` under the root", () => {
    expect(appletSourcePathV1(APPLET_ID)).toBe(`${APPLET_ID}/`);
  });

  test("ends in a separator so one id is never a prefix of another", () => {
    // `<id>` and `<id>2` would share a listing prefix; `<id>/` cannot.
    expect(appletSourcePathV1(APPLET_ID).endsWith("/")).toBe(true);
  });

  test("joins a built artifact onto a Workspace path the kernel accepts", () => {
    expect(
      appletSourceFilePathV1("user-1", APPLET_ID, "dist/server.js"),
    ).toEqual({
      root: appletsSourceRootV1("user-1"),
      path: `${APPLET_ID}/dist/server.js`,
    });
  });
});

describe("the Applet id shape", () => {
  test("accepts the ADR 0015 share-id shape", () => {
    expect(assertAppletIdV1(APPLET_ID)).toBe(APPLET_ID);
  });

  test("refuses an id that is not `<publicUserId>.<random>`", () => {
    for (const invalid of [
      "no-separator",
      ".0123456789abcdef0123456789abcdef",
      "pub-user-1.",
      "pub-user-1.short",
      "pub-user-1.0123456789ABCDEF0123456789ABCDEF",
      "pub user 1.0123456789abcdef0123456789abcdef",
      42,
    ]) {
      expect(() => assertAppletIdV1(invalid)).toThrow("applet id is invalid");
    }
  });

  test("refuses a traversal rather than folding it into another directory", () => {
    // The id is a directory on a real filesystem the sync reconciles. Folding
    // would silently point two Applets at one source tree.
    expect(() => appletSourcePathV1("../escape")).toThrow(
      "applet id is invalid",
    );
    expect(() => appletSourcePathV1(`${APPLET_ID}/../other`)).toThrow(
      "applet id is invalid",
    );
  });
});
