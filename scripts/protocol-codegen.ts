import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { format } from "prettier";

export const root = resolve(import.meta.dirname, "..");
export interface Schema {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  [key: string]: unknown;
}
export const source = JSON.parse(
  readFileSync(
    resolve(root, "packages/protocol-schemas/schema/client-wire.schema.json"),
    "utf8",
  ),
) as {
  $id: string;
  $defs: Record<string, Schema>;
  "x-frockbot-compatibility": {
    protocolMin: number;
    protocolMax: number;
    minimumNativeVersion: string;
    catalogs: { id: string; digest: string }[];
  };
};
export function tsType(s: Schema): string {
  if (s.$ref) return s.$ref.split("/").at(-1)!;
  if ("const" in s) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.oneOf) return s.oneOf.map((v) => `(${tsType(v)})`).join(" | ");
  if (s.type === "object") {
    const properties = Object.entries(s.properties ?? {})
      .map(
        ([key, value]) =>
          `${JSON.stringify(key)}${s.required?.includes(key) ? "" : "?"}: ${tsType(value)};`,
      )
      .join("\n");
    const additional =
      s.additionalProperties === false
        ? ""
        : `[key: string]: ${typeof s.additionalProperties === "object" ? tsType(s.additionalProperties) : "unknown"};`;
    return `{ ${properties}\n${additional} }`;
  }
  if (s.type === "array") return `Array<${tsType(s.items!)}>`;
  if (s.type === "integer") return "number";
  if (["string", "number", "boolean", "null"].includes(s.type ?? ""))
    return s.type!;
  throw new Error(`Unsupported type generation: ${JSON.stringify(s)}`);
}
export async function output(path: string, content: string, parser?: string) {
  const rendered = parser
    ? await format(content, { parser, printWidth: 80 })
    : content;
  const target = resolve(root, path);
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== rendered)
      throw new Error(`Regenerate ${path}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rendered);
  }
}
