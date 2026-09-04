import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  COMPUTER_LIVE_PREVIEW_GRACE_MS,
  computerScreenModeV1,
  computerScreenStatusLabelV1,
  computerSnapshotAgeLabelV1,
  type ComputerScreenModeInputV1,
} from "./live-preview.js";

const cardSource = readFileSync(
  new URL("./ComputerCard.vue", import.meta.url),
  "utf8",
);

const watching: ComputerScreenModeInputV1 = {
  viewerUrl: "https://sprite.invalid/vnc.html#view_only=1&path=websockify",
  phase: "ready",
  expanded: false,
  turnRunning: true,
  onScreen: true,
  documentVisible: true,
};

describe("the card's live-vs-snapshot choice", () => {
  test("streams the desktop while the Bot's Turn is running", () => {
    expect(computerScreenModeV1(watching)).toBe("stream");
  });

  test("stays on the stored capture when no session has been minted", () => {
    expect(computerScreenModeV1({ ...watching, viewerUrl: undefined })).toBe(
      "snapshot",
    );
  });

  test("a hidden tab holds no stream", () => {
    expect(computerScreenModeV1({ ...watching, documentVisible: false })).toBe(
      "snapshot",
    );
  });

  test("a card scrolled off screen holds no stream", () => {
    expect(computerScreenModeV1({ ...watching, onScreen: false })).toBe(
      "snapshot",
    );
  });

  test("the open full-screen viewer keeps the session warm off screen", () => {
    expect(
      computerScreenModeV1({
        ...watching,
        onScreen: false,
        turnRunning: false,
        expanded: true,
      }),
    ).toBe("stream");
  });

  test("an idle Bot with no Turn ever run shows the snapshot", () => {
    expect(computerScreenModeV1({ ...watching, turnRunning: false })).toBe(
      "snapshot",
    );
  });

  test("a settled Turn keeps streaming through the grace window only", () => {
    const settled = { ...watching, turnRunning: false };
    expect(computerScreenModeV1({ ...settled, sinceTurnEndedMs: 1_000 })).toBe(
      "stream",
    );
    expect(
      computerScreenModeV1({
        ...settled,
        sinceTurnEndedMs: COMPUTER_LIVE_PREVIEW_GRACE_MS,
      }),
    ).toBe("snapshot");
    expect(
      computerScreenModeV1({
        ...settled,
        sinceTurnEndedMs: 1_000,
        graceMs: 500,
      }),
    ).toBe("snapshot");
  });

  test("a host mid-operation draws its progress, not a frame", () => {
    for (const phase of [
      "provisioning",
      "updating",
      "disconnected",
      "error",
      "idle",
      "unconfigured",
    ] as const) {
      expect(computerScreenModeV1({ ...watching, phase })).toBe("snapshot");
    }
    expect(computerScreenModeV1({ ...watching, phase: "human-control" })).toBe(
      "stream",
    );
  });
});

describe("the status line under the screen", () => {
  test("says Live while the stream is up", () => {
    expect(computerScreenStatusLabelV1({ mode: "stream", now: 1_000 })).toBe(
      "Live",
    );
  });

  test("ages the snapshot in the User's units", () => {
    const now = Date.parse("2026-09-04T00:01:00.000Z");
    expect(
      computerScreenStatusLabelV1({
        mode: "snapshot",
        capturedAt: "2026-09-04T00:00:48.000Z",
        now,
      }),
    ).toBe("Snapshot · 12s ago");
    expect(computerSnapshotAgeLabelV1(90_000)).toBe("1m ago");
    expect(computerSnapshotAgeLabelV1(3 * 3_600_000)).toBe("3h ago");
    expect(computerSnapshotAgeLabelV1(50 * 3_600_000)).toBe("2d ago");
    expect(computerSnapshotAgeLabelV1(-5_000)).toBe("0s ago");
  });

  test("says nothing at all when there is no capture to age", () => {
    expect(
      computerScreenStatusLabelV1({ mode: "snapshot", now: 1_000 }),
    ).toBeUndefined();
    expect(
      computerScreenStatusLabelV1({
        mode: "snapshot",
        capturedAt: "not a date",
        now: 1_000,
      }),
    ).toBeUndefined();
  });

  test("uses no architecture words", () => {
    for (const word of ["VNC", "noVNC", "iframe", "websocket", "session"]) {
      expect(
        computerScreenStatusLabelV1({
          mode: "snapshot",
          capturedAt: "2026-09-04T00:00:00.000Z",
          now: Date.parse("2026-09-04T00:00:05.000Z"),
        }),
      ).not.toContain(word);
    }
  });
});

describe("the card's live frame", () => {
  test("is view-only and takes no input", () => {
    // The card never asks for control: the second argument is the input fence
    // and it is hard-coded false, so the framed viewer is minted view-only.
    expect(cardSource).toContain(
      "viewerUrlForControlV1(state.value.viewerUrl, false)",
    );
    expect(cardSource).not.toContain("allow-pointer-lock");
    expect(cardSource).toContain('tabindex="-1"');
    expect(cardSource).toContain('aria-hidden="true"');
  });

  test("keeps click-to-take-control on the button behind it", () => {
    expect(cardSource).toContain('aria-label="Open computer in full window"');
    expect(cardSource).toContain('@click="open"');
  });

  test("releases the held session when the card leaves the screen", () => {
    expect(cardSource).toContain("holdLivePreview?.(streaming.value)");
    expect(cardSource).toContain("holdLivePreview?.(false)");
    expect(cardSource).toContain("visibilitychange");
    expect(cardSource).toContain("IntersectionObserver");
  });
});
