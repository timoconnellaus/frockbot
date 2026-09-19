import { describe, expect, test } from "bun:test";

import {
  ACTIVE_RUN_KEY,
  PENDING_RUN_KEY,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  isRunStateStorageKeyV1,
} from "./storage-keys.js";

describe("run-state storage keys", () => {
  test("recognizes only records that change the projected run state", () => {
    for (const key of [
      ACTIVE_RUN_KEY,
      PENDING_RUN_KEY,
      `${RUN_PREFIX}run-1`,
      `${RUN_INDEX_PREFIX}2026-09-19T00:00:00.000Z:run-1`,
    ]) {
      expect(isRunStateStorageKeyV1(key)).toBe(true);
    }

    for (const key of [
      "run-admission-fence:run-1",
      "pending-agent-run:1:run-1",
      "session-events:index:session-1",
      "shell:card:surface-1",
    ]) {
      expect(isRunStateStorageKeyV1(key)).toBe(false);
    }
  });
});
