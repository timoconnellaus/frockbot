import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import {
  initialComputerMachineState,
  transitionComputerState,
} from "./state-machine.js";

test("the Vue strip keys its durable capture only by contentHash", () => {
  const source = readFileSync(
    new URL("./ComputerStrip.vue", import.meta.url),
    "utf8",
  );
  const parsed = parse(source, { filename: "ComputerStrip.vue" });
  expect(parsed.errors).toEqual([]);
  const template = parsed.descriptor.template?.content ?? "";

  expect(template).toContain(':key="screenshot.contentHash"');
  expect(template).toContain(':src="screenshot.url"');
  expect(template).not.toContain("viewerUrl");
});

test("a repeated screenshot projection preserves the rendered capture", () => {
  const first = {
    version: 1 as const,
    path: "scout/latest.png",
    capturedAt: "2026-09-02T00:00:00.000Z",
    contentHash: "sha256:first",
    url: "/workspace/first",
  };
  const state = {
    ...initialComputerMachineState(),
    screenshots: [first],
  };
  const project = (contentHash: string) => ({
    type: "projection-received" as const,
    projection: {
      version: 1 as const,
      botId: "scout",
      providerLabel: "Fake Computer",
      phase: "idle" as const,
      message: "Computer available",
      screenshots: [
        { ...first, contentHash, url: `/workspace/${contentHash}` },
      ],
    },
  });

  const unchanged = transitionComputerState(state, project("sha256:first"));
  const changed = transitionComputerState(unchanged, project("sha256:second"));

  expect(unchanged.screenshots[0]).toBe(first);
  expect(changed.screenshots[0]).not.toBe(first);
});
