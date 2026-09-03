import { describe, expect, test } from "bun:test";
import type { ComputerProgressViewV1 } from "../protocol.js";
import {
  COLD_PROVISION_PROGRESS_BUDGET_MS,
  computerProgressFraction,
  computerProgressFrame,
  computerProgressRunKind,
  UPDATE_PROGRESS_BUDGET_MS,
} from "./progress.js";

function progress(
  provisioningIndex: number,
  options: {
    provisioningKind?: "provision" | "update";
    resumed?: boolean;
    updatedAfterMs?: number;
  } = {},
): ComputerProgressViewV1 {
  const provisioningKind = options.provisioningKind ?? "provision";
  return {
    version: 1,
    kind: "connect",
    startedAt: "2026-09-03T00:00:00.000Z",
    updatedAt: new Date(
      Date.parse("2026-09-03T00:00:00.000Z") + (options.updatedAfterMs ?? 0),
    ).toISOString(),
    index: 1,
    total: 5,
    provisioning: {
      version: 1,
      kind: provisioningKind,
      label: "Installing the browser",
      index: provisioningIndex,
      total: 5,
      resumed: options.resumed ?? false,
    },
    steps: [
      {
        version: 1,
        id: "waking",
        label: "Waking the Computer",
        status: "active",
      },
    ],
  };
}

function projection(progressValue?: ComputerProgressViewV1) {
  return {
    phase: "provisioning" as const,
    ...(progressValue ? { progress: progressValue } : {}),
  };
}

describe("Computer progress easing", () => {
  test("never regresses when a refreshed durable phase has a lower local eased position", () => {
    const beforeRefresh = computerProgressFraction({
      projection: projection(progress(1)),
      elapsedMs: 20_000,
    });
    const afterRefresh = computerProgressFraction({
      projection: projection(progress(1, { updatedAfterMs: 20_000 })),
      elapsedMs: 21_000,
    });

    expect(beforeRefresh).toBeDefined();
    expect(afterRefresh).toBeGreaterThanOrEqual(beforeRefresh!);
  });

  test("never eases beyond the next real provisioning boundary", () => {
    const frame = computerProgressFrame({
      projection: projection(progress(2)),
      elapsedMs: COLD_PROVISION_PROGRESS_BUDGET_MS * 10,
    });

    expect(frame.fraction).toBe(frame.nextBoundary);
    expect(frame.nextBoundary).toBeCloseTo(2 / 25);
  });

  test("a late durable phase ahead of the eased value jumps forward", () => {
    const eased = computerProgressFraction({
      projection: projection(progress(1)),
      elapsedMs: 1_000,
    });
    const advanced = computerProgressFraction({
      projection: projection(progress(4, { updatedAfterMs: 1_000 })),
      elapsedMs: 1_000,
    });

    expect(eased).toBeLessThan(3 / 25);
    expect(advanced).toBe(3 / 25);
  });

  test("durable completion snaps to 100 percent regardless of budget", () => {
    expect(
      computerProgressFraction({
        projection: { phase: "ready" },
        elapsedMs: 1,
      }),
    ).toBe(1);
  });

  test("a warm wake has no long-budget determinate bar", () => {
    const warmProgress = progress(1);
    delete warmProgress.provisioning;

    expect(
      computerProgressFrame({
        projection: projection(warmProgress),
        elapsedMs: 1_000,
      }),
    ).toEqual({ runKind: "warm-wake" });
  });

  test("updates are distinguished from cold and resumed provisions", () => {
    const cold = projection(progress(1));
    const resumed = projection(progress(1, { resumed: true }));
    const update = projection(progress(1, { provisioningKind: "update" }));

    expect(computerProgressRunKind(cold)).toBe("cold-provision");
    expect(computerProgressRunKind(resumed)).toBe("resumed-provision");
    expect(computerProgressRunKind(update)).toBe("update");
    expect(
      computerProgressFrame({ projection: update, elapsedMs: 0 }).remainingMs,
    ).toBe(UPDATE_PROGRESS_BUDGET_MS / 5);
    expect(UPDATE_PROGRESS_BUDGET_MS).toBeLessThan(
      COLD_PROVISION_PROGRESS_BUDGET_MS,
    );
  });

  test("top-level update progress is determinate without provisioning detail", () => {
    const updateProgress = progress(1);
    delete updateProgress.provisioning;
    updateProgress.kind = "update";
    updateProgress.total = 2;

    const frame = computerProgressFrame({
      projection: { phase: "updating", progress: updateProgress },
      elapsedMs: 0,
    });
    expect(frame).toMatchObject({
      runKind: "update",
      fraction: 0,
      nextBoundary: 0.5,
      remainingMs: UPDATE_PROGRESS_BUDGET_MS / 2,
    });
  });
});
