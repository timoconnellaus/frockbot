/**
 * The Flock's sheep artwork and layer tree, for the Flutter app.
 *
 * `packages/plugin-flock/assets` is the one source: `manifest.json` names the
 * backgrounds and the three layer trees (upper, middle, lower), and one .webp
 * per layer. The web draws a Bot by stacking those layers in the order
 * `sheepLayerIds` in `packages/plugin-flock/src/shared.ts` decides. This
 * script copies the images into `apps/native/assets/sheep/` and writes the
 * tree as Dart so the app stacks the same layers in the same order.
 *
 *   bun scripts/generate-dart-sheep-layers.ts          # write
 *   bun scripts/generate-dart-sheep-layers.ts --check  # fail if stale
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "packages/plugin-flock/assets";
const assetsTarget = "apps/native/assets/sheep";
const dartTarget = "apps/native/lib/ui/sheep_layers.generated.dart";

interface Node {
  id: string;
  label: string;
  parent: string | null;
  kind: string;
}
interface Manifest {
  canonical: string;
  backgrounds: { id: string; label: string }[];
  trees: Record<"upper" | "middle" | "lower", Node[]>;
}

const manifest = JSON.parse(
  readFileSync(join(source, "manifest.json"), "utf8"),
) as Manifest;
const check = process.argv.includes("--check");
const stale: string[] = [];

function sync(relative: string, content: Buffer | string): void {
  const path = join(assetsTarget, relative);
  let current: Buffer | undefined;
  try {
    current = readFileSync(path);
  } catch {
    current = undefined;
  }
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (current !== undefined && Buffer.compare(current, next) === 0) return;
  if (check) {
    stale.push(path);
    return;
  }
  mkdirSync(assetsTarget, { recursive: true });
  writeFileSync(path, next);
}

for (const file of readdirSync(source).filter((f) => f.endsWith(".webp"))) {
  sync(file, readFileSync(join(source, file)));
}

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;
const lines: string[] = [
  "// Generated from packages/plugin-flock/assets/manifest.json by",
  "// scripts/generate-dart-sheep-layers.ts. Do not edit.",
  "",
  "/// The base sheep every Bot starts from.",
  `const sheepCanonical = ${q(manifest.canonical)};`,
  "",
  "/// Background ids; the image is `background-<id>.webp`.",
  "const sheepBackgrounds = <String>[",
  ...manifest.backgrounds.map((b) => `  ${q(b.id)},`),
  "];",
  "",
  "/// Every layer node's parent. A root (the neutral option of a tree) has",
  "/// no parent and draws nothing; a chosen node draws itself and every",
  "/// ancestor below the root, ancestors first.",
  "const sheepLayerParents = <String, String?>{",
];
for (const tree of ["upper", "middle", "lower"] as const) {
  lines.push(`  // ${tree}`);
  for (const node of manifest.trees[tree]) {
    lines.push(
      `  ${q(node.id)}: ${node.parent === null ? "null" : q(node.parent)},`,
    );
  }
}
lines.push("};", "");
lines.push("/// Readable names for the avatar editor.");
lines.push("const sheepLayerLabels = <String, String>{");
for (const b of manifest.backgrounds) {
  lines.push(`  ${q(`background-${b.id}`)}: ${q(b.label)},`);
}
for (const tree of ["upper", "middle", "lower"] as const) {
  for (const node of manifest.trees[tree]) {
    lines.push(`  ${q(node.id)}: ${q(node.label)},`);
  }
}
lines.push("};", "");
const dart = lines.join("\n");

let currentDart = "";
try {
  currentDart = readFileSync(dartTarget, "utf8");
} catch {
  currentDart = "";
}
if (currentDart !== dart) {
  if (check) stale.push(dartTarget);
  else writeFileSync(dartTarget, dart);
}

if (check && stale.length > 0) {
  console.error(
    `Sheep layers are stale (${stale.length} files). Run \`bun scripts/generate-dart-sheep-layers.ts\`.`,
  );
  for (const path of stale) console.error(`  ${path}`);
  process.exit(1);
}
if (!check) console.log(`wrote ${assetsTarget}/*.webp and ${dartTarget}`);
