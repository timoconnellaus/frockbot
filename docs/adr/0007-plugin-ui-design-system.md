---
status: accepted
---

# Use plugin-owned feature UI inside theme- and shell-owned presentation

FrockBot follows the DeepSeek Harness separation without adopting its implementation: feature Packages own their hosted UI Contributions, `plugin-ui-theme` owns global semantic tokens, the Cordis-free `client-ui` module owns reusable Vue primitives, and `plugin-shell` owns application geometry and renders registered surfaces. This keeps feature lifecycle and behavior with Plugins while preventing each Plugin from inventing global colors, modal behavior, or z-index conventions; hosted client Contributions must depend on the theme and CI rejects literal feature colors or global theme selectors.

## Type scale and icon primitives (2026-08-31)

The colour contract alone left every plugin choosing its own pixel sizes and
Unicode glyphs, which is how the flock sidebar shipped at 7–10px text and the
header controls held off-centre `⚙`/`»` characters. The theme now also owns the
type scale (`--frock-text-xs` … `--frock-text-display`), leading, tracking,
control and avatar sizes, titlebar height, and shared motion keyframes.
`scripts/check-ui-styles.ts` rejects literal font sizes in feature styles the
same way it rejects literal colours. `client-ui` gains `UiIcon` (a stroke SVG
set), `UiIconButton` (icon centred by grid, mandatory label), and `UiSkeleton`;
plugins render icons through these rather than text glyphs. The shell pins Bot
actions and the panel toggle to the window's trailing edge so they do not move
when the right panel opens, matching the desktop chat apps FrockBot sits beside.

## Sandboxed non-first-party pages (2026-09-02)

The direct Vue Contribution path remains first-party-only. A Bot-authored or
Catalog Package contributes at most one content-addressed HTML page, rendered
by `plugin-shell` from the dedicated anonymous UI hostname in an
`allow-scripts` sandbox without `allow-same-origin`. The Shell owns the frame,
attribution, slot placement, sizing bounds, and the exact versioned bridge;
the page receives semantic theme tokens through `init` and never imports the
Cordis-free `client-ui` module. This preserves the design-system boundary while
keeping all non-first-party JavaScript out of the application origin.
