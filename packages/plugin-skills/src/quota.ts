// The bounded per-User Skill quota.
//
// "Generation creation rate, artifact size, retained generations, Workspace
// disk ... are bounded by durable per-User quotas; exceeding a quota refuses
// the operation and records a visible failure."
//
// `plugin-authoring`'s `AuthoringQuotaConfigV1` does not fit: its three limits
// are a Package's source size, a Bot's retained *Composition* generations, and
// a daily authored-generation rate reserved in the User Durable Object against
// an authoring `effectId`. A Skill produces no Composition generation and no
// artifact, so two of the three limits have no meaning here, and reserving a
// daily unit for an edit to a Markdown file would refuse the Bot's own
// instruction root for the rest of the day. What bounds a Skill is Workspace
// disk: how many Skills a Bot keeps and how large each one may be. Those are
// the two limits declared here, and they are checked against what the
// instruction root already holds rather than against a durable counter, so a
// resumed Turn that rewrites the same Skill consumes nothing.
//
// The limits live in the Package, not in the User Durable Object, until the
// durable-root sync of ADR 0013 exists to make "Workspace disk" measurable;
// `docs/plans/slice-2.md` Step 2 records that as the open half.

export interface SkillQuotaConfigV1 {
  schemaVersion: 1;
  /** Most Skills one Bot's instruction root may hold. */
  maxSkillsPerBot: number;
  /** Largest single `SKILL.md`, in bytes. */
  maxSkillBytes: number;
}

export const SKILL_QUOTA_DEFAULTS_V1: SkillQuotaConfigV1 = {
  schemaVersion: 1,
  maxSkillsPerBot: 200,
  maxSkillBytes: 65_536,
};

export type SkillQuotaLimitV1 = "skill-count" | "skill-bytes";

export type SkillQuotaOutcomeV1 =
  | { status: "within" }
  | {
      status: "refused";
      limitName: SkillQuotaLimitV1;
      reason: string;
      used: number;
      limit: number;
    };

/**
 * Checks one Skill write against the quota. Never throws for a breach: a quota
 * breach is an observable outcome the tool result reports.
 *
 * `existingSkills` counts the Skills already under the root, and `replaces`
 * says whether this write supersedes one of them — superseding a Skill does
 * not grow the root, so it is admitted at the limit.
 */
export function checkSkillQuotaV1(
  request: { bytes: number; existingSkills: number; replaces: boolean },
  config: SkillQuotaConfigV1 = SKILL_QUOTA_DEFAULTS_V1,
): SkillQuotaOutcomeV1 {
  if (request.bytes > config.maxSkillBytes) {
    return {
      status: "refused",
      limitName: "skill-bytes",
      reason: `the Skill is ${request.bytes} bytes; the quota allows ${config.maxSkillBytes}`,
      used: request.bytes,
      limit: config.maxSkillBytes,
    };
  }
  if (!request.replaces && request.existingSkills >= config.maxSkillsPerBot) {
    return {
      status: "refused",
      limitName: "skill-count",
      reason: `this Bot holds ${request.existingSkills} Skills; the quota allows ${config.maxSkillsPerBot}`,
      used: request.existingSkills,
      limit: config.maxSkillsPerBot,
    };
  }
  return { status: "within" };
}

export function decodeSkillQuotaConfigV1(
  input: unknown,
  label = "skill quota configuration",
): SkillQuotaConfigV1 {
  if (input === undefined) return { ...SKILL_QUOTA_DEFAULTS_V1 };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const keys = ["schemaVersion", "maxSkillsPerBot", "maxSkillBytes"];
  if (
    value.schemaVersion !== 1 ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} is invalid`);
  }
  const bounded = (name: string, maximum: number): number => {
    const candidate = value[name];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < 1 ||
      (candidate as number) > maximum
    ) {
      throw new Error(`${label}.${name} is out of range`);
    }
    return candidate as number;
  };
  return {
    schemaVersion: 1,
    maxSkillsPerBot: bounded("maxSkillsPerBot", 10_000),
    maxSkillBytes: bounded("maxSkillBytes", 1_048_576),
  };
}
