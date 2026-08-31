import MarkdownIt from "markdown-it";

/*
 * Assistant text is Markdown. Rendering it needs no sanitizer because the
 * parser never emits author HTML: `html: false` escapes every raw tag, and the
 * only markup in the output is what markdown-it itself generates. `breaks`
 * keeps single newlines meaningful the way chat clients do, and `typographer`
 * stays off so code, paths, and quotes survive verbatim.
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));

// Every link leaves the application, so it opens in a new context and is
// denied access to this window through `opener`.
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** Renders Markdown to HTML that is safe to inject without a sanitizer. */
export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
