// The Frock catalog's A2UI catalog definition, generated from the Dart.
//
// A2UI's rule is that a catalog is JSON Schema only, known to the agent and
// the client beforehand, and that its implementation is host code (ADR 0030).
// That only holds if the schema the model is taught and the schema the
// renderer draws against are the same schema. So there is exactly one place a
// Frock component's data schema is written — one raw JSON string per family
// under `apps/native/packages/frockbot_client/lib/cards/frock_catalog/schemas/`, beside the Dart that
// builds the `CatalogItem` from it — and this wraps those schemas in the
// catalog definition A2UI describes and writes
// `core/protocol-schemas/schema/frock-catalog.json`.
//
// The families are read in filename order and merged, which is the order
// `schemas.dart` lists them in; a component name two families declare is
// refused here rather than resolved by whichever file happened to be read
// last.
//
// The source is a JSON string inside the Dart rather than Dart map literals
// because this runs under bun in the `typecheck` gate, where Flutter is not
// installed: a string can be lifted and parsed, whereas a Dart literal would
// need a Dart parser here, and a parser is a second opinion about what the
// Dart says. The Dart reads the same string with `jsonDecode`.
//
// `--check` fails when the committed file is stale, which is what the gate
// runs. The standard catalog beside it, `a2ui-basic-catalog.json`, is fetched
// from a2ui.org once and committed; nothing fetches it at build time.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(
  root,
  "apps/native/packages/frockbot_client/lib/cards/frock_catalog/schemas.dart",
);
const familiesDir = resolve(
  root,
  "apps/native/packages/frockbot_client/lib/cards/frock_catalog/schemas",
);
const outputPath = resolve(
  root,
  "core/protocol-schemas/schema/frock-catalog.json",
);

const source = readFileSync(sourcePath, "utf8");

function constant(name: string): string {
  const match = source.match(
    new RegExp(`const ${name} =\\s*\\n?\\s*'([^']*)';`),
  );
  if (!match?.[1]) throw new Error(`${name} is missing from schemas.dart`);
  return match[1];
}

const catalogId = constant("frockCatalogIdV1");
const commonTypesId = constant("a2uiCommonTypesIdV1");

interface ComponentSchema {
  type?: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

const families = readdirSync(familiesDir)
  .filter((name) => name.endsWith(".dart"))
  .sort();
if (families.length === 0) throw new Error("the Frock catalog has no families");

const schemas: Record<string, ComponentSchema> = {};
for (const family of families) {
  const text = readFileSync(resolve(familiesDir, family), "utf8");
  const match = text.match(/= r'''\n([\s\S]*?)\n''';/);
  if (!match?.[1]) {
    throw new Error(`${family} declares no family of component schemas`);
  }
  for (const [name, schema] of Object.entries(
    JSON.parse(match[1]) as Record<string, ComponentSchema>,
  )) {
    if (name in schemas) {
      throw new Error(`two Frock families declare "${name}"`);
    }
    schemas[name] = schema;
  }
}
const names = Object.keys(schemas);
if (names.length === 0) throw new Error("the Frock catalog declares nothing");
for (const [name, schema] of Object.entries(schemas)) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`"${name}" is not an A2UI component name`);
  }
  // `component` and `id` are A2UI's, contributed by the common types below; a
  // catalog that declared either would be saying something the protocol has
  // already said, and the two could disagree.
  for (const reserved of ["component", "id"]) {
    if (schema.properties && reserved in schema.properties) {
      throw new Error(`${name} declares the reserved property "${reserved}"`);
    }
  }
}

// The same shape the standard catalog has, and the same one `genui` builds
// from a `Catalog` at runtime: each component is the common component fields
// plus its own, with its name as the discriminator, and nothing else.
const definition = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: catalogId,
  title: "Frock Catalog",
  description:
    "FrockBot's own A2UI components. Drawn by the host from the app's own " +
    "theme; a Bot or a Plugin composes them, and neither supplies code.",
  catalogId,
  components: Object.fromEntries(
    names.map((name) => {
      const schema = schemas[name]!;
      return [
        name,
        {
          type: "object",
          ...(schema.description ? { description: schema.description } : {}),
          allOf: [
            { $ref: `${commonTypesId}#/$defs/ComponentCommon` },
            { $ref: "#/$defs/CatalogComponentCommon" },
            {
              type: "object",
              properties: {
                component: { const: name },
                ...(schema.properties ?? {}),
              },
              required: ["component", ...(schema.required ?? [])],
            },
          ],
          unevaluatedProperties: false,
        },
      ];
    }),
  ),
  $defs: {
    CatalogComponentCommon: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "A unique identifier for this component instance within the " +
            "surface. This ID is used to refer to the component in layout " +
            "children arrays or event handlers.",
        },
      },
      required: ["id"],
    },
    anyComponent: {
      oneOf: names.map((name) => ({ $ref: `#/components/${name}` })),
      discriminator: { propertyName: "component" },
    },
  },
};

const generated = await format(JSON.stringify(definition), {
  parser: "json",
  filepath: outputPath,
});

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(outputPath, "utf8");
  } catch {
    committed = "";
  }
  if (committed !== generated) {
    console.error(
      `${outputPath} is stale; run \`bun scripts/generate-frock-catalog.ts\``,
    );
    process.exit(1);
  }
  console.log(
    `frock catalog: ${names.length} components match the Dart source of truth`,
  );
} else {
  writeFileSync(outputPath, generated);
  console.log(`wrote ${names.length} components to ${outputPath}`);
}
