import { describe, expect, test } from "bun:test";
import {
  decodeConnectionReturnV1,
  withoutConnectionReturnV1,
} from "./shared.js";

describe("authorization return parameter", () => {
  test("reads the status the callback redirected with", () => {
    expect(decodeConnectionReturnV1("?connection=composio-ready")).toEqual({
      packageId: "composio",
      status: "ready",
    });
    expect(decodeConnectionReturnV1("?connection=composio-pending")).toEqual({
      packageId: "composio",
      status: "pending",
    });
  });

  test("carries the reason a failed grant came back with", () => {
    expect(
      decodeConnectionReturnV1(
        "?connection=composio-failed&connection_reason=state%20has%20expired",
      ),
    ).toEqual({
      packageId: "composio",
      status: "failed",
      reason: "state has expired",
    });
  });

  test("ignores a query string that carries no return", () => {
    expect(decodeConnectionReturnV1("")).toBeUndefined();
    expect(decodeConnectionReturnV1("?as_user=someone")).toBeUndefined();
  });

  test("refuses a malformed or unknown return", () => {
    expect(decodeConnectionReturnV1("?connection=composio")).toBeUndefined();
    expect(
      decodeConnectionReturnV1("?connection=composio-elsewhere"),
    ).toBeUndefined();
    expect(decodeConnectionReturnV1("?connection=-ready")).toBeUndefined();
    expect(
      decodeConnectionReturnV1("?connection=Not%20A%20Package-ready"),
    ).toBeUndefined();
  });

  test("strips the return parameters and keeps the rest", () => {
    expect(
      withoutConnectionReturnV1(
        "?as_user=someone&connection=composio-failed&connection_reason=nope",
      ),
    ).toBe("?as_user=someone");
    expect(withoutConnectionReturnV1("?connection=composio-ready")).toBe("");
  });
});
