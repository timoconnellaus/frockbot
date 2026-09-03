import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import type { ComputerState } from "../shared.js";
import { COMPUTER_COLD_PROVISION_EXPECTATION } from "../protocol.js";
import {
  createComputerViewerActions,
  decodeComputerViewerFrameMessageV1,
  viewerUrlForControlV1,
} from "./viewer.js";

const overlaySource = readFileSync(
  new URL("./ComputerViewerOverlay.vue", import.meta.url),
  "utf8",
);
const cardSource = readFileSync(
  new URL("./ComputerCard.vue", import.meta.url),
  "utf8",
);

describe("Computer viewer", () => {
  test("keeps one noVNC session view-only until human control is held", () => {
    const minted =
      "https://sprite.invalid/vnc.html#autoconnect=1&view_only=1&path=websockify%3Ftoken%3Dsecret";
    const viewOnly = new URL(viewerUrlForControlV1(minted, false));
    const interactive = new URL(viewerUrlForControlV1(minted, true));

    expect(new URLSearchParams(viewOnly.hash.slice(1)).get("view_only")).toBe(
      "1",
    );
    expect(
      new URLSearchParams(interactive.hash.slice(1)).get("view_only"),
    ).toBe("0");
    expect(interactive.origin + interactive.pathname).toBe(
      viewOnly.origin + viewOnly.pathname,
    );
    expect(new URLSearchParams(interactive.hash.slice(1)).get("path")).toBe(
      "websockify?token=secret",
    );
  });

  test("accepts only secret-free viewer status messages", () => {
    expect(
      decodeComputerViewerFrameMessageV1({
        type: "frockbot-viewer",
        state: "connected",
        message: "Desktop connected",
      }),
    ).toEqual({
      type: "frockbot-viewer",
      state: "connected",
      message: "Desktop connected",
    });
    expect(
      decodeComputerViewerFrameMessageV1({
        type: "frockbot-viewer",
        state: "connected",
        message: "Desktop connected",
        password: "secret",
      }),
    ).toBeUndefined();
  });

  test("requires confirmation before taking control and Escape closes through shared state", async () => {
    let confirmations = false;
    let takeControl = 0;
    let closeViewer = 0;
    const state = {
      takeControl: () => {
        takeControl += 1;
        return Promise.resolve();
      },
      closeViewer: () => {
        closeViewer += 1;
        return Promise.resolve();
      },
    } as ComputerState;
    const actions = createComputerViewerActions(
      () => state,
      (open) => {
        confirmations = open;
      },
    );

    actions.requestTakeControl();
    expect(confirmations).toBe(true);
    expect(takeControl).toBe(0);
    await actions.confirmTakeControl();
    expect(confirmations).toBe(false);
    expect(takeControl).toBe(1);

    await actions.escape();
    expect(closeViewer).toBe(1);
  });

  test("the Vue overlay binds the computed viewer src and confirm dialog", () => {
    const parsed = parse(overlaySource, {
      filename: "ComputerViewerOverlay.vue",
    });
    expect(parsed.errors).toEqual([]);
    const template = parsed.descriptor.template?.content ?? "";

    expect(template).toContain(':src="viewerSrc"');
    expect(template).toContain('@load="handleFrameLoad"');
    expect(template).toContain('role="progressbar"');
    expect(template).toContain(':aria-valuenow="progressValueNow"');
    expect(template).toContain('aria-live="polite"');
    expect(overlaySource).toContain(
      "Setting up your computer for the first time",
    );
    expect(overlaySource).toContain("This usually takes 2-3 minutes");
    expect(template).toContain('@click="actions.requestTakeControl"');
    expect(template).toContain('role="alertdialog"');
    expect(template).toContain(
      "The Bot will be fenced from this desktop until you release control.",
    );
  });

  test("the card shows accessible cold-setup and update progress", () => {
    const parsed = parse(cardSource, { filename: "ComputerCard.vue" });
    expect(parsed.errors).toEqual([]);
    const template = parsed.descriptor.template?.content ?? "";

    expect(cardSource).toContain("Setting up your computer for the first time");
    expect(COMPUTER_COLD_PROVISION_EXPECTATION).toBe(
      "This usually takes 2-3 minutes",
    );
    expect(cardSource).toContain("COMPUTER_COLD_PROVISION_EXPECTATION");
    expect(cardSource).toContain("Updating your computer");
    expect(template).toContain('role="progressbar"');
    expect(template).toContain(':aria-valuenow="progressValueNow"');
    expect(template).toContain('aria-live="polite"');
    expect(template).toContain("{{ progressPhaseLabel }}");
  });

  test("the card keys its durable capture only by content hash", () => {
    const parsed = parse(cardSource, { filename: "ComputerCard.vue" });
    expect(parsed.errors).toEqual([]);
    const template = parsed.descriptor.template?.content ?? "";

    expect(template).toContain(':key="screenshot.contentHash"');
    expect(template).toContain(':src="screenshot.url"');
    expect(template).not.toContain("viewerUrl");
  });
});
