import { describe, expect, test } from "bun:test";
import type { Component } from "vue";
import { createContributionRegistry } from "./contribution-registry.ts";

function fakeComponent(name: string): Component {
  return { name } as Component;
}

const first = fakeComponent("first");
const second = fakeComponent("second");
const other = fakeComponent("other");

describe("createContributionRegistry", () => {
  test("orders slot components by order then id", () => {
    const registry = createContributionRegistry([
      { slot: "frockbot.right-panel", id: "b", order: 100, component: second },
      { slot: "frockbot.right-panel", id: "a", order: 100, component: first },
      { slot: "frockbot.right-panel", id: "c", order: 10, component: other },
    ]);

    expect(registry.componentsFor("frockbot.right-panel")).toEqual([
      other,
      first,
      second,
    ]);
    expect(
      registry.entries("frockbot.right-panel").map((entry) => entry.id),
    ).toEqual(["c", "a", "b"]);
  });

  test("keeps slots independent and lists them sorted", () => {
    const registry = createContributionRegistry([
      { slot: "frockbot.right-panel", id: "a", order: 1, component: first },
      { slot: "frockbot.computer", id: "b", order: 1, component: second },
    ]);

    expect(registry.slots()).toEqual([
      "frockbot.computer",
      "frockbot.right-panel",
    ]);
    expect(registry.componentsFor("frockbot.computer")).toEqual([second]);
  });

  test("returns an empty list for an unknown slot", () => {
    const registry = createContributionRegistry([]);

    expect(registry.componentsFor("frockbot.right-panel")).toEqual([]);
    expect(registry.entries("frockbot.right-panel")).toEqual([]);
  });

  test("does not expose its internal slot arrays", () => {
    const registry = createContributionRegistry([
      { slot: "frockbot.right-panel", id: "a", order: 1, component: first },
    ]);

    registry.entries("frockbot.right-panel").pop();

    expect(registry.componentsFor("frockbot.right-panel")).toEqual([first]);
  });

  test("rejects duplicate ids in one slot and empty identifiers", () => {
    expect(() =>
      createContributionRegistry([
        { slot: "frockbot.right-panel", id: "a", order: 1, component: first },
        { slot: "frockbot.right-panel", id: "a", order: 2, component: second },
      ]),
    ).toThrow(
      'contribution "a" is already registered for slot "frockbot.right-panel"',
    );
    expect(() =>
      createContributionRegistry([
        { slot: "  ", id: "a", order: 1, component: first },
      ]),
    ).toThrow("contribution slot must not be empty");
    expect(() =>
      createContributionRegistry([
        { slot: "frockbot.right-panel", id: " ", order: 1, component: first },
      ]),
    ).toThrow("contribution id must not be empty");
  });
});
