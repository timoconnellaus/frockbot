import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import type { ComputerState } from "../shared.js";
import {
  createComputerViewerActions,
  viewerUrlForControlV1,
} from "./viewer.js";

const overlaySource = readFileSync(
  new URL("./ComputerViewerOverlay.vue", import.meta.url),
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
    expect(template).toContain('@click="actions.requestTakeControl"');
    expect(template).toContain('role="alertdialog"');
    expect(template).toContain(
      "The Bot will be fenced from this desktop until you release control.",
    );
  });
});
