// Building the pack — the only place scrubbing happens.
//
// The register's contract, verbatim (`docs/research/grokbot-computer.md` line
// 326-328): the host **never falls back to the owner's live files** — a
// selected item whose content is missing is filtered out rather than re-read;
// scrubbing lives **only in the pack arguments, never in the live files**;
// managed, plugin and built-in Skills are always excluded.
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
//     public-shareable and Memory is the User's facts under a durable root
//     (ADR 0015 records the divergence from GrokBot's `memory:[…]`).
//   Connections, `connectionId`, `safeMetadata`  Connections belong to the
//     importing User and cannot cross Users.
//   `PackageInstallationView.values`  setup fields may hold keys.
//   Bot-scoped Package values  they may name a Connection.
import {
  MAX_TEMPLATE_ROUTINE_PROMPT_BYTES_V1,
  MAX_TEMPLATE_SKILL_BODY_BYTES_V1,
  MAX_TEMPLATE_PACKAGES_V1,
  MAX_TEMPLATE_ROUTINES_V1,
  MAX_TEMPLATE_SERVERS_V1,
  MAX_TEMPLATE_SKILLS_V1,
  decodeBotTemplateV1,
  type BotTemplateV1,
  type TemplateMcpServerV1,
  type TemplatePackageV1,
  type TemplateRoutineV1,
  type TemplateSheepRecipeV1,
  type TemplateSkillV1,
} from "@frockbot/template-core";
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
  source: "bot" | "managed" | "plugin";
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
  catalogId?: string;
  catalogGeneration?: string;
  provenance?: "first-party" | "catalog";
  /** Setup values. Present here only so the omission can be counted. */
  values?: Record<string, unknown>;
  /** The Catalog's own display name, when the pinned generation still has it. */
  displayName?: string;
}

/**
 * One Connection candidate.
 *
 * `settings` is the only field carried, and only `url` and `transport` are ever
 * read out of it. A `ConnectionView` also has `connectionId`, `safeMetadata`,
 * `authorization` and `generation`; none of them is in this shape, so no
 * refactor can leak one by forgetting to strip it.
 */
export interface TemplateConnectionCandidateV1 {
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  state: string;
  /** Whether this Connection Type needs a credential the importer must supply. */
  keyed: boolean;
  settings?: { url?: unknown; transport?: unknown };
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
   * photograph — so it travels (ADR 0015, D1).
   */
  sheep: TemplateSheepRecipeV1;
  skills: readonly TemplateSkillCandidateV1[];
  routines: readonly TemplateRoutineCandidateV1[];
  packages: readonly TemplatePackageCandidateV1[];
  connections: readonly TemplateConnectionCandidateV1[];
  sourceCatalogGeneration?: string;
}

export interface TemplateBuildResultV1 {
  template: BotTemplateV1;
  summary: TemplateExportSummaryV1;
}

/**
 * A private-network or non-https URL never reaches a template.
 *
 * `plugin-mcp/src/ssrf.ts` refuses one on the way *out* of the deployment. A
 * template travels further than that: it is handed to another User, whose
 * deployment would be the one making the request. So the same classifier runs
 * here, and a server that fails it is exported as a placeholder with no URL at
 * all rather than as a public server someone else's Bot would dial.
 */
const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

function isIpv4Literal(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return undefined;
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const inner =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!inner.includes(":")) return false;
  if (inner === "::" || inner === "::1") return true;
  if (/^f[cd]/.test(inner) || /^fe[89ab]/.test(inner)) return true;
  const mapped = inner.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) {
    const octets = isIpv4Literal(mapped[1]);
    return octets ? isPrivateIpv4(octets) : true;
  }
  return false;
}

/** The shareable form of a server URL, or `undefined` when it must not travel. */
export function shareableServerUrlV1(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    return undefined;
  }
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) return undefined;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return undefined;
  }
  const octets = isIpv4Literal(host);
  if (octets && isPrivateIpv4(octets)) return undefined;
  if (isPrivateIpv6(host)) return undefined;
  return value;
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
    if (candidate.source === "plugin") {
      omissions.add("plugin-skill");
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

function scrubRoutines(source: TemplateSourceV1): TemplateRoutineV1[] {
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
      timezone: candidate.timezone.slice(0, 64) || "UTC",
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
    if (
      candidate.provenance === "first-party" ||
      candidate.provenance === undefined ||
      !candidate.catalogId
    ) {
      // Nothing to install: a first-party Package is compiled into whatever
      // application the importer is running, so a reference would be noise.
      omissions.add("first-party-package");
      continue;
    }
    if (seen.has(candidate.catalogId)) continue;
    if (packages.length >= MAX_TEMPLATE_PACKAGES_V1) continue;
    seen.add(candidate.catalogId);
    packages.push({
      packageId: candidate.packageId,
      catalogId: candidate.catalogId,
      version: candidate.version.slice(0, 100),
      displayName: (candidate.displayName || candidate.packageId).slice(0, 100),
    });
  }
  return packages;
}

function scrubServers(
  source: TemplateSourceV1,
  omissions: Omissions,
): TemplateMcpServerV1[] {
  const servers: TemplateMcpServerV1[] = [];
  for (const candidate of source.connections) {
    // Every Connection is omitted as a Connection: what may travel is a
    // *description* of the server it points at, never the Connection itself.
    omissions.add("connection");
    if (servers.length >= MAX_TEMPLATE_SERVERS_V1) continue;
    if (candidate.state !== "ready") continue;
    // What may travel is a description of a *server*, and a Connection is one
    // only when it names an endpoint. A model account, a provider grant, or
    // any other Connection has nothing a recipe could describe, so it is
    // omitted as a Connection and nothing else — rather than becoming a
    // placeholder telling the importer to connect something that is not a
    // server at all.
    if (candidate.settings?.url === undefined) continue;
    const url = shareableServerUrlV1(candidate.settings.url);
    if (candidate.keyed) {
      if (url === undefined) omissions.add("private-network-server");
      // A keyed server is always a placeholder: the importer supplies their own
      // key, and the URL is not carried at all, so a custom server behind a
      // private network cannot be pointed at from someone else's deployment.
      servers.push({
        kind: "needs-connection",
        name: candidate.displayName.slice(0, 100),
        connectionTypeId: candidate.connectionTypeId,
        hint: "This server needs your own Connection and credential.",
      });
      continue;
    }
    if (url === undefined) {
      omissions.add("private-network-server");
      servers.push({
        kind: "needs-connection",
        name: candidate.displayName.slice(0, 100),
        connectionTypeId: candidate.connectionTypeId,
        hint: "This server's address is not reachable from another deployment.",
      });
      continue;
    }
    const transport =
      candidate.settings?.transport === "sse" ? "sse" : "streamable-http";
    servers.push({
      kind: "public",
      name: candidate.displayName.slice(0, 100),
      url,
      transport,
    });
  }
  return servers;
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
  const routines = scrubRoutines(source);
  const packages = scrubPackages(source, omissions);
  const mcpServers = scrubServers(source, omissions);

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
    mcpServers,
    ...(source.sourceCatalogGeneration
      ? { sourceCatalogGeneration: source.sourceCatalogGeneration }
      : {}),
  });

  return {
    template,
    summary: {
      schemaVersion: 1,
      botId: source.botId,
      skills: template.skills.length,
      routines: template.routines.length,
      packages: template.packages.length,
      publicServers: template.mcpServers.filter(
        (server) => server.kind === "public",
      ).length,
      needsConnection: template.mcpServers.filter(
        (server) => server.kind === "needs-connection",
      ).length,
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
    `${summary.publicServers} public MCP server${summary.publicServers === 1 ? "" : "s"}`,
  ].join(", ");
  const scrubbed: string[] = ["Memory", "Connections"];
  if (summary.needsConnection > 0) {
    scrubbed.push(
      `${summary.needsConnection} server${summary.needsConnection === 1 ? "" : "s"} left as a placeholder`,
    );
  }
  for (const omission of summary.omitted) {
    if (omission.reason === "managed-skill") {
      scrubbed.push(`${omission.count} managed Skill(s)`);
    }
    if (omission.reason === "plugin-skill") {
      scrubbed.push(`${omission.count} plugin Skill(s)`);
    }
    if (omission.reason === "unattributed-skill") {
      scrubbed.push(`${omission.count} Skill(s) with no recorded writer`);
    }
    if (omission.reason === "package-values") {
      scrubbed.push("Package setup values");
    }
  }
  return [
    `Packed ${packed}.`,
    `Scrubbed: ${scrubbed.join("; ")}.`,
    "Nothing is shared until you choose a visibility.",
  ].join(" ");
}
