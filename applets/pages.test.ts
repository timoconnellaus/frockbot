// The Applets pages say each fact once.
//
// The overlay used to stack three headings — the surface's own title, the
// frame's attribution, and this page's `<h1>` — and then tell a person twice
// that a draft was not finished: once in the line under its name and again in
// a pill beside it (2026-09-05).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const list = readFileSync(`${import.meta.dir}/pages/list.html`, "utf8");

describe("the Applets list page", () => {
  test("has no heading of its own", () => {
    expect(list).not.toContain("<h1>");
  });

  test("says a draft is unfinished once, in the line under its name", () => {
    expect(list).toContain("Still being built · not published yet");
    expect(list).not.toContain("Not ready yet");
    expect(list).not.toContain('className = "pending"');
  });

  test("still offers the one action a published Applet has", () => {
    expect(list).toContain("action.textContent =");
    expect(list).toContain("window.frockbot.focus(applet.appletId)");
  });
});
