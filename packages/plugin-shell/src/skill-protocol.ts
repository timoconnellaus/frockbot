// The Skill catalog the composer's `/` and `@` popover reads.
//
// The Bot already loads its catalog once per admitted Turn and records it in
// `skill/injected`, but a composer needs the list *before* the Turn exists, so
// this is a read of the same loader over the same instruction root, projected
// as a DTO. It carries a name, a description and a ref — never a body. A body
// reaches the model only by invocation or `skill_load`, so the client can show
// what a Skill is for without ever holding what it says.
//
// The hosted client renders backend state and submits commands. It does not
// become an alternate authority: nothing here is writable, and an entry's
// `ref` is the only part a turn command may echo back.
import {
  decodeSkillRefV1,
  formatSkillRefV1,
  type SkillRefV1,
} from "@frockbot/kernel-contracts";

const MAX_CATALOG_ENTRIES = 200;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_PATH_LENGTH = 512;

/** One invocable Skill, as a client sees it. */
export interface ClientSkillCatalogEntryV1 {
  /** The canonical string form, for display and for stable list keys. */
  ref: string;
  /** The structured ref a turn command carries. */
  skill: SkillRefV1;
  name: string;
  description: string;
  /** Where the Skill lives, so a User can tell two same-named ones apart. */
  path: string;
}

export interface ClientSkillCatalogV1 {
  schemaVersion: 1;
  skills: ClientSkillCatalogEntryV1[];
}

/** Builds one entry from a loaded Skill and the ref that names it. */
export function clientSkillCatalogEntryV1(input: {
  skill: SkillRefV1;
  name: string;
  description: string;
  path: string;
}): ClientSkillCatalogEntryV1 {
  return {
    ref: formatSkillRefV1(input.skill),
    skill: input.skill,
    name: input.name.slice(0, MAX_NAME_LENGTH),
    description: input.description.slice(0, MAX_DESCRIPTION_LENGTH),
    path: input.path.slice(0, MAX_PATH_LENGTH),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

/** The strict decoder for the catalog crossing the client seam. */
export function decodeClientSkillCatalogV1(
  input: unknown,
): ClientSkillCatalogV1 {
  const catalog = record(input, "skill catalog");
  const allowed = new Set(["schemaVersion", "skills"]);
  for (const key of Object.keys(catalog)) {
    if (!allowed.has(key))
      throw new Error(`skill catalog.${key} is not allowed`);
  }
  if (catalog.schemaVersion !== 1) {
    throw new Error("skill catalog.schemaVersion is invalid");
  }
  if (!Array.isArray(catalog.skills)) {
    throw new Error("skill catalog.skills must be an array");
  }
  if (catalog.skills.length > MAX_CATALOG_ENTRIES) {
    throw new Error("skill catalog.skills is too long");
  }
  const skills = catalog.skills.map((value, index) => {
    const label = `skill catalog.skills[${index}]`;
    const entry = record(value, label);
    const keys = new Set(["ref", "skill", "name", "description", "path"]);
    for (const key of Object.keys(entry)) {
      if (!keys.has(key)) throw new Error(`${label}.${key} is not allowed`);
    }
    const skill = decodeSkillRefV1(entry.skill, `${label}.skill`);
    const ref = boundedString(entry.ref, 256, `${label}.ref`);
    if (ref !== formatSkillRefV1(skill)) {
      // The two forms are one fact. A projection whose halves disagree is a
      // refusal, not a value the popover renders under the wrong name.
      throw new Error(`${label}.ref does not match its skill`);
    }
    return {
      ref,
      skill,
      name: boundedString(entry.name, MAX_NAME_LENGTH, `${label}.name`),
      description: boundedString(
        entry.description,
        MAX_DESCRIPTION_LENGTH,
        `${label}.description`,
      ),
      path: boundedString(entry.path, MAX_PATH_LENGTH, `${label}.path`),
    } satisfies ClientSkillCatalogEntryV1;
  });
  return { schemaVersion: 1, skills };
}
