import { describe, expect, test } from "bun:test";
import {
  ComputerProtocolDecodeError,
  decodeComputerCommandResponse,
  decodeComputerProjectionV1,
  type ComputerDemonstrationViewV1,
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
      provisioning: {
        version: 1,
        kind: "provision",
        label: "installing the browser",
        index: 4,
        total: 5,
        resumed: false,
      },
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

  test("decodes the previous V1 progress shape without provisioning detail", () => {
    const { provisioning: _provisioning, ...previous } = projection.progress;
    expect(
      decodeComputerProjectionV1({ ...projection, progress: previous })
        .progress,
    ).toEqual(previous);
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

describe("Computer command acceptance", () => {
  test("keeps durable admission distinct from a terminal receipt", () => {
    expect(
      decodeComputerCommandResponse({
        version: 2,
        commandId: "connect-1",
        type: "connect",
        status: "accepted",
        admittedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toEqual({
      version: 2,
      commandId: "connect-1",
      type: "connect",
      status: "accepted",
      admittedAt: "2026-09-03T00:00:00.000Z",
    });
  });
});

describe("Computer demonstration", () => {
  const ready: Extract<ComputerDemonstrationViewV1, { status: "ready" }> = {
    version: 1,
    id: "0123456789abcdef",
    status: "ready",
    startedAt: "2026-09-24T10:00:00.000Z",
    steps: 12,
    attachments: [
      {
        kind: "document",
        uploadId: "a".repeat(64),
        name: "demonstration-0123456789abcdef.json",
        mediaType: "application/json",
        bytes: 2_048,
      },
    ],
  };

  test("projects a recording and a kept one exactly", () => {
    const recording = {
      version: 1,
      id: "0123456789abcdef",
      status: "recording",
      startedAt: "2026-09-24T10:00:00.000Z",
      endsAt: "2026-09-24T10:10:00.000Z",
    } as const;
    expect(
      decodeComputerProjectionV1({ ...projection, demonstration: recording })
        .demonstration,
    ).toEqual(recording);
    expect(
      decodeComputerProjectionV1({ ...projection, demonstration: ready })
        .demonstration,
    ).toEqual(ready);
  });

  test("refuses a shape that is neither, or an attachment carrying its contents", () => {
    for (const demonstration of [
      { ...ready, status: "sent" },
      { ...ready, endsAt: "2026-09-24T10:10:00.000Z" },
      {
        ...ready,
        attachments: [{ ...ready.attachments[0], text: "the log itself" }],
      },
      { ...ready, steps: 0 },
    ]) {
      expect(() =>
        decodeComputerProjectionV1({ ...projection, demonstration }),
      ).toThrow(ComputerProtocolDecodeError);
    }
  });
});
