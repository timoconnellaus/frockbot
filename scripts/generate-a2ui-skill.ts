// The `managed/a2ui` Skill's references, generated from the catalogs the
// client actually draws.
//
// ADR 0030 makes a catalog JSON Schema only, "known to the agent and client
// beforehand", and the whole safety argument rests on the model and the
// renderer meaning the same thing by a component name. A hand-written
// reference is a second opinion about that: it drifts the first time a
// property is added to `schemas.dart` or the standard catalog is refreshed,
// and a Bot taught a property the renderer does not have writes cards that are
// refused. So the per-component tables and their minimal examples are
// *derived* from `core/protocol-schemas/schema/a2ui-basic-catalog.json` and
// `frock-catalog.json` — the same two files `apps/native/lib/cards/catalog.dart`
// registers as one catalog — and the prose around them lives in
// `app/cards/skills/a2ui/templates/`, which this stitches.
//
// Marker syntax in a template, each on its own line:
//
//   <!-- components: Row, Column, List -->   the per-component sections
//   <!-- functions: required, regex -->      the per-function sections
//
// A component named by no template, or named by two, fails the build: the
// point of generating is that the catalog is covered exactly once.
//
// `--check` fails when the committed references are stale, which is what
// `bun run typecheck` runs. `scripts/build-applets-assets.ts` then copies the
// whole directory into `app/skills/managed-a2ui.generated.ts`, so a stale
// reference is caught twice — once here, and once as a stale managed module.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";
import { SKILL_MAX_FILE_BYTES } from "../app/skills/skill-md.ts";

const root = resolve(import.meta.dirname, "..");
const skill = resolve(root, "app/cards/skills/a2ui");
const templates = resolve(skill, "templates");
const references = resolve(skill, "references");

const catalogs = {
  basic: resolve(root, "core/protocol-schemas/schema/a2ui-basic-catalog.json"),
  frock: resolve(root, "core/protocol-schemas/schema/frock-catalog.json"),
};

interface JsonSchema {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

interface CatalogFile {
  components: Record<string, JsonSchema>;
  functions?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
}

function readCatalog(path: string): CatalogFile {
  return JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
}

/**
 * A component entry as the catalogs write it: the common fields by `$ref`, and
 * one `allOf` member carrying its own `properties` and `required`.
 */
function ownSchema(schema: JsonSchema): JsonSchema {
  return schema.allOf?.find((member) => member.properties) ?? schema;
}

/** The `$defs` name a common-types `$ref` points at, or undefined. */
function refName(schema: JsonSchema): string | undefined {
  const ref = schema.$ref ?? schema.allOf?.find((member) => member.$ref)?.$ref;
  return ref?.split("/").pop();
}

/**
 * How a property is written, in one phrase. Chosen to be read by a model
 * composing JSON, so a `$defs` name is kept — `DynamicString` says "literal or
 * binding" once the template has explained the word — and anything else is
 * spelled out in JSON's own vocabulary.
 */
const ENUM_INLINE_MAX = 8;

/** Enumerations too long for a table cell, listed under it instead. */
function longEnums(schema: JsonSchema): unknown[] | undefined {
  const direct = schema.enum;
  if (direct && direct.length > ENUM_INLINE_MAX) return direct;
  for (const member of schema.oneOf ?? []) {
    const found = longEnums(member);
    if (found) return found;
  }
  return undefined;
}

function typeLabel(schema: JsonSchema): string {
  const named = refName(schema);
  if (named) return named;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) {
    if (schema.enum.length > ENUM_INLINE_MAX) return "string (listed below)";
    return schema.enum.map((value) => `\`${value}\``).join(" \\| ");
  }
  if (schema.oneOf) {
    const inner = schema.oneOf
      .map((member) => typeLabel(member))
      .filter((label, index, all) => all.indexOf(label) === index);
    return inner.join(" \\| ");
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") {
    return schema.items ? `array of ${typeLabel(schema.items)}` : "array";
  }
  if (type === "object" && schema.properties) {
    const fields = Object.entries(schema.properties).map(
      ([name, member]) =>
        `${name}${schema.required?.includes(name) ? "" : "?"}: ${typeLabel(member)}`,
    );
    return `{ ${fields.join(", ")} }`;
  }
  return type ?? "any";
}

/** Whether a property takes a data-model binding, and what that costs to say. */
const BINDABLE = new Set([
  "DynamicString",
  "DynamicNumber",
  "DynamicBoolean",
  "DynamicStringList",
  "DynamicValue",
]);

function bindingNote(schema: JsonSchema): string {
  const named = refName(schema);
  if (named && BINDABLE.has(named)) return "bindable";
  if (named === "ComponentId") return "another component's `id`";
  if (named === "ChildList") return "ids, or a template";
  if (named === "Action") return "`{ event: { name, context } }`";
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array" && schema.items?.properties) {
    const bindable = Object.values(schema.items.properties).some((member) =>
      BINDABLE.has(refName(member) ?? ""),
    );
    if (bindable) return "literal rows; values bindable";
  }
  return "literal";
}

/** One sentence, on one Markdown table line. */
function describe(schema: JsonSchema): string {
  const text = (schema.description ?? "").replace(/\s+/g, " ").trim();
  const said = text.length > 260 ? `${text.slice(0, 257)}…` : text;
  const suffix =
    schema.default === undefined
      ? ""
      : ` Defaults to \`${JSON.stringify(schema.default)}\`.`;
  return `${said}${suffix}`.replaceAll("|", "\\|").trim();
}

/**
 * A placeholder value for a required property, so every example is a surface
 * the seam would actually accept. Derived rather than written, for the reason
 * the tables are.
 */
function exampleValue(name: string, schema: JsonSchema): unknown {
  const named = refName(schema);
  if (named === "ComponentId") return `\${${name}}`;
  if (named === "ChildList") return [`\${${name}}`];
  if (named === "Action") return { event: { name: "confirm" } };
  if (named === "DynamicString") return `\${${name}}`;
  if (named === "DynamicNumber") return 0;
  if (named === "DynamicBoolean") return false;
  if (named === "DynamicStringList") return [];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) {
    const literal = schema.oneOf.find(
      (member) => member.enum ?? member.type === "string",
    );
    return exampleValue(name, literal ?? schema.oneOf[0]!);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") {
    return schema.items ? [exampleValue(name, schema.items)] : [];
  }
  if (type === "object") {
    const fields: Record<string, unknown> = {};
    for (const field of schema.required ?? []) {
      const member = schema.properties?.[field];
      if (member) fields[field] = exampleValue(field, member);
    }
    return fields;
  }
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return true;
  return `\${${name}}`;
}

/** The example placeholders read as prose rather than as `${…}`. */
function readable(value: unknown): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\$\{(.+)\}$/);
    return match ? `…${match[1]}…` : value;
  }
  if (Array.isArray(value)) return value.map(readable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, readable(member)]),
    );
  }
  return value;
}

function componentSection(
  name: string,
  schema: JsonSchema,
  common: JsonSchema,
): string {
  const own = ownSchema(schema);
  const required = new Set(own.required ?? []);
  const lines: string[] = [];
  const summary = (schema.description ?? own.description ?? "")
    .replace(/\s+/g, " ")
    .trim();
  lines.push(`### \`${name}\``);
  lines.push("");
  if (summary) {
    lines.push(summary);
    lines.push("");
  }
  lines.push("| Property | Type | Required | Binding | What it is |");
  lines.push("| --- | --- | --- | --- | --- |");
  const example: Record<string, unknown> = { id: "root", component: name };
  const enumerations: string[] = [];
  for (const [property, member] of Object.entries(own.properties ?? {})) {
    if (property === "component") continue;
    const values = longEnums(member);
    if (values) {
      enumerations.push(
        `\`${property}\` is one of: ${values.map((value) => `\`${value}\``).join(", ")}.`,
      );
    }
    const need = required.has(property);
    lines.push(
      `| \`${property}\` | ${typeLabel(member)} | ${need ? "yes" : "no"} | ${bindingNote(member)} | ${describe(member)} |`,
    );
    if (need) example[property] = exampleValue(property, member);
  }
  // `weight` is common to a catalog, not to a component, and only the basic
  // catalog declares it: a Frock component is `unevaluatedProperties: false`
  // and would be refused carrying one. The renderer reads it with `as int?`
  // (genui `basic_catalog_widgets/row.dart`), so a fractional weight throws
  // while the child is built — the table says `integer` for that reason.
  if (common.properties?.weight) {
    lines.push(
      `| \`weight\` | integer | no | literal | Its share of a \`Row\` or \`Column\`, like CSS \`flex-grow\`. Only on a direct child of one. |`,
    );
  }
  // `Checkable` is contributed by `$ref`, not by the component's own
  // properties, so the row is emitted from the reference rather than skipped:
  // a Bot reading this table would otherwise never learn `checks` exists.
  if (
    (schema.allOf ?? []).some((member) => member.$ref?.includes("Checkable"))
  ) {
    lines.push(
      `| \`checks\` | array of { condition: DynamicBoolean, message: string } | no | conditions bindable | Client-side validation. Each condition is a boolean function call; the message shows when it is false. |`,
    );
  }
  lines.push("");
  for (const enumeration of enumerations) {
    lines.push(enumeration);
    lines.push("");
  }
  lines.push("```json");
  lines.push(JSON.stringify(readable(example), null, 2));
  lines.push("```");
  return lines.join("\n");
}

function functionSection(name: string, schema: JsonSchema): string {
  const args = schema.properties?.args;
  const returns = schema.properties?.returnType?.const ?? "boolean";
  const lines: string[] = [];
  lines.push(`### \`${name}\``);
  lines.push("");
  const summary = (schema.description ?? "").replace(/\s+/g, " ").trim();
  if (summary) {
    lines.push(`${summary} Returns \`${returns}\`.`);
    lines.push("");
  }
  lines.push("| Argument | Type | Required | What it is |");
  lines.push("| --- | --- | --- | --- |");
  const required = new Set(args?.required ?? []);
  const call: Record<string, unknown> = { call: name, args: {} };
  for (const [argument, member] of Object.entries(args?.properties ?? {})) {
    lines.push(
      `| \`${argument}\` | ${typeLabel(member)} | ${required.has(argument) ? "yes" : "no"} | ${describe(member)} |`,
    );
    if (required.has(argument)) {
      (call.args as Record<string, unknown>)[argument] = exampleValue(
        argument,
        member,
      );
    }
  }
  if (Object.keys(args?.properties ?? {}).length === 0) {
    lines.push("| — | — | — | Takes no arguments. |");
  }
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(readable(call), null, 2));
  lines.push("```");
  return lines.join("\n");
}

const MARKER = /^<!--\s*(components|functions):\s*(.+?)\s*-->$/;

async function build(): Promise<Map<string, string>> {
  const basic = readCatalog(catalogs.basic);
  const frock = readCatalog(catalogs.frock);
  // One vocabulary, because the client registers one catalog: the standard
  // eighteen under the Frock id with the standard id as an alias. A Bot writes
  // component names, and every name either catalog declares is in this set.
  const components = { ...basic.components, ...frock.components };
  const functions = basic.functions ?? {};
  // Which catalog declared a component, remembered as that catalog's common
  // properties, because those are the rows the component carries beyond its
  // own and the two catalogs do not declare the same ones.
  const commons: Record<string, JsonSchema> = {};
  for (const catalog of [basic, frock]) {
    const common = catalog.$defs?.CatalogComponentCommon ?? {};
    for (const entry of Object.keys(catalog.components)) commons[entry] = common;
  }

  const names = readdirSync(templates)
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (names.length === 0) throw new Error("no templates to stitch");

  const covered = {
    components: new Set<string>(),
    functions: new Set<string>(),
  };
  const built = new Map<string, string>();
  for (const name of names) {
    const template = readFileSync(resolve(templates, name), "utf8");
    const out: string[] = [];
    for (const line of template.split("\n")) {
      const marker = line.match(MARKER);
      if (!marker) {
        out.push(line);
        continue;
      }
      const kind = marker[1] as "components" | "functions";
      const source = kind === "components" ? components : functions;
      const sections: string[] = [];
      for (const entry of marker[2]!.split(",").map((part) => part.trim())) {
        const schema = source[entry];
        if (!schema) {
          throw new Error(
            `${name} names "${entry}", which no catalog declares`,
          );
        }
        if (covered[kind].has(entry)) {
          throw new Error(`"${entry}" is documented by two references`);
        }
        covered[kind].add(entry);
        sections.push(
          kind === "components"
            ? componentSection(entry, schema, commons[entry] ?? {})
            : functionSection(entry, schema),
        );
      }
      out.push(sections.join("\n\n"));
    }
    built.set(
      name,
      await format(out.join("\n"), { parser: "markdown", filepath: name }),
    );
  }

  for (const [kind, source] of [
    ["components", components],
    ["functions", functions],
  ] as const) {
    for (const entry of Object.keys(source)) {
      if (!covered[kind].has(entry)) {
        throw new Error(
          `no reference documents the ${kind.slice(0, -1)} "${entry}"`,
        );
      }
    }
  }

  for (const [name, text] of built) {
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > SKILL_MAX_FILE_BYTES) {
      throw new Error(
        `${name} is ${bytes} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
      );
    }
  }

  // The index in `SKILL.md` is a convention of the body, not frontmatter the
  // loader reads (ADR 0030), so nothing but this notices when it stops
  // matching what the Skill actually offers.
  const body = readFileSync(resolve(skill, "SKILL.md"), "utf8");
  for (const name of built.keys()) {
    if (!body.includes(`\`${name}\``)) {
      throw new Error(`SKILL.md's index does not list ${name}`);
    }
  }
  return built;
}

const built = await build();

if (process.argv.includes("--check")) {
  const committed = new Set(
    readdirSync(references).filter((name) => name.endsWith(".md")),
  );
  for (const name of committed) {
    if (!built.has(name)) {
      console.error(`${name} is not built from a template; delete it.`);
      process.exit(1);
    }
  }
  for (const [name, text] of built) {
    const current = committed.has(name)
      ? readFileSync(resolve(references, name), "utf8")
      : "";
    if (current !== text) {
      console.error(
        `app/cards/skills/a2ui/references/${name} is stale; run \`bun scripts/generate-a2ui-skill.ts\`.`,
      );
      process.exit(1);
    }
  }
  console.log(`a2ui Skill: ${built.size} references match the catalogs.`);
} else {
  for (const [name, text] of built) {
    writeFileSync(resolve(references, name), text);
  }
  console.log(`wrote ${built.size} references to ${references}`);
}
