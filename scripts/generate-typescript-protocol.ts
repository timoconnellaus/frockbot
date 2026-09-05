import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { source, root, tsType, output } from "./protocol-codegen.ts";

const banner = "// Generated from client-wire.schema.json. Do not edit.\n";
const ajv = new Ajv2020({
  code: { source: true },
  strict: true,
  inlineRefs: false,
});
ajv.addKeyword("x-frockbot-compatibility");
ajv.addSchema(source);
const names = Object.keys(source.$defs);
const refs = Object.fromEntries(
  names.map((name) => [`is${name}`, `${source.$id}#/$defs/${name}`]),
);
const compiled = standaloneCode(ajv, refs);
const bundled = await build({
  stdin: { contents: compiled, resolveDir: root, sourcefile: "protocol.cjs" },
  bundle: true,
  write: false,
  platform: "neutral",
  format: "esm",
  minify: true,
});
// The generated module is a default-exported table of standalone predicates;
// no schema compiler, eval, network or runtime dependency reaches a Worker.
await output(
  "packages/protocol-schemas/src/validators.generated.js",
  banner + bundled.outputFiles[0]!.text,
);
await output(
  "packages/protocol-schemas/src/types.generated.ts",
  banner +
    names
      .map((name) => `export type ${name} = ${tsType(source.$defs[name]!)};`)
      .join("\n") +
    `\nexport interface ProtocolTypes { ${names.map((n) => `${n}: ${n};`).join("\n")} }\n`,
  "typescript",
);
await output(
  "packages/protocol-schemas/src/validators.generated.d.ts",
  banner +
    `import type { ProtocolTypes } from './types.generated.js';\ndeclare const validators: { ${names.map((n) => `is${n}(value: unknown): value is ProtocolTypes[${JSON.stringify(n)}];`).join("\n")} };\nexport default validators;\n`,
  "typescript",
);
await output(
  "packages/protocol-schemas/src/compatibility.generated.ts",
  banner +
    `export const CLIENT_COMPATIBILITY = ${JSON.stringify({ schemaVersion: 1, ...source["x-frockbot-compatibility"] })} as const;\nexport const SUPPORTED_PROTOCOL_MIN = CLIENT_COMPATIBILITY.protocolMin;\nexport const SUPPORTED_PROTOCOL_MAX = CLIENT_COMPATIBILITY.protocolMax;\nexport const MINIMUM_NATIVE_VERSION = CLIENT_COMPATIBILITY.minimumNativeVersion;\n`,
  "typescript",
);
