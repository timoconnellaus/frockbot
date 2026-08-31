import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  test("escapes author HTML instead of emitting it", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> **bold**');

    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
  });

  test("opens links in a new context without window access", () => {
    const html = renderMarkdown("[docs](https://example.com/docs)");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("linkifies bare URLs with the same link attributes", () => {
    const html = renderMarkdown("see https://example.com for more");

    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("renders fenced code blocks and inline code", () => {
    const html = renderMarkdown("```\nconst x = 1 < 2;\n```\n\nuse `bun test`");

    expect(html).toContain("<pre><code>const x = 1 &lt; 2;");
    expect(html).toContain("<code>bun test</code>");
  });

  test("keeps single newlines as breaks", () => {
    expect(renderMarkdown("one\ntwo")).toContain("<br>");
  });

  test("renders lists", () => {
    const html = renderMarkdown("- first\n- second");

    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first</li>");
  });
});
