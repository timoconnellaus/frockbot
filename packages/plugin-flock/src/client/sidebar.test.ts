import { describe, expect, test } from "bun:test";
import { formatSidebarMessageTimeV1, groupSidebarBotsV1 } from "./sidebar.js";

const bots = [
  { botId: "alpha" },
  { botId: "beta" },
  { botId: "gamma" },
  { botId: "delta" },
];

describe("sidebar Bot groups", () => {
  test("renders one plain list until a visible Bot has a label", () => {
    expect(groupSidebarBotsV1(bots.slice(0, 2), {})).toEqual({
      showHeadings: false,
      groups: [{ key: "all", label: "", bots: bots.slice(0, 2) }],
    });
  });

  test("groups case-insensitively, keeps first spelling, and puts Unassigned last", () => {
    const grouped = groupSidebarBotsV1(bots, {
      alpha: { label: " Personal " },
      beta: {},
      gamma: { label: "personal" },
      delta: { label: "Work" },
    });
    expect(grouped.showHeadings).toBe(true);
    expect(
      grouped.groups.map((group) => ({
        label: group.label,
        bots: group.bots.map((bot) => bot.botId),
      })),
    ).toEqual([
      { label: "Personal", bots: ["alpha", "gamma"] },
      { label: "Work", bots: ["delta"] },
      { label: "Unassigned", bots: ["beta"] },
    ]);
  });

  test("treats whitespace-only labels as Unassigned", () => {
    const grouped = groupSidebarBotsV1(bots.slice(0, 2), {
      alpha: { label: "\t" },
      beta: { label: "Work" },
    });
    expect(grouped.groups.map((group) => group.label)).toEqual([
      "Work",
      "Unassigned",
    ]);
  });
});

describe("sidebar preview times", () => {
  const now = new Date(2026, 8, 1, 15, 30);

  test("shows a time today, a weekday this week, and M/D when older", () => {
    expect(
      formatSidebarMessageTimeV1(
        new Date(2026, 8, 1, 7, 34).toISOString(),
        now,
        "en-US",
      ),
    ).toBe("7:34 AM");
    expect(
      formatSidebarMessageTimeV1(
        new Date(2026, 7, 27, 12).toISOString(),
        now,
        "en-US",
      ),
    ).toBe("Thursday");
    expect(
      formatSidebarMessageTimeV1(
        new Date(2026, 7, 22, 12).toISOString(),
        now,
        "en-US",
      ),
    ).toBe("8/22");
  });
});
