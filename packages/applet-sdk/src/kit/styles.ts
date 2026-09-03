/**
 * The kit's one stylesheet, as a string so the bundle stays a single file and
 * no build step has to know about CSS.
 *
 * Every colour, radius, and edge resolves through one of the nine semantic
 * tokens the host injects as `--frockbot-*`; the fallbacks are what the page
 * looks like before `init` arrives, or in a plain browser tab. Nothing here
 * spells a colour that is not a fallback, which is the rule the linter enforces
 * for Applet code too.
 */
export const KIT_CSS = `
.fb-root, .fb-root * { box-sizing: border-box; }
.fb-root {
  --fb-surface: var(--frockbot-surface, #ffffff);
  --fb-surface-raised: var(--frockbot-surface-raised, #ffffff);
  --fb-surface-subtle: var(--frockbot-surface-subtle, #f3f4f6);
  --fb-text: var(--frockbot-text, #16181d);
  --fb-text-muted: var(--frockbot-text-muted, #5b616b);
  --fb-border: var(--frockbot-border, #d8dbe0);
  --fb-accent-surface: var(--frockbot-accent-surface, #2f6feb);
  --fb-accent-text: var(--frockbot-accent-text, #ffffff);
  --fb-radius: var(--frockbot-radius-card, 10px);
  --fb-radius-sm: calc(var(--fb-radius) / 2);
  --fb-gap: 8px;
  color: var(--fb-text);
  background: var(--fb-surface);
  font: 400 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 100%;
}

.fb-stack { display: flex; }
.fb-stack[data-direction="column"] { flex-direction: column; }
.fb-stack[data-direction="row"] { flex-direction: row; align-items: center; }
.fb-stack[data-wrap="true"] { flex-wrap: wrap; }
.fb-stack[data-align="start"] { align-items: flex-start; }
.fb-stack[data-align="center"] { align-items: center; }
.fb-stack[data-align="end"] { align-items: flex-end; }
.fb-stack[data-align="stretch"] { align-items: stretch; }
.fb-stack[data-justify="start"] { justify-content: flex-start; }
.fb-stack[data-justify="center"] { justify-content: center; }
.fb-stack[data-justify="end"] { justify-content: flex-end; }
.fb-stack[data-justify="between"] { justify-content: space-between; }

.fb-text { margin: 0; color: var(--fb-text); }
.fb-text[data-tone="muted"] { color: var(--fb-text-muted); }
.fb-text[data-size="title"] { font-size: 20px; font-weight: 600; line-height: 1.3; }
.fb-text[data-size="heading"] { font-size: 16px; font-weight: 600; line-height: 1.4; }
.fb-text[data-size="body"] { font-size: 14px; }
.fb-text[data-size="small"] { font-size: 12px; }

.fb-button {
  appearance: none;
  border: 1px solid var(--fb-border);
  border-radius: var(--fb-radius-sm);
  background: var(--fb-surface-raised);
  color: var(--fb-text);
  font: inherit;
  padding: 6px 12px;
  min-height: 32px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.fb-button:hover:not(:disabled) { background: var(--fb-surface-subtle); }
.fb-button:focus-visible { outline: 2px solid var(--fb-accent-surface); outline-offset: 1px; }
.fb-button:disabled { opacity: 0.5; cursor: default; }
.fb-button[data-variant="primary"] {
  background: var(--fb-accent-surface);
  border-color: var(--fb-accent-surface);
  color: var(--fb-accent-text);
}
.fb-button[data-variant="primary"]:hover:not(:disabled) { filter: brightness(0.94); }
.fb-button[data-variant="ghost"] { background: transparent; border-color: transparent; }
.fb-button[data-variant="ghost"]:hover:not(:disabled) { background: var(--fb-surface-subtle); }

.fb-field { display: flex; flex-direction: column; gap: 4px; }
.fb-label { font-size: 12px; color: var(--fb-text-muted); }
.fb-control {
  appearance: none;
  border: 1px solid var(--fb-border);
  border-radius: var(--fb-radius-sm);
  background: var(--fb-surface-raised);
  color: var(--fb-text);
  font: inherit;
  padding: 6px 10px;
  min-height: 32px;
  width: 100%;
}
.fb-control:focus-visible { outline: 2px solid var(--fb-accent-surface); outline-offset: -1px; }
.fb-control:disabled { opacity: 0.5; }
textarea.fb-control { min-height: 72px; resize: vertical; }
.fb-error { font-size: 12px; color: var(--fb-accent-surface); }

.fb-checkbox { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.fb-checkbox input { accent-color: var(--fb-accent-surface); width: 16px; height: 16px; margin: 0; }
.fb-checkbox[data-disabled="true"] { opacity: 0.5; cursor: default; }

.fb-card {
  border: 1px solid var(--fb-border);
  border-radius: var(--fb-radius);
  background: var(--fb-surface-raised);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: var(--fb-gap);
}
.fb-card-title { font-size: 16px; font-weight: 600; }

.fb-toolbar {
  display: flex;
  align-items: center;
  gap: var(--fb-gap);
  padding: 8px 0;
  border-bottom: 1px solid var(--fb-border);
}
.fb-toolbar-spacer { flex: 1 1 auto; }

.fb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.fb-list[data-bordered="true"] > .fb-list-item + .fb-list-item { border-top: 1px solid var(--fb-border); }
.fb-list-item {
  display: flex;
  align-items: center;
  gap: var(--fb-gap);
  padding: 8px 4px;
  min-height: 36px;
}
.fb-list-item[data-interactive="true"] { cursor: pointer; border-radius: var(--fb-radius-sm); }
.fb-list-item[data-interactive="true"]:hover { background: var(--fb-surface-subtle); }
.fb-list-item-body { flex: 1 1 auto; min-width: 0; }
.fb-list-item-end { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }

.fb-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid var(--fb-border);
  background: var(--fb-surface-subtle);
  color: var(--fb-text-muted);
  font-size: 12px;
  line-height: 1;
  padding: 3px 8px;
}
.fb-badge[data-tone="accent"] {
  background: var(--fb-accent-surface);
  border-color: var(--fb-accent-surface);
  color: var(--fb-accent-text);
}

.fb-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
  padding: 32px 16px;
  color: var(--fb-text-muted);
  border: 1px dashed var(--fb-border);
  border-radius: var(--fb-radius);
}
.fb-empty-title { font-size: 15px; font-weight: 600; color: var(--fb-text); }

.fb-dialog-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--frockbot-text, #16181d) 45%, transparent);
  z-index: 10;
}
.fb-dialog {
  background: var(--fb-surface-raised);
  border: 1px solid var(--fb-border);
  border-radius: var(--fb-radius);
  width: min(420px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.fb-dialog-title { font-size: 16px; font-weight: 600; }
.fb-dialog-actions { display: flex; justify-content: flex-end; gap: var(--fb-gap); }
`;

const STYLE_MARKER = "data-frockbot-kit";

/** Inject the stylesheet once. Called on import; safe outside a browser. */
export function installKitStyles(): void {
  if (typeof document === "undefined") return;
  if (document.head.querySelector(`style[${STYLE_MARKER}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "1");
  style.textContent = KIT_CSS;
  document.head.append(style);
}
