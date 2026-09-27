import { describe, expect, test } from "bun:test";
import {
  browserTaskActionsV1,
  browserTaskControlsV1,
  browserTaskFieldStateV1,
} from "./browser-task.js";

const SIGNUP = `- heading "Create your account" [level=1]
- paragraph:
  - text: Full name
  - textbox "Full name": Sam
- paragraph:
  - text: Country
  - combobox "Country":
    - option "Choose…" [selected]
    - option "Australia"
    - option "Canada"
- group "Plan":
  - text: Plan
  - radio "Free" [checked]
  - radio "Pro"
- paragraph:
  - checkbox "I agree to the terms of service"
- button "Create account" [disabled]`;

const INVOICES = `- heading "Invoices" [level=1]
- table:
  - rowgroup:
    - 'row "Invoice #1000 Acme $50.00 View Archive"':
      - 'cell "Invoice #1000"'
      - cell "View Archive":
        - button "View"
        - button "Archive"
    - 'row "Invoice #1042 Initech $404.00 View Archive"':
      - cell "View Archive":
        - button "View"
        - button "Archive"`;

const SETTINGS = `- button "Settings"
- dialog "Settings":
  - heading "Settings" [level=2]
  - paragraph:
    - checkbox "Email notifications" [checked]
  - button "Save changes"`;

const LISTBOX = `- combobox "Country" [expanded]: Select a country
- listbox "Country":
  - option "Argentina"
  - option "Australia"`;

describe("reading controls from a snapshot", () => {
  test("names each control's state and region", () => {
    const controls = browserTaskControlsV1(SIGNUP);
    expect(controls.map((c) => [c.role, c.name])).toEqual([
      ["textbox", "Full name"],
      ["combobox", "Country"],
      ["radio", "Free"],
      ["radio", "Pro"],
      ["checkbox", "I agree to the terms of service"],
      ["button", "Create account"],
    ]);
    expect(controls[0]).toMatchObject({ value: "Sam" });
    expect(controls[1]).toMatchObject({
      options: ["Choose…", "Australia", "Canada"],
      value: "Choose…",
    });
    expect(controls[2]).toMatchObject({ checked: true, region: "Plan" });
    expect(controls[4]).toMatchObject({ checked: false });
    expect(controls[5]).toMatchObject({ disabled: true });
    expect(controls.map(browserTaskFieldStateV1).filter(Boolean)).toEqual([
      'textbox "Full name": "Sam"',
      'combobox "Country": "Choose…"',
      'radio "Free": ticked',
      'radio "Pro": not ticked',
      'checkbox "I agree to the terms of service": not ticked',
    ]);
  });

  test("tells same-named controls apart by their row and their order", () => {
    const archive = browserTaskControlsV1(INVOICES).filter(
      (c) => c.name === "Archive",
    );
    expect(archive).toEqual([
      expect.objectContaining({
        nth: 0,
        count: 2,
        region: "Invoice #1000 Acme $50.00 View Archive",
      }),
      expect.objectContaining({
        nth: 1,
        count: 2,
        region: "Invoice #1042 Initech $404.00 View Archive",
      }),
    ]);
  });

  test("a dialog is a region, and an open custom listbox offers its options", () => {
    expect(browserTaskControlsV1(SETTINGS)[1]).toMatchObject({
      name: "Email notifications",
      region: "Settings",
      checked: true,
    });
    const listbox = browserTaskControlsV1(LISTBOX);
    expect(listbox.map((c) => [c.role, c.name])).toEqual([
      ["combobox", "Country"],
      ["option", "Argentina"],
      ["option", "Australia"],
    ]);
    expect(listbox[0]).toMatchObject({ expanded: true });
    expect(listbox[0]!.options).toBeUndefined();
  });
});

describe("the actions a page allows", () => {
  test("offers only what each control supports, and nothing on a disabled one", () => {
    const actions = browserTaskActionsV1(browserTaskControlsV1(SIGNUP), {
      name: "Sam Lee",
      email: "sam@example.com",
    });
    expect(actions.map((a) => a.describe)).toEqual([
      'type values.name into textbox "Full name" (now holds "Sam") — in: Create your account',
      'type values.email into textbox "Full name" (now holds "Sam") — in: Create your account',
      'select "Australia" in "Country" (now "Choose…") — in: Create your account',
      'select "Canada" in "Country" (now "Choose…") — in: Create your account',
      'choose radio "Pro" — in: Plan',
      'tick checkbox "I agree to the terms of service" (now not ticked) — in: Create your account',
    ]);
    expect(actions.map((a) => a.key)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
    ]);
  });

  test("a field already holding a value is not offered it again", () => {
    const actions = browserTaskActionsV1(browserTaskControlsV1(SIGNUP), {
      name: "Sam",
    });
    expect(actions.some((a) => a.operation.op === "type")).toBe(false);
  });
});
