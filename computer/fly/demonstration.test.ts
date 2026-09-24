/**
 * The page script is where a demonstration either keeps what a person typed
 * or does not, so it is run here against a document whose every way of
 * reading a field's contents throws: a `value`, a field's text, a selection,
 * an input event's data. A step that needed any of them fails the test rather
 * than recording it, and every step it does report is searched for the
 * secrets typed into the page.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPUTER_DEMONSTRATION_MAX_SCREENSHOTS_V1,
  COMPUTER_DEMONSTRATION_MAX_STEPS_V1,
  COMPUTER_DEMONSTRATION_SCREENSHOT_MAX_BYTES_V1,
  decodeComputerDemonstrationStepsV1,
} from "@frockbot/computer/core/host";
import {
  DEMONSTRATION_MARKER,
  demonstrationPageScriptV1,
  demonstrationRecorderV1,
} from "./demonstration.ts";
import { decodeFlyDemonstrationV1 } from "./computer.ts";
import {
  BOTS_ROOT,
  COMPUTER_RUNTIME_FILES,
  DEMONSTRATION_SCRIPT,
  demonstrationRecorder,
  DESKTOP_GUI_LEASE_KEY,
} from "./runtime.ts";

const SECRETS = [
  "hunter2-password",
  "tim@example.com",
  "my private note",
  "4242424242424242",
  "prefilled-secret",
  "Chosen secret option",
];

function forbidden(what: string): never {
  throw new Error(`the page script read ${what}`);
}

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(readonly data: string) {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  parentNode: FakeElement | null = null;
  labels?: FakeElement[];
  control?: FakeElement;
  isContentEditable = false;
  private readonly attributes: Map<string, string>;

  constructor(tag: string, attributes: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
  }

  get parentElement(): FakeElement | null {
    return this.parentNode;
  }

  get previousElementSibling(): FakeElement | null {
    const siblings = (this.parentNode?.childNodes ?? []).filter(
      (node): node is FakeElement => node instanceof FakeElement,
    );
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1]! : null;
  }

  append(...children: Array<FakeElement | FakeText | string>): this {
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.push(node);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    // The `value` attribute of anything a person types into is the page's
    // prefill, which can be theirs; only a button's caption may be read.
    if (
      name === "value" &&
      this.tagName === "INPUT" &&
      !["submit", "button", "reset", "image"].includes(
        this.attributes.get("type") ?? "text",
      )
    ) {
      forbidden("a field's value attribute");
    }
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get value(): string {
    return forbidden("value");
  }
  get textContent(): string {
    return forbidden("textContent");
  }
  get innerText(): string {
    return forbidden("innerText");
  }
  get innerHTML(): string {
    return forbidden("innerHTML");
  }
  get selectionStart(): number {
    return forbidden("selectionStart");
  }
  get checked(): boolean {
    return forbidden("checked");
  }
  get selectedIndex(): number {
    return forbidden("selectedIndex");
  }
}

type Listener = (event: Record<string, unknown>) => void;

interface PageUnderTest {
  sent: Record<string, unknown>[];
  dispatch(type: string, target: FakeElement, extra?: object): void;
  byId: Map<string, FakeElement>;
}

function page(body: FakeElement): PageUnderTest {
  const listeners = new Map<string, Listener[]>();
  const byId = new Map<string, FakeElement>();
  const index = (element: FakeElement): void => {
    const id = element.getAttribute("id");
    if (id) byId.set(id, element);
    for (const child of element.childNodes) {
      if (child instanceof FakeElement) index(child);
    }
  };
  index(body);
  const sent: Record<string, unknown>[] = [];
  const window: Record<string, unknown> = {
    __frockbotDemonstrate_test: (payload: Record<string, unknown>) => {
      sent.push(structuredClone(payload));
      return Promise.resolve();
    },
  };
  window.top = window;
  const document = {
    visibilityState: "visible",
    addEventListener(type: string, listener: Listener, capture: boolean) {
      expect(capture).toBe(true);
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    getElementById: (id: string) => byId.get(id) ?? null,
  };
  // Evaluated exactly as a page evaluates it, with nothing but a window and
  // a document in reach.
  new Function(
    "window",
    "document",
    demonstrationPageScriptV1("__frockbotDemonstrate_test"),
  )(window, document);
  return {
    sent,
    byId,
    dispatch(type, target, extra = {}) {
      const event = {
        type,
        target,
        composedPath: () => [target],
        ...extra,
      };
      // Any way to the typed text from the event is refused too.
      Object.defineProperty(event, "data", {
        get: () => forbidden("an input event's data"),
      });
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function form(): FakeElement {
  const body = new FakeElement("body");
  const emailLabel = new FakeElement("label", { for: "email" }).append("Email");
  const email = new FakeElement("input", {
    id: "email",
    type: "email",
    name: "email",
    value: "prefilled-secret",
  });
  email.labels = [emailLabel];
  const password = new FakeElement("input", {
    id: "password",
    type: "password",
    name: "password",
  });
  const code = new FakeElement("input", {
    name: "verification",
    autocomplete: "one-time-code",
  });
  const card = new FakeElement("input", { name: "card_number" });
  const editor = new FakeElement("div", {
    role: "textbox",
    "aria-label": "Message body",
    contenteditable: "true",
  });
  editor.isContentEditable = true;
  const paragraph = new FakeElement("p").append("my private note");
  paragraph.isContentEditable = true;
  editor.append(paragraph);
  const court = new FakeElement("select", { name: "court" });
  const courtLabel = new FakeElement("label").append("Court");
  court.labels = [courtLabel];
  court.append(new FakeElement("option").append("Chosen secret option"));
  const searchLabel = new FakeElement("label").append("Search ");
  const search = new FakeElement("input", { type: "search" });
  searchLabel.append(search);
  searchLabel.control = search;
  search.labels = [searchLabel];
  const save = new FakeElement("button", { type: "submit" }).append(
    new FakeElement("span").append("Save"),
  );
  const signIn = new FakeElement("input", { type: "submit", value: "Sign in" });
  body.append(
    emailLabel,
    email,
    password,
    code,
    card,
    editor,
    courtLabel,
    court,
    searchLabel,
    save,
    signIn,
  );
  return body;
}

function secretsIn(sent: unknown): string[] {
  const text = JSON.stringify(sent);
  return SECRETS.filter((secret) => text.includes(secret));
}

describe("the demonstration page script", () => {
  test("names a field typed into once, by its label, and never what was typed", () => {
    const body = form();
    const { sent, dispatch, byId } = page(body);
    const email = byId.get("email")!;
    for (let index = 0; index < 5; index += 1) dispatch("input", email);

    expect(sent).toEqual([
      { role: "textbox", selector: "#email", name: "Email", kind: "type" },
    ]);
    expect(secretsIn(sent)).toEqual([]);
  });

  test("a password, a one-time code and a card number leave nothing at all", () => {
    const body = form();
    const { sent, dispatch, byId } = page(body);
    const password = byId.get("password")!;
    const [, , , code, card] = body.childNodes as FakeElement[];
    for (const field of [password, code!, card!]) {
      dispatch("click", field);
      dispatch("input", field);
      dispatch("keydown", field, { key: "h" });
      dispatch("keydown", field, { key: "Enter" });
      dispatch("change", field);
    }

    expect(sent).toEqual([]);
  });

  test("keeps special keys and shortcuts, and no printable character", () => {
    const body = form();
    const { sent, dispatch, byId } = page(body);
    const email = byId.get("email")!;
    for (const key of ["t", "i", "m", "@", " ", "Shift"]) {
      dispatch("keydown", email, { key });
    }
    dispatch("keydown", email, { key: "A", shiftKey: true });
    dispatch("keydown", email, { key: "Enter" });
    dispatch("keydown", email, { key: "Tab", shiftKey: true });
    dispatch("keydown", email, { key: "s", ctrlKey: true });
    dispatch("keydown", email, { key: "K", metaKey: true, shiftKey: true });

    expect(sent).toEqual([
      { kind: "key", key: "Enter" },
      { kind: "key", key: "Shift+Tab" },
      { kind: "key", key: "Control+s" },
      { kind: "key", key: "Meta+Shift+k" },
    ]);
  });

  test("names a rich editor by its label, not by the words written in it", () => {
    const body = form();
    const { sent, dispatch } = page(body);
    const editor = body.childNodes[5] as FakeElement;
    const paragraph = editor.childNodes[0] as FakeElement;
    dispatch("click", paragraph);
    dispatch("input", paragraph);

    expect(sent).toEqual([
      {
        role: "textbox",
        selector: 'div[aria-label="Message body"]',
        name: "Message body",
        kind: "click",
      },
      {
        role: "textbox",
        selector: 'div[aria-label="Message body"]',
        name: "Message body",
        kind: "type",
      },
    ]);
    expect(secretsIn(sent)).toEqual([]);
  });

  test("a choice says which list, never which option", () => {
    const body = form();
    const { sent, dispatch } = page(body);
    dispatch("change", body.childNodes[7] as FakeElement);

    expect(sent).toEqual([
      {
        role: "combobox",
        selector: 'select[name="court"]',
        name: "Court",
        kind: "choose",
      },
    ]);
    expect(secretsIn(sent)).toEqual([]);
  });

  test("names buttons by the words on them and a label by its control", () => {
    const body = form();
    const { sent, dispatch } = page(body);
    const searchLabel = body.childNodes[8] as FakeElement;
    const save = body.childNodes[9] as FakeElement;
    const signIn = body.childNodes[10] as FakeElement;
    dispatch("click", save.childNodes[0] as FakeElement);
    dispatch("click", signIn);
    dispatch("click", searchLabel);

    expect(sent.map(({ kind, role, name }) => ({ kind, role, name }))).toEqual([
      { kind: "click", role: "button", name: "Save" },
      { kind: "click", role: "button", name: "Sign in" },
      { kind: "click", role: "searchbox", name: "Search" },
    ]);
  });

  test("every step it sends survives the step decoder, with nothing typed in it", () => {
    const body = form();
    const { sent, dispatch, byId } = page(body);
    dispatch("click", byId.get("email")!);
    dispatch("input", byId.get("email")!);
    dispatch("keydown", byId.get("email")!, { key: "Enter" });
    dispatch("change", body.childNodes[7] as FakeElement);
    // What the recorder makes of each: the kind becomes the action, and the
    // tab and the time are its own.
    const steps = sent.map((payload, index) => {
      const { kind, ...rest } = payload;
      return { action: kind, t: index, tab: 1, ...rest };
    });

    const decoded = decodeComputerDemonstrationStepsV1(steps);
    expect(decoded.dropped).toBe(0);
    expect(decoded.steps.map((step) => step.action)).toEqual([
      "click",
      "type",
      "key",
      "choose",
    ]);
    expect(secretsIn(decoded)).toEqual([]);
  });
});

describe("the installed recorder", () => {
  test("is a runtime file, holding the Computer interface's own bounds", () => {
    const installed = COMPUTER_RUNTIME_FILES.find(
      (file) => file.path === DEMONSTRATION_SCRIPT,
    );
    expect(installed?.content).toBe(demonstrationRecorder);
    expect(installed?.mode).toBe(0o700);
    // Literals in the runtime module, because the container cannot import
    // the interface; this is what keeps the two from drifting.
    for (const [name, value] of [
      ["maxSteps", COMPUTER_DEMONSTRATION_MAX_STEPS_V1],
      ["maxScreenshots", COMPUTER_DEMONSTRATION_MAX_SCREENSHOTS_V1],
      ["maxScreenshotBytes", COMPUTER_DEMONSTRATION_SCREENSHOT_MAX_BYTES_V1],
    ] as const) {
      expect(demonstrationRecorder).toContain(`"${name}":${value}`);
    }
    // It watches the same lease file the control script writes.
    expect(demonstrationRecorder).toContain(
      `"leasePath":"${BOTS_ROOT}/${DESKTOP_GUI_LEASE_KEY}/human-control"`,
    );
    // And it parses as the module it is installed as.
    expect(() =>
      new Bun.Transpiler({ loader: "js" }).transformSync(demonstrationRecorder),
    ).not.toThrow();
  });
});

describe("the recorder's collect", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function recorder(): string {
    const directory = mkdtempSync(join(tmpdir(), "demonstration-"));
    directories.push(directory);
    const program = join(directory, "demonstrate.mjs");
    writeFileSync(
      program,
      demonstrationRecorderV1({
        botsRoot: join(directory, "bots"),
        targetIdFile: "target-id",
        leasePath: join(directory, "lease"),
        leaseMaxAgeSeconds: 90,
        maxSteps: 200,
        maxScreenshots: 4,
        maxScreenshotBytes: 512 * 1024,
      }),
    );
    return program;
  }

  function jpeg(seed: number): Buffer {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, seed, seed]);
  }

  test("hands back what the recorder wrote, with four screenshots spread across it", async () => {
    const program = recorder();
    const directory = mkdtempSync(join(tmpdir(), "demonstration-run-"));
    directories.push(directory);
    writeFileSync(join(directory, "started"), "2026-09-24T10:00:00.000Z");
    writeFileSync(
      join(directory, "stopped"),
      JSON.stringify({
        reason: "control-released",
        stoppedAt: "2026-09-24T10:02:00.000Z",
      }),
    );
    writeFileSync(
      join(directory, "events.jsonl"),
      [
        { action: "navigate", t: 0, tab: 1, url: "https://example.com/a?q=1" },
        {
          action: "type",
          t: 3,
          tab: 1,
          role: "textbox",
          name: "Email",
          selector: "#email",
          // A recorder that wrote a value would be caught on the way out.
          value: "tim@example.com",
        },
        { action: "key", t: 4, tab: 1, key: "Enter" },
      ]
        .map((step) => JSON.stringify(step))
        .join("\n") + "\nnot json\n",
    );
    for (let seq = 1; seq <= 7; seq += 1) {
      writeFileSync(join(directory, `shot-${seq}-${seq}.jpg`), jpeg(seq));
    }

    const child = Bun.spawn(["bun", program, "collect", directory], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const line = output
      .split("\n")
      .find((candidate) => candidate.startsWith(DEMONSTRATION_MARKER))!;
    const capture = decodeFlyDemonstrationV1(
      line.slice(DEMONSTRATION_MARKER.length),
    );

    expect(capture.startedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(capture.stoppedBecause).toBe("control-released");
    expect(capture.steps).toEqual([
      { action: "navigate", t: 0, tab: 1, url: "https://example.com/a?q=…" },
      { action: "key", t: 4, tab: 1, key: "Enter" },
    ]);
    expect(capture.dropped).toBe(1);
    // The first, the last, and two between: the whole demonstration, not
    // its opening seconds.
    expect(capture.screenshots.map((shot) => shot.bytes[4])).toEqual([
      1, 3, 5, 7,
    ]);
    expect(secretsIn(capture)).toEqual([]);
    expect(readFileSync(join(directory, "started"), "utf8")).toContain("2026");
  });
});
