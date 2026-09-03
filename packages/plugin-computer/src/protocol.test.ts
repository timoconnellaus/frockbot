import { describe, expect, test } from "bun:test";
import {
  ComputerProtocolDecodeError,
  decodeComputerProjectionV1,
  type ComputerProgressViewV1,
  type ComputerProjectionV1,
} from "./protocol.js";

const projection: ComputerProjectionV1 & { progress: ComputerProgressViewV1 } =
  {
    version: 1,
    botId: "scout",
    providerLabel: "Fake Computer",
    phase: "provisioning",
    message: "Starting the desktop…",
    progress: {
      version: 1,
      kind: "connect",
      startedAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:02.000Z",
      index: 2,
      total: 3,
      steps: [
        {
          version: 1,
          id: "waking",
          label: "Waking the Computer",
          status: "complete",
        },
        {
          version: 1,
          id: "starting-desktop",
          label: "Starting the desktop",
          status: "active",
        },
        {
          version: 1,
          id: "minting-viewer",
          label: "Minting the viewer",
          status: "pending",
        },
      ],
    },
    screenshots: [],
  };

describe("Computer projection progress", () => {
  test("decodes the exact ordered V1 progress shape", () => {
    expect(decodeComputerProjectionV1(projection).progress).toEqual(
      projection.progress,
    );
  });

  test("refuses malformed or extended progress at the client seam", () => {
    expect(() =>
      decodeComputerProjectionV1({
        ...projection,
        progress: {
          ...projection.progress,
          secret: "must not cross",
        },
      }),
    ).toThrow(ComputerProtocolDecodeError);
    expect(() =>
      decodeComputerProjectionV1({
        ...projection,
        progress: {
          ...projection.progress,
          steps: projection.progress.steps.map((step) => ({
            ...step,
            status: "working",
          })),
        },
      }),
    ).toThrow(ComputerProtocolDecodeError);
  });
});
