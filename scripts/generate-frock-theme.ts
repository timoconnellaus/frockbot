/**
 * Frock UI tokens → CSS custom properties.
 *
 * `docs/design/tokens.json` is the one source for every surface: the Flutter
 * app carries the same numbers in `apps/native/lib/ui/frock_tokens.dart`, and
 * the web shell, the Applet kit and A2UI read them from the stylesheet this
 * script writes. Desktop density is the default; the phone density applies
 * under the same breakpoint the shell uses for its one-column layout; the
 * light palette is opt-in through `data-theme="light"` because the product
 * ships dark.
 *
 *   bun scripts/generate-frock-theme.ts          # write
 *   bun scripts/generate-frock-theme.ts --check  # fail if the file is stale
 */
import { readFileSync, writeFileSync } from "node:fs";

const source = "docs/design/tokens.json";
const target = "packages/plugin-ui-theme/src/client/tokens.generated.css";
const phoneBreakpoint = "max-width: 640px";

type Palette = Record<string, string>;
type TypeRole = {
  family: "sans" | "display" | "mono";
  weight?: number;
  size: number;
  lineHeight: number;
  tracking?: number;
  uppercase?: boolean;
  tabular?: boolean;
  slashedZero?: boolean;
};
type Density = "phone" | "desktop";
interface Tokens {
  color: Record<"dark" | "light", Palette>;
  font: {
    sans: string;
    display: string;
    mono: string;
    weights: Record<string, number>;
  };
  type: Record<Density, Record<string, TypeRole>> & { _note?: string };
  space: { scale: number[] } & Record<Density, Record<string, number>>;
  size: Record<Density, Record<string, number | [number, number]>>;
  radius: Record<Density, Record<string, number>>;
  ring: { inset: number; width: number; radiusRatio: number };
  glow: { size: number; stops: [string, number][] };
  elevation: Record<string, string>;
  motion: { curve: number[]; fast: number; enter: number; pulse: number };
  icon: Record<string, number>;
}

const tokens = JSON.parse(readFileSync(source, "utf8")) as Tokens;

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const px = (n: number): string => `${n}px`;
const line = (name: string, value: string): string =>
  `  --frock-ui-${name}: ${value};`;

const fontStacks: Record<TypeRole["family"], string> = {
  sans: `${tokens.font.sans}, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  display: `"${tokens.font.display}", ${tokens.font.sans}, sans-serif`,
  mono: `"${tokens.font.mono}", ui-monospace, SFMono-Regular, Menlo, monospace`,
};

function palette(colors: Palette): string[] {
  return Object.entries(colors).map(([name, value]) =>
    line(kebab(name), value),
  );
}

function typeRoles(roles: Record<string, TypeRole>): string[] {
  const out: string[] = [];
  for (const [role, t] of Object.entries(roles)) {
    const family = `var(--frock-ui-font-${t.family})`;
    const weight = t.weight ?? (t.family === "display" ? 400 : 400);
    out.push(line(`type-${kebab(role)}-size`, px(t.size)));
    out.push(line(`type-${kebab(role)}-line`, px(t.lineHeight)));
    out.push(line(`type-${kebab(role)}-weight`, String(weight)));
    out.push(line(`type-${kebab(role)}-tracking`, `${t.tracking ?? 0}em`));
    out.push(line(`type-${kebab(role)}-family`, family));
    // The `font` shorthand for the role, so a rule can say
    // `font: var(--frock-ui-type-message)` and be done.
    out.push(
      line(
        `type-${kebab(role)}`,
        `${weight} ${px(t.size)}/${px(t.lineHeight)} ${family}`,
      ),
    );
  }
  return out;
}

function spaces(density: Density): string[] {
  return Object.entries(tokens.space[density]).map(([name, value]) =>
    line(`space-${kebab(name)}`, px(value)),
  );
}

function sizes(density: Density): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(tokens.size[density])) {
    if (Array.isArray(value)) {
      out.push(line(`size-${kebab(name)}-width`, px(value[0])));
      out.push(line(`size-${kebab(name)}-height`, px(value[1])));
    } else {
      out.push(line(`size-${kebab(name)}`, px(value)));
    }
  }
  return out;
}

function radii(density: Density): string[] {
  return Object.entries(tokens.radius[density]).map(([name, value]) =>
    name.endsWith("Ratio")
      ? line(`radius-${kebab(name)}`, String(value))
      : line(`radius-${kebab(name)}`, px(value)),
  );
}

function elevation(): string[] {
  return Object.entries(tokens.elevation).map(([name, value]) =>
    line(
      `elevation-${kebab(name)}`,
      value.replace(/\bhighlight\b/, "var(--frock-ui-highlight)"),
    ),
  );
}

function glow(): string[] {
  const stops = tokens.glow.stops
    .map(([color, at]) =>
      color === "transparent"
        ? `transparent ${Math.round(at * 100)}%`
        : `var(--frock-ui-${kebab(color)}) ${Math.round(at * 100)}%`,
    )
    .join(", ");
  return [
    line("glow-size", px(tokens.glow.size)),
    line("glow", `radial-gradient(circle, ${stops})`),
  ];
}

function motion(): string[] {
  const curve = `cubic-bezier(${tokens.motion.curve.join(", ")})`;
  return [
    line("motion-curve", curve),
    line("motion-fast", `${tokens.motion.fast}ms`),
    line("motion-enter", `${tokens.motion.enter}ms`),
    line("motion-pulse", `${tokens.motion.pulse}ms`),
  ];
}

const spaceScale = tokens.space.scale.map((value, index) =>
  line(`space-${index + 1}`, px(value)),
);

const css = [
  `/* Generated from ${source} by scripts/generate-frock-theme.ts. Do not edit; edit the JSON and run \`bun scripts/generate-frock-theme.ts\`. */`,
  "",
  ":root {",
  "  /* Colour, dark. Tone before line: ground → window → sheet → tile → tile2. */",
  ...palette(tokens.color.dark),
  "",
  "  /* Faces and weights. */",
  line("font-sans", fontStacks.sans),
  line("font-display", fontStacks.display),
  line("font-mono", fontStacks.mono),
  ...Object.entries(tokens.font.weights).map(([name, value]) =>
    line(`weight-${kebab(name)}`, String(value)),
  ),
  "",
  "  /* Type roles, desktop density. Screens use roles, not sizes. */",
  ...typeRoles(tokens.type.desktop),
  "",
  "  /* Space. */",
  ...spaceScale,
  ...spaces("desktop"),
  "",
  "  /* Size, desktop density. */",
  ...sizes("desktop"),
  "",
  "  /* Radius, desktop density. */",
  ...radii("desktop"),
  "",
  "  /* The state ring around a sheep, the glow, elevation, motion, icons. */",
  line("ring-inset", px(tokens.ring.inset)),
  line("ring-width", px(tokens.ring.width)),
  line("ring-radius-ratio", String(tokens.ring.radiusRatio)),
  ...glow(),
  ...elevation(),
  ...motion(),
  ...Object.entries(tokens.icon).map(([name, value]) =>
    line(`icon-${kebab(name)}`, String(value)),
  ),
  "}",
  "",
  "/* The light palette, opt-in: the product ships dark. */",
  ':root[data-theme="light"] {',
  ...palette(tokens.color.light),
  "}",
  "",
  "/* Phone density: touch sizes, the same breakpoint as the shell's one-column layout. */",
  `@media (${phoneBreakpoint}) {`,
  "  :root {",
  ...typeRoles(tokens.type.phone).map((l) => `  ${l}`),
  ...spaces("phone").map((l) => `  ${l}`),
  ...sizes("phone").map((l) => `  ${l}`),
  ...radii("phone").map((l) => `  ${l}`),
  "  }",
  "}",
  "",
  "@media (prefers-reduced-motion: reduce) {",
  "  :root {",
  line("motion-fast", "0ms"),
  line("motion-enter", "0ms"),
  line("motion-pulse", "0ms"),
  "  }",
  "}",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = "";
  }
  if (current !== css) {
    console.error(
      `${target} is stale. Run \`bun scripts/generate-frock-theme.ts\`.`,
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, css);
  console.log(`wrote ${target}`);
}
