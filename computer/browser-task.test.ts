import { describe, expect, test } from "bun:test";
import {
  browserTaskActionsV1,
  browserTaskControlsV1,
  browserTaskFieldStateV1,
  runBrowserTaskV1,
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

describe("running a task", () => {
  const PAGE = `- heading "Account" [level=1]
- checkbox "Email notifications" [checked]
- button "Delete account"
- button "Save changes"`;

  function ports(
    answers: Array<
      | Record<
          string,
          {
            choice?: string;
            probabilities?: Record<string, number>;
            noul?: number;
          }
        >
      | undefined
    >,
    options: {
      snapshots?: string[];
      refuse?: string;
    } = {},
  ) {
    const acted: string[] = [];
    const reviewed: string[] = [];
    let observed = 0;
    let asked = 0;
    return {
      acted,
      reviewed,
      value: {
        observe: async () => ({
          url: "https://example.com/",
          title: "Account",
          snapshot:
            options.snapshots?.[
              Math.min(observed++, options.snapshots.length - 1)
            ] ?? PAGE,
        }),
        act: async (action: { describe: string }) => {
          acted.push(action.describe);
        },
        decide: async () => answers[asked++],
        review: async (action: { describe: string }) => {
          reviewed.push(action.describe);
          return options.refuse;
        },
      },
    };
  }

  const pick = (key: string, p = 0.9, extra: Record<string, number> = {}) => ({
    page: { choice: "ready", probabilities: { ready: 1 } },
    action: { choice: key, probabilities: { [key]: p, ...extra } },
  });

  test("acts until Jev says the goal is done", async () => {
    const run = ports([pick("a1"), pick("finish")], {
      snapshots: [PAGE, PAGE.replace(" [checked]", "")],
    });
    const report = await runBrowserTaskV1(
      { goal: "Turn off email notifications" },
      run.value,
    );
    expect(report.outcome).toBe("done");
    expect(run.acted).toEqual([
      'untick checkbox "Email notifications" (now ticked) — in: Account',
    ]);
    expect(run.reviewed).toEqual([]);
  });

  test("a committing click is reviewed first, and a refusal ends the task", async () => {
    const run = ports([pick("a2")], {
      refuse: "The person did not ask to delete it.",
    });
    const report = await runBrowserTaskV1(
      { goal: "Delete my account" },
      run.value,
    );
    expect(report).toMatchObject({
      outcome: "needs_approval",
      reason: "The person did not ask to delete it.",
    });
    expect(run.reviewed).toEqual([
      'click button "Delete account" — in: Account',
    ]);
    expect(run.acted).toEqual([]);
  });

  test("a click Jev judges committing is reviewed; one it judges not is not", async () => {
    const run = ports([pick("a3"), { commits: { noul: 0.9 } }, pick("finish")]);
    await runBrowserTaskV1({ goal: "Save" }, run.value);
    expect(run.reviewed).toEqual(['click button "Save changes" — in: Account']);
    expect(run.acted).toEqual(['click button "Save changes" — in: Account']);
  });

  test("a sign-in wall goes to the person before anything is clicked", async () => {
    const run = ports([
      {
        page: { choice: "sign_in", probabilities: { sign_in: 0.9 } },
        action: { choice: "a1", probabilities: { a1: 0.9 } },
      },
    ]);
    const report = await runBrowserTaskV1({ goal: "Read it" }, run.value);
    expect(report.outcome).toBe("needs_person");
    expect(run.acted).toEqual([]);
  });

  test("a stop beside a live alternative explores it, then stops", async () => {
    const run = ports(
      [
        pick("a1", 0.15, { stop: 0.8 }),
        pick("a1", 0.15, { stop: 0.8 }),
        pick("a1", 0.15, { stop: 0.8 }),
      ],
      { snapshots: [PAGE, PAGE + "\n- text: one", PAGE + "\n- text: two"] },
    );
    const report = await runBrowserTaskV1({ goal: "x" }, run.value);
    expect(run.acted.length).toBe(2);
    expect(report.outcome).toBe("blocked");
  });

  test("an action that leaves the page unchanged twice ends the task blocked", async () => {
    const run = ports([pick("a1"), pick("a1"), pick("a1")]);
    const report = await runBrowserTaskV1({ goal: "x" }, run.value);
    expect(report.outcome).toBe("blocked");
    expect(report.reason).toContain("did not respond");
    expect(run.acted.length).toBe(1);
  });

  test("Jev not answering ends the task blocked, and the step limit holds", async () => {
    expect(
      (await runBrowserTaskV1({ goal: "x" }, ports([undefined]).value)).outcome,
    ).toBe("blocked");
    const busy = ports(
      Array.from({ length: 10 }, (_, i) => [pick("a1")][0]),
      {
        snapshots: Array.from(
          { length: 10 },
          (_, i) => `${PAGE}\n- text: ${i}`,
        ),
      },
    );
    const report = await runBrowserTaskV1(
      { goal: "x", maxSteps: 3 },
      busy.value,
    );
    expect(report.outcome).toBe("step_limit");
    expect(busy.acted.length).toBe(3);
  });
});
