import { describe, expect, test } from "bun:test";
import { TransportFailureV1 } from "@frockbot/client-core";
import {
  APPLET_CANVAS_MAX_AUTO_RETRIES_V1,
  appletCanvasFailureV1,
  appletCanvasRetryDelayMsV1,
} from "./applet-canvas-failure.js";

describe("what the Applet panel says when a read fails", () => {
  test("a deployment that cannot open Applets says so once and stops", () => {
    // The production bug: `APPLET_VIEWER_SECRET` was never set, so the token
    // route answered 503 forever. The panel retried it on every Turn and
    // rewrote itself with a different sentence each time.
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({
        kind: "unreachable",
        status: 503,
        detail: "Applets are unavailable right now.",
        definitive: true,
      }),
    );
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toBe(
      "Applets are unavailable right now. This one is at our end.",
    );
    expect(failure.retry).toBe("manual");
  });

  test("a deployment that did not answer is worth retrying", () => {
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({
        kind: "unreachable",
        status: 502,
        detail: "HTTP 502",
      }),
    );
    expect(failure.kind).toBe("unreachable");
    expect(failure.message).toBe("FrockBot didn't answer.");
    expect(failure.retry).toBe("auto");
  });

  test("an Applet that is not there has not been published", () => {
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({
        kind: "missing",
        status: 404,
        detail: "no active generation",
      }),
    );
    expect(failure.kind).toBe("unpublished");
    expect(failure.message).toBe("This Applet hasn't been published yet.");
    expect(failure.retry).toBe("manual");
  });

  test("a signed-out client is told to sign in, not to try again", () => {
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({ kind: "denied", status: 401, detail: "no" }),
    );
    expect(failure.kind).toBe("denied");
    expect(failure.retry).toBe("manual");
  });

  test("a refusal the deployment wrote is the sentence the User reads", () => {
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({
        kind: "rejected",
        status: 400,
        detail: "invalid applet id",
        serverMessage: "That Applet id isn't one of yours.",
      }),
    );
    expect(failure.kind).toBe("refused");
    expect(failure.message).toBe("That Applet id isn't one of yours.");
    expect(failure.retry).toBe("manual");
  });

  test("a server fault is at our end and is not retried on a loop", () => {
    const failure = appletCanvasFailureV1(
      new TransportFailureV1({ kind: "server", status: 500, detail: "boom" }),
    );
    expect(failure.kind).toBe("unavailable");
    expect(failure.retry).toBe("manual");
    // The raw text is kept for the console, never put on screen.
    expect(failure.detail).toBe("boom");
    expect(failure.message).not.toContain("boom");
  });

  test("automatic retries widen and are bounded", () => {
    expect(appletCanvasRetryDelayMsV1(1)).toBe(2_000);
    expect(appletCanvasRetryDelayMsV1(2)).toBe(4_000);
    expect(appletCanvasRetryDelayMsV1(3)).toBe(8_000);
    expect(appletCanvasRetryDelayMsV1(20)).toBe(30_000);
    expect(APPLET_CANVAS_MAX_AUTO_RETRIES_V1).toBe(4);
  });
});
