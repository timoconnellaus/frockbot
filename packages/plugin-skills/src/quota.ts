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
// disk: how many Skills a root keeps and how large each one may be. Those are
// the limits declared here, and they are checked against what the instruction
// root already holds rather than against a durable counter, so a resumed Turn
// that rewrites the same Skill consumes nothing.
//
// The count limit is per root, not per Bot: a Bot's own instruction root and
// the User-global root its User's Bots share are counted separately, because a
// quota bounds one root's growth and a shared root has a different population
// of writers.
//
// The limits live in the Package, not in the User Durable Object, until the
// durable-root sync of ADR 0013 exists to make "Workspace disk" measurable;
// `docs/plans/slice-2.md` Step 2 records that as the open half.

export interface SkillQuotaConfigV1 {
  schemaVersion: 1;
  /** Most Skills one Bot's own instruction root may hold. */
  maxSkillsPerBot: number;
  /**
   * Most Skills the User-global instruction root may hold.
   *
   * A separate limit rather than a shared one, because the two roots bound
   * different things: the Bot root bounds one Bot's self-modification, and the
   * User root bounds a tier every Bot of that User reads and any one of them
   * can write. Counting them together would let one Bot's authoring exhaust a
   * root the others share, and the refusal would name the wrong root.
   */
  maxSkillsPerUser: number;
  /** Largest single `SKILL.md`, in bytes. */
  maxSkillBytes: number;
}

export const SKILL_QUOTA_DEFAULTS_V1: SkillQuotaConfigV1 = {
  schemaVersion: 1,
  maxSkillsPerBot: 200,
  maxSkillsPerUser: 200,
  maxSkillBytes: 65_536,
};

/** Which root a Skill write lands in, and therefore which count bounds it. */
export type SkillQuotaScopeV1 = "bot" | "user";

/** The Skill-count limit governing one root. */
export function skillCountLimitV1(
  scope: SkillQuotaScopeV1,
  config: SkillQuotaConfigV1 = SKILL_QUOTA_DEFAULTS_V1,
): number {
  return scope === "user" ? config.maxSkillsPerUser : config.maxSkillsPerBot;
}

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
  request: {
    bytes: number;
    existingSkills: number;
    replaces: boolean;
    /** The root being written; the Bot's own when unsaid. */
    scope?: SkillQuotaScopeV1;
  },
  config: SkillQuotaConfigV1 = SKILL_QUOTA_DEFAULTS_V1,
): SkillQuotaOutcomeV1 {
  const scope = request.scope ?? "bot";
  const limit = skillCountLimitV1(scope, config);
  if (request.bytes > config.maxSkillBytes) {
    return {
      status: "refused",
      limitName: "skill-bytes",
      reason: `the Skill is ${request.bytes} bytes; the quota allows ${config.maxSkillBytes}`,
      used: request.bytes,
      limit: config.maxSkillBytes,
    };
  }
  if (!request.replaces && request.existingSkills >= limit) {
    return {
      status: "refused",
      limitName: "skill-count",
      reason:
        scope === "user"
          ? `this User's shared instruction root holds ${request.existingSkills} Skills; the quota allows ${limit}`
          : `this Bot holds ${request.existingSkills} Skills; the quota allows ${limit}`,
      used: request.existingSkills,
      limit,
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
  const keys = [
    "schemaVersion",
    "maxSkillsPerBot",
    "maxSkillsPerUser",
    "maxSkillBytes",
  ];
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
    maxSkillsPerUser: bounded("maxSkillsPerUser", 10_000),
    maxSkillBytes: bounded("maxSkillBytes", 1_048_576),
  };
}
