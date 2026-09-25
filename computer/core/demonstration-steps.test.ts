import { describe, expect, test } from "bun:test";
import {
  COMPUTER_DEMONSTRATION_MAX_STEPS_V1,
  decodeComputerDemonstrationStepV1,
  decodeComputerDemonstrationStepsV1,
  demonstrationKeyV1,
  demonstrationUrlV1,
  isDemonstrationScreenshotV1,
} from "@frockbot/computer/core/host";

describe("a demonstration step", () => {
  test("keeps exactly the fields a step has", () => {
    expect(
      decodeComputerDemonstrationStepV1({
        action: "type",
        t: 3.14159,
        tab: 1,
        role: "textbox",
        name: "  Email\n address ",
        selector: "#email",
      }),
    ).toEqual({
      action: "type",
      t: 3.1,
      tab: 1,
      role: "textbox",
      name: "Email address",
      selector: "#email",
    });
  });

  test("is not a step at all once it carries anything that could hold what was typed", () => {
    const typed = {
      action: "type",
      t: 1,
      tab: 1,
      role: "textbox",
      selector: "#email",
    };
    for (const extra of [
      { value: "tim@example.com" },
      { text: "tim@example.com" },
      { data: "t" },
      { key: "t" },
    ]) {
      expect(decodeComputerDemonstrationStepV1({ ...typed, ...extra })).toBe(
        undefined,
      );
    }
    expect(
      decodeComputerDemonstrationStepV1({
        action: "navigate",
        t: 1,
        tab: 1,
        url: "https://example.com/",
        title: "Results for tim@example.com",
      }),
    ).toBe(undefined);
  });

  test("keeps a special key or a shortcut, and never a printable character", () => {
    for (const key of [
      "Enter",
      "Shift+Tab",
      "Escape",
      "ArrowDown",
      "F5",
      "Control+s",
      "Meta+Shift+k",
    ]) {
      expect(demonstrationKeyV1(key)).toBe(key);
    }
    for (const key of [
      "a",
      "A",
      "Shift+a",
      "Alt+a",
      "@",
      " ",
      "Space",
      "Control+@",
      "Control+Control+s",
      "Hyper+s",
      "",
    ]) {
      expect(demonstrationKeyV1(key)).toBe(undefined);
    }
  });

  test("keeps a URL's query names and drops their values, its fragment and credentials", () => {
    expect(
      demonstrationUrlV1(
        "https://user:pass@shop.example.com/search?q=my+secret&page=2&q=again#token=abc",
      ),
    ).toBe("https://shop.example.com/search?q=…&page=…");
    expect(demonstrationUrlV1("https://example.com/")).toBe(
      "https://example.com/",
    );
    expect(demonstrationUrlV1("about:blank")).toBe("about:blank");
    expect(demonstrationUrlV1("data:text/plain,secret")).toBe(undefined);
    expect(demonstrationUrlV1("javascript:alert(1)")).toBe(undefined);
    expect(demonstrationUrlV1("not a url")).toBe(undefined);
  });

  test("a navigation keeps the URL the same way", () => {
    expect(
      decodeComputerDemonstrationStepV1({
        action: "navigate",
        t: 0,
        tab: 2,
        url: "https://example.com/login?next=/account&email=tim@example.com",
      }),
    ).toEqual({
      action: "navigate",
      t: 0,
      tab: 2,
      url: "https://example.com/login?next=…&email=…",
    });
  });

  test("a steps list keeps what decodes, counts what does not, and stops at the bound", () => {
    const step = { action: "key", t: 0, tab: 1, key: "Enter" };
    const decoded = decodeComputerDemonstrationStepsV1([
      step,
      { ...step, key: "x" },
      "nonsense",
      ...Array.from(
        { length: COMPUTER_DEMONSTRATION_MAX_STEPS_V1 },
        () => step,
      ),
    ]);
    expect(decoded.steps).toHaveLength(COMPUTER_DEMONSTRATION_MAX_STEPS_V1);
    expect(decoded.dropped).toBe(3);
    expect(decodeComputerDemonstrationStepsV1("nope")).toEqual({
      steps: [],
      dropped: 0,
    });
  });

  test("a screenshot is a JPEG within the bound", () => {
    expect(
      isDemonstrationScreenshotV1(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    ).toBe(true);
    expect(
      isDemonstrationScreenshotV1(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ).toBe(false);
    expect(
      isDemonstrationScreenshotV1(
        Object.assign(new Uint8Array(600 * 1024), {
          0: 0xff,
          1: 0xd8,
          2: 0xff,
        }),
      ),
    ).toBe(false);
  });
});
