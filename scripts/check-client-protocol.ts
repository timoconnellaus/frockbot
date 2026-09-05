import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generators = [
  "generate-typescript-protocol.ts",
  "generate-dart-protocol.ts",
];
const results = await Promise.all(
  generators.map(async (generator) => {
    const process = Bun.spawn(["bun", `scripts/${generator}`, "--check"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { generator, code, output: stdout + stderr };
  }),
);
for (const result of results) {
  if (result.code) {
    console.error(result.output);
    throw new Error(`${result.generator} is stale`);
  }
}
const artifact = readFileSync(
  resolve(root, "packages/protocol-schemas/src/validators.generated.js"),
  "utf8",
);
if (/\beval\s*\(|new Function\s*\(|\bfetch\s*\(/.test(artifact))
  throw new Error(
    "Protocol validators must be standalone and require no runtime compilation or network",
  );
console.log(
  "client protocol: TypeScript and Dart generation match the schema; validators are standalone",
);
