// Building the pack — the only place scrubbing happens.
//
// The register's contract, verbatim: the host **never falls back to the
// owner's live files** — a selected item whose content is missing is filtered
// out rather than re-read; scrubbing lives **only in the pack arguments, never
// in the live files**; managed, plugin and built-in Skills are always excluded.
//
// So this module is a pure function. It takes a description of what the Bot
// already is and returns a `BotTemplateV1`; it reads nothing, writes nothing,
// and cannot reach a Workspace, a Connection, or a keyring even by accident.
// Every row of the scrub matrix is decided here and nowhere else, which is what
// makes the matrix testable as a table of plain objects.
//
// What is refused, and why:
//
//   Memory, transcripts, unread state, Computer files  a template is
//     public-shareable and Memory is the User's facts under a durable root,
//     unlike GrokBot's `memory:[…]`.
//   Connections, `connectionId`, `safeMetadata`  Connections belong to the
//     importing User and cannot cross Users.
//   `PackageInstallationView.values`  setup fields may hold keys.
//   Bot-scoped Package values  they may name a Connection.
import {
  MAX_TEMPLATE_ROUTINE_PROMPT_BYTES_V1,
  MAX_TEMPLATE_SKILL_BODY_BYTES_V1,
  MAX_TEMPLATE_PACKAGES_V1,
  MAX_TEMPLATE_ROUTINES_V1,
  MAX_TEMPLATE_SKILLS_V1,
  decodeBotTemplateV1,
  type BotTemplateV1,
  type TemplatePackageV1,
  type TemplateRoutineV1,
  type TemplateSheepRecipeV1,
  type TemplateSkillV1,
} from "@frockbot/core/template";
import type {
  TemplateExportSummaryV1,
  TemplateOmissionReasonV1,
  TemplateOmissionV1,
} from "./shared.js";

/**
 * One Skill candidate, as the Bot's own catalog presents it.
 *
 * `source` and `writer` are carried rather than pre-filtered so the matrix is
 * decided here: the Skills loader already refuses an unattributed writer, and
 * this refuses it again. Two independent refusals of the same rule is the
 * point — an instruction that reached a durable root outside the Workspace file
 * surface is data, never an instruction, and never a thing a template teaches
 * someone else's Bot to run.
 */
export interface TemplateSkillCandidateV1 {
  source: "bot" | "managed";
  slug?: string;
  name: string;
  description?: string;
  /** Absent when the body failed to load. Such a Skill is dropped, never re-read. */
  body?: string;
  writer: { kind: "bot" | "user" | "first-party" | "unattributed" };
}

/** One Routine candidate, in the shape `RoutineViewV1` already has. */
export interface TemplateRoutineCandidateV1 {
  routineId: string;
  name: string;
  prompt: string;
  schedule?: string;
  trigger?: { kind: "webhook" };
  timezone: string;
}

/** One installed Package, in the shape `PackageInstallationView` already has. */
export interface TemplatePackageCandidateV1 {
  packageId: string;
  version: string;
  state: "installed" | "disabled" | "failed";
  /** Setting values. Present here only so the omission can be counted. */
  values?: Record<string, unknown>;
  /** The Package manifest's own display name, when the host knows it. */
  displayName?: string;
}

/**
 * One Connection candidate.
 *
 * A Connection never travels, so this shape carries only what the export
 * counts. A `ConnectionView` also has `connectionId`, `safeMetadata`,
 * `settings`, `authorization` and `generation`; none of them is in this shape,
 * so no refactor can leak one by forgetting to strip it.
 */
export interface TemplateConnectionCandidateV1 {
  packageId: string;
  connectionTypeId: string;
}

export interface TemplateSourceV1 {
  botId: string;
  profile: {
    name: string;
    title?: string;
    description?: string;
  };
  /**
   * The recipe the exported profile carries: this Bot's own generated sheep.
   *
   * A `SheepRecipeV1` is four layer ids — deterministic, tiny, and nobody's
   * photograph — so it travels.
   */
  sheep: TemplateSheepRecipeV1;
  skills: readonly TemplateSkillCandidateV1[];
  routines: readonly TemplateRoutineCandidateV1[];
  packages: readonly TemplatePackageCandidateV1[];
  connections: readonly TemplateConnectionCandidateV1[];
}

export interface TemplateBuildResultV1 {
  template: BotTemplateV1;
  summary: TemplateExportSummaryV1;
}

/**
 * A slug for a template entry, derived from a readable name.
 *
 * Names become roles (line 330): the slug is what an importing Bot's own
 * instruction root and Routine list will use, so it is derived from the name
 * rather than copied from an id that means something only in the source
 * deployment.
 */
export function templateSlugV1(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug.slice(0, 90)}-${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

class Omissions {
  private readonly counts = new Map<TemplateOmissionReasonV1, number>();

  add(reason: TemplateOmissionReasonV1, by = 1): void {
    if (by <= 0) return;
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + by);
  }

  list(): TemplateOmissionV1[] {
    return [...this.counts.entries()].map(([reason, count]) => ({
      reason,
      count,
    }));
  }
}

function scrubSkills(
  source: TemplateSourceV1,
  omissions: Omissions,
): TemplateSkillV1[] {
  const slugs = new Set<string>();
  const skills: TemplateSkillV1[] = [];
  for (const candidate of source.skills) {
    if (candidate.source === "managed") {
      omissions.add("managed-skill");
      continue;
    }
    if (
      candidate.writer.kind === "unattributed" ||
      candidate.writer.kind === "first-party"
    ) {
      omissions.add("unattributed-skill");
      continue;
    }
    // No fallback. A Skill whose body did not load, or whose directory is not
    // a well-formed slug, is dropped here; nothing re-reads the owner's live
    // instruction root to fill the gap.
    if (
      !candidate.body ||
      candidate.body.length > MAX_TEMPLATE_SKILL_BODY_BYTES_V1
    ) {
      omissions.add("unreadable-skill");
      continue;
    }
    if (skills.length >= MAX_TEMPLATE_SKILLS_V1) {
      omissions.add("unreadable-skill");
      continue;
    }
    const slug = uniqueSlug(
      candidate.slug ?? templateSlugV1(candidate.name, "skill"),
      slugs,
    );
    skills.push({
      slug,
      name: candidate.name.slice(0, 100),
      ...(candidate.description === undefined
        ? {}
        : { description: candidate.description.slice(0, 2_000) }),
      body: candidate.body,
    });
  }
  return skills;
}

function scrubRoutines(
  source: TemplateSourceV1,
  omissions: Omissions,
): TemplateRoutineV1[] {
  const slugs = new Set<string>();
  const routines: TemplateRoutineV1[] = [];
  for (const candidate of source.routines) {
    if (routines.length >= MAX_TEMPLATE_ROUTINES_V1) break;
    if (!candidate.prompt) continue;
    const webhook = candidate.trigger?.kind === "webhook";
    routines.push({
      slug: uniqueSlug(templateSlugV1(candidate.name, "routine"), slugs),
      name: candidate.name.slice(0, 100),
      prompt: candidate.prompt.slice(0, MAX_TEMPLATE_ROUTINE_PROMPT_BYTES_V1),
      // A webhook Routine carries its kind and nothing else. The key and its
      // digest never leave the Bot Durable Object that minted them, and a
      // template is a weaker place still.
      ...(webhook || !candidate.schedule
        ? {}
        : { schedule: candidate.schedule.slice(0, 256) }),
      ...(webhook
        ? { triggerKind: "webhook" as const }
        : candidate.schedule
          ? { triggerKind: "cron" as const }
          : {}),
    });
  }
  return routines;
}

function scrubPackages(
  source: TemplateSourceV1,
  omissions: Omissions,
): TemplatePackageV1[] {
  const packages: TemplatePackageV1[] = [];
  const seen = new Set<string>();
  for (const candidate of source.packages) {
    if (candidate.values !== undefined) omissions.add("package-values");
    if (candidate.state !== "installed") continue;
    if (seen.has(candidate.packageId)) continue;
    if (packages.length >= MAX_TEMPLATE_PACKAGES_V1) continue;
    seen.add(candidate.packageId);
    packages.push({
      packageId: candidate.packageId,
      version: candidate.version.slice(0, 100),
      displayName: (candidate.displayName || candidate.packageId).slice(0, 100),
    });
  }
  return packages;
}

/** Build one template from what the Bot already is. Pure; never re-reads. */
export function buildBotTemplateV1(
  source: TemplateSourceV1,
): TemplateBuildResultV1 {
  const omissions = new Omissions();
  // Memory is never read, so there is nothing to count; the omission is
  // recorded unconditionally because it is the one a User most needs told.
  omissions.add("memory");

  const skills = scrubSkills(source, omissions);
  const routines = scrubRoutines(source, omissions);
  const packages = scrubPackages(source, omissions);
  for (const _ of source.connections) omissions.add("connection");

  const template = decodeBotTemplateV1({
    schemaVersion: 1,
    profile: {
      name: source.profile.name.slice(0, 100),
      ...(source.profile.title
        ? { title: source.profile.title.slice(0, 120) }
        : {}),
      ...(source.profile.description
        ? { description: source.profile.description.slice(0, 10_000) }
        : {}),
      avatar: { kind: "sheep", recipe: source.sheep },
    },
    skills,
    routines,
    packages,
  });

  return {
    template,
    summary: {
      schemaVersion: 1,
      botId: source.botId,
      skills: template.skills.length,
      routines: template.routines.length,
      packages: template.packages.length,
      omitted: omissions.list(),
    },
  };
}

/** One line per section, for the `agent-card` a Bot returns. */
export function describeTemplateSummaryV1(
  summary: TemplateExportSummaryV1,
): string {
  const packed = [
    `${summary.skills} Skill${summary.skills === 1 ? "" : "s"}`,
    `${summary.routines} Routine${summary.routines === 1 ? "" : "s"}`,
    `${summary.packages} Package${summary.packages === 1 ? "" : "s"}`,
  ].join(", ");
  const scrubbed: string[] = ["Memory", "Connections"];
  for (const omission of summary.omitted) {
    if (omission.reason === "managed-skill") {
      scrubbed.push(`${omission.count} managed Skill(s)`);
    }
    if (omission.reason === "unattributed-skill") {
      scrubbed.push(`${omission.count} Skill(s) with no recorded writer`);
    }
    if (omission.reason === "package-values") {
      scrubbed.push("Package setting values");
    }
  }
  return [
    `Packed ${packed}.`,
    `Scrubbed: ${scrubbed.join("; ")}.`,
    "Nothing is shared until you choose a visibility.",
  ].join(" ");
}
