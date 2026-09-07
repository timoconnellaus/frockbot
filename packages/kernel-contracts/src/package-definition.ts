// What a first-party Package declares about itself.
//
// First-party code ships with the deploy, so there is nothing to version, no
// compatibility range to satisfy and no Contribution entry to resolve: the app
// imports the code directly. What is left is the data the product needs to
// read *about* a Package — the settings a User may set, the Capabilities and
// Connection Types enablement is expressed in, the durable roots it writes,
// and the Packages it needs enabled beside it. That is this file.
//
// Untrusted code declares itself with a Frock Compose descriptor instead
// (`@frockbot/compose-frockbot/descriptor`), which names only the extension
// points `AGENTS.md` opens.
import type { TurnTypeV1 } from "./types.js";

/**
 * Where one setting's value lives. `connection` is a setting a Connection Type
 * declares, whose value belongs to one Connection.
 */
export type SettingScope = "user" | "bot" | "connection";

export type PackageSettingSchemaType =
  "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type PackageSettingSchemaValue = string | number | boolean | null;

export interface PackageSettingSchema {
  type?: PackageSettingSchemaType;
  title?: string;
  description?: string;
  enum?: PackageSettingSchemaValue[];
  const?: PackageSettingSchemaValue;
  properties?: Record<string, PackageSettingSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PackageSettingSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface PackageSettingDefinition {
  id: string;
  schemaVersion: number;
  scopes: SettingScope[];
  /**
   * A kernel-consumed semantic role. The model role is deliberately generic:
   * it lets a Package opt the User into model choice without teaching the
   * kernel that Package's identity or policy.
   */
  role?: "model";
  schema: PackageSettingSchema;
}

export interface ConnectionTypeDefinition {
  /** A same-origin backend catalog of named variants of this Connection Type. */
  catalogPath?: string;
  id: string;
  displayName: string;
  allowMultiple: boolean;
  authorization: {
    kind: "none" | "api-key" | "ambient-native" | "grant";
    /** Ambient native bindings have no credential or authorization driver. */
    driverId?: string;
  };
  capabilities: string[];
  /**
   * Connection-scoped settings: the configuration one Connection of this type
   * carries beside its credential — an API endpoint root, say. Configuration
   * only: a secret reaches the keyring through the Connection's credential and
   * never through a setting.
   */
  settings?: PackageSettingDefinition[];
}

export interface CapabilityDefinition {
  id: string;
  kind: "tool" | "model" | "memory" | "notification" | "computer";
  connectionTypes: string[];
  /**
   * The ceiling on the turn types this Capability's tools may be admitted
   * onto. Absent means the Package set no bound.
   */
  admission?: { turnTypes: TurnTypeV1[]; subagentRoles?: string[] };
}

/**
 * One durable Workspace root a Package declares for itself.
 *
 * `scope` is `user` and only `user`: `WorkspaceRootV1` names a
 * `package-declared` root by User and Package with no Bot in it, and Package
 * availability is a User-level fact.
 */
export interface PackageRootV1 {
  /** The `rootId`, in the `package-declared` root-id shape. */
  id: string;
  scope: "user";
}

/**
 * A first-party Package, as the product reads it.
 *
 * A Package with none of these fields is still real — the application's list
 * is what says it exists — and declares nothing but its id and display name.
 */
export interface PackageDefinitionV1 {
  id: string;
  displayName: string;
  settings?: readonly PackageSettingDefinition[];
  capabilities?: readonly CapabilityDefinition[];
  connectionTypes?: readonly ConnectionTypeDefinition[];
  /** The seeded installation state. Absent keeps the enabled default. */
  defaultEnablement?: "enabled" | "disabled";
  roots?: readonly PackageRootV1[];
  /**
   * The Packages that must be enabled beside this one. Enabling a Package
   * enables its closure, so a default-disabled Package can be switched on
   * without first repairing invisible dependency rows.
   */
  dependencies?: readonly string[];
  /**
   * Infrastructure the platform keeps available rather than an enablement
   * choice presented to the User: the application root, the Packages with no
   * control to offer, and the ambient zero-configuration model path.
   */
  platformOwned?: boolean;
}

/**
 * A Capability's declared turn-type ceiling, read back out of the definition
 * rather than restated at the registration. A registration that drifts from
 * the definition is narrowed to it, so the two cannot disagree about which
 * turn types admit a tool.
 */
export function packageAdmissionCeilingV1(
  definition: PackageDefinitionV1,
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  return definition.capabilities?.find(
    (capability) => capability.id === capabilityId,
  )?.admission?.turnTypes;
}

/** The same ceiling on the second dimension: which subagent roles see a tool. */
export function packageSubagentRoleCeilingV1(
  definition: PackageDefinitionV1,
  capabilityId: string,
): readonly string[] | undefined {
  return definition.capabilities?.find(
    (capability) => capability.id === capabilityId,
  )?.admission?.subagentRoles;
}
