import { describe, expect, it } from "bun:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { appletRules, lintCssText } from "../src/lint/index.js";

// ESLint's RuleTester drives whatever test framework it is handed.
const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser as never,
    parserOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

RuleTester.describe = describe as never;
RuleTester.it = it as never;

const rule = (name: keyof typeof appletRules) => appletRules[name] as never;

tester.run("no-raw-colors", rule("no-raw-colors"), {
  valid: [
    { code: `const s = "var(--frockbot-accent-surface)";` },
    { code: "const css = `color: var(--frockbot-text, #16181d);`;" },
    { code: `const label = "a red apple";` },
    { code: `const style = { color: "var(--frockbot-text)" };` },
  ],
  invalid: [
    { code: `const s = "#ff0000";`, errors: 1 },
    { code: "const css = `background: rgb(1, 2, 3);`;", errors: 1 },
    { code: `const style = { color: "red" };`, errors: 1 },
    { code: `const style = { backgroundColor: "white" };`, errors: 1 },
  ],
});

tester.run("no-network", rule("no-network"), {
  valid: [
    { code: `applet.tables.todos.insert({ id: "1" });` },
    { code: `const socket = applet.connect(init);` },
  ],
  invalid: [
    { code: `await fetch("https://example.com");`, errors: 1 },
    { code: `window.fetch("/x");`, errors: 1 },
    { code: `new XMLHttpRequest();`, errors: 1 },
    { code: `new WebSocket("wss://example.com");`, errors: 1 },
    { code: `navigator.sendBeacon("/x");`, errors: 1 },
  ],
});

tester.run("allowed-imports", rule("allowed-imports"), {
  valid: [
    { code: `import { Applet } from "@frockbot/applet-sdk/server";` },
    { code: `import { useState } from "react";` },
    { code: `import { jsx } from "react/jsx-runtime";` },
    { code: `import App from "./ui";` },
    { code: `export { x } from "../shared";` },
  ],
  invalid: [
    { code: `import lodash from "lodash";`, errors: 1 },
    { code: `import x from "node:fs";`, errors: 1 },
    { code: `const y = await import("axios");`, errors: 1 },
    { code: `export * from "zod";`, errors: 1 },
  ],
});

const wrap = (body: string) => `class Todo extends Applet {\n${body}\n}`;

tester.run("tables-via-table", rule("tables-via-table"), {
  valid: [
    { code: wrap(`tables = { todos: table({ id: t.id() }) };`) },
    { code: wrap(`tools = {};`) },
    { code: `class Other extends Base { tables = { a: 1 }; }` },
  ],
  invalid: [
    { code: wrap(`tables = { todos: { id: 1 } };`), errors: 1 },
    { code: wrap(`tables = someTables;`), errors: 1 },
  ],
});

tester.run("tools-via-this-tool", rule("tools-via-this-tool"), {
  valid: [
    {
      code: wrap(
        `tools = { add: this.tool({ description: "d", input: {} }, () => "") };`,
      ),
    },
    { code: wrap(`tables = { a: table({}) };`) },
  ],
  invalid: [
    { code: wrap(`tools = { add: makeTool() };`), errors: 1 },
    { code: wrap(`tools = allTools;`), errors: 1 },
  ],
});

describe("the CSS colour scan", () => {
  it("accepts a token and its fallback", () => {
    expect(
      lintCssText(".a { color: var(--frockbot-text, #16181d); }", "a.css"),
    ).toEqual([]);
  });

  it("reports a literal used as a value", () => {
    const [diagnostic] = lintCssText(".a {\n  color: #ff0000;\n}", "a.css");
    expect(diagnostic).toMatchObject({
      file: "a.css",
      line: 2,
      severity: "error",
    });
    expect(diagnostic!.message).toContain("--frockbot-");
  });

  it("reports rgb() and an untethered color-mix()", () => {
    expect(
      lintCssText(".a { background: rgba(0,0,0,.4); }", "a.css"),
    ).toHaveLength(1);
    expect(
      lintCssText(
        ".a { background: color-mix(in srgb, black, white); }",
        "a.css",
      ),
    ).toHaveLength(1);
  });

  it("accepts a color-mix() over a token", () => {
    expect(
      lintCssText(
        ".a { background: color-mix(in srgb, var(--frockbot-text) 40%, transparent); }",
        "a.css",
      ),
    ).toEqual([]);
  });

  it("judges each declaration on the line separately", () => {
    expect(
      lintCssText(
        ".a { background: var(--frockbot-surface, #ffffff); color: #ff0000; }",
        "a.css",
      ),
    ).toHaveLength(1);
  });
});
