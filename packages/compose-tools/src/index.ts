/** Framework-neutral composer tools over a FrockBot Compose client. */

export {
  composerPrompt,
  composerToolNames,
  createComposerTools,
} from "./composer";
export type {
  AnyComposerTool,
  ComposerEntry,
  ComposerOptions,
  ComposerResult,
  ComposerToolDefinition,
} from "./composer";

export { jsonSchemaValidator, schemaOf } from "./json-schema";
export type {
  DescribedValidator,
  JsonSchema,
  JsonSchemaType,
} from "./json-schema";

export { optionsSchema } from "./options";
