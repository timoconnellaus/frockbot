import { describe, expect, it, spyOn } from "bun:test";
import {
  appendGeneration,
  lastKnownGood,
  recordOutcome,
  revertTo,
} from "../src/generations";

describe("generation logs", () => {
  it("appends, settles and finds the newest good generation", () => {
    spyOn(Date, "now").mockReturnValueOnce(10).mockReturnValueOnce(20);
    let log = appendGeneration([], {
      baseVersion: "v1",
      entries: [{ id: "a" }, { id: "off", enabled: false }],
    });
    expect(log[0]).toEqual({
      n: 0,
      parent: null,
      at: 10,
      baseVersion: "v1",
      entries: [{ id: "a" }, { id: "off", enabled: false }],
      outcome: "pending",
    });

    log = recordOutcome(log, 0, [{ id: "a", status: "active" }]);
    expect(log[0]?.outcome).toBe("good");
    log = appendGeneration(log, {
      baseVersion: "v1",
      entries: [{ id: "a" }, { id: "b" }],
    });
    log = recordOutcome(log, 1, [
      { id: "a", status: "active" },
      { id: "b", status: "pending" },
    ]);
    expect(log[1]?.outcome).toBe("bad");
    expect(lastKnownGood(log)?.n).toBe(0);
  });

  it("reverts by appending copied entries under the current base version", () => {
    let log = appendGeneration([], {
      baseVersion: "v1",
      entries: [{ id: "old" }],
    });
    log = recordOutcome(log, 0, [{ id: "old", status: "active" }]);
    log = appendGeneration(log, {
      baseVersion: "v2",
      entries: [{ id: "new" }],
    });
    log = revertTo(log, 0);

    expect(log.map((generation) => generation.n)).toEqual([0, 1, 2]);
    expect(log[2]).toMatchObject({
      parent: 1,
      baseVersion: "v2",
      entries: [{ id: "old" }],
      outcome: "pending",
    });
  });
});
