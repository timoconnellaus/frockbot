// The Skills loader: what a Turn is allowed to load as instructions.
//
// "The kernel treats every Workspace file as data. Only Skills under the Bot's
// own instruction root, written under the Bot's own authority or its User's,
// are loaded as instructions." That sentence is decided in exactly one place —
// `isLoadableSkillSourceV1` in `@frockbot/kernel-contracts` — and this module
// calls it. There is no second opinion here and no override: a candidate the
// predicate refuses is recorded as a refusal and never read as an instruction.
//
// HIBERNATION SEAM. This loader reaches the Workspace only through the
// kernel-declared `WorkspaceReadsV1`. It never calls the Computer interface,
// never provisions or wakes a Computer, and holds no provider type. "The Agent
// loop, Memory, Skills, Package composition, and Routines function correctly
// while the Computer is hibernated and do not wake it." Whoever supplies
// `WorkspaceReadsV1` owns that promise: the durable-root sync (ADR 0013) backs
// an instruction root from object storage, so a read here is an object-storage
// read whether or not a Computer host is running. Swapping that implementation
// is invisible to everything below.
//
// Every value read here is untrusted: a durable root synchronizes
// bidirectionally with object storage, so a path, a writer, and a generation
// can all arrive from the Computer side. Refusals are a declared variant, not
// a throw, because a hostile or malformed file in an instruction root must not
// abort the Turn that enumerated it.
import {
  isLoadableSkillSourceV1,
  type SkillSourceV1,
  type WorkspaceEntryV1,
  type WorkspaceInstructionRootV1,
  type WorkspaceReadsV1,
} from "@frockbot/kernel-contracts";
import {
  isSkillDocumentPathV1,
  parseSkillDocumentV1,
  SKILL_MAX_FILE_BYTES,
} from "./skill-md.js";

/** The Bot whose instruction root is being loaded, and its User. */
export interface SkillOwnerV1 {
  userId: string;
  botId: string;
}

/** Most `list` pages walked before enumeration stops. */
export const SKILL_MAX_LIST_PAGES = 8;
/**
 * Most `list` pages walked while counting a root for the quota.
 *
 * Counting is not loading: the catalog stops at `SKILL_MAX_CATALOG_ENTRIES` and
 * a truncated catalog is a recorded refusal, but a truncated *count* would make
 * the quota unenforceable, so this bound is generous enough to cover the
 * largest configurable `maxSkillsPerBot` at any plausible page size, and being
 * hit is itself an unavailable answer rather than a smaller number.
 */
export const SKILL_MAX_COUNT_LIST_PAGES = 256;
/** Most Skills carried in one catalog. Beyond this, the rest are refused. */
export const SKILL_MAX_CATALOG_ENTRIES = 200;

/** One Skill this Turn may use, with the exact generation it came from. */
export interface LoadedSkillV1 {
  /** Relative to the Bot's instruction root. */
  path: string;
  name: string;
  description: string;
  body: string;
  generationId: string;
  contentHash: string;
}

export type SkillRefusalKindV1 =
  "authority" | "malformed" | "oversized" | "unreadable" | "over-catalog";

/** A candidate that was not loaded, and why. Recorded, never thrown. */
export interface SkillRefusalV1 {
  path: string;
  kind: SkillRefusalKindV1;
  reason: string;
}

export interface SkillCatalogV1 {
  owner: SkillOwnerV1;
  skills: LoadedSkillV1[];
  refusals: SkillRefusalV1[];
}

export function botInstructionRootV1(
  owner: SkillOwnerV1,
): WorkspaceInstructionRootV1 {
  return {
    kind: "bot-instructions",
    userId: owner.userId,
    botId: owner.botId,
  };
}

export function emptySkillCatalogV1(owner: SkillOwnerV1): SkillCatalogV1 {
  return { owner, skills: [], refusals: [] };
}

function sourceOf(entry: WorkspaceEntryV1): SkillSourceV1 {
  // The writer of record is the one the *generation* carries. A caller cannot
  // supply a writer alongside the file: authority follows the recorded write.
  return {
    path: entry.path,
    writer: entry.generation.writer,
    generation: entry.generation,
  };
}

function describeWriter(source: SkillSourceV1): string {
  const writer = source.writer;
  if (writer.kind === "first-party") {
    return `first-party Package "${writer.packageId}"`;
  }
  if (writer.kind === "user") return `User "${writer.userId}"`;
  if (writer.kind === "bot") return `Bot "${writer.botId}"`;
  // Nothing recorded a writer: a process on the Computer wrote the file
  // outside the Workspace file surface, so no authority can be read off it.
  return "no recorded writer (written outside the Workspace file surface)";
}

function describeRoot(source: SkillSourceV1): string {
  const root = source.path.root;
  if (root.kind === "package-declared") {
    return `a root declared by Package "${root.packageId}"`;
  }
  if (root.kind === "user-memory") return "the User Memory root";
  if (root.kind === "project-memory") {
    return `Project "${root.projectId}"'s Memory root`;
  }
  if (root.kind === "bot-memory") return `Bot "${root.botId}"'s Memory root`;
  return `Bot "${root.botId}"'s instruction root`;
}

/**
 * How many Skills a root already holds, or why that is not knowable.
 *
 * There is no "probably fine" answer here. A quota that falls back to zero on
 * an unreadable listing is a quota that can never refuse, so the failure is a
 * declared variant the caller must handle.
 */
export type SkillCountOutcomeV1 =
  { status: "ok"; count: number } | { status: "unavailable"; reason: string };

/**
 * Counts the `SKILL.md` files under a root, walking the listing with the
 * store's own cursor.
 *
 * Only an entry whose last segment is `SKILL.md`, inside a directory, counts —
 * `isSkillDocumentPathV1` decides it. An instruction root is an ordinary durable
 * root — a Bot's notes, an installer's leavings, and a Skill's own supporting
 * files all live there — so counting *files* would refuse a Skill on a quota
 * about Skills, and would make the page bound a bound on files rather than on
 * what the quota measures.
 *
 * `stopAfter` is what keeps the bound on Skills. The only question the quota
 * asks is whether the root already holds more than it allows, so once the
 * count passes that number the answer cannot change, and the walk stops
 * wherever it is. A root with more files than the page bound can walk is then
 * still countable whenever its *Skills* exceed the cap; only a root that is
 * both enormous and under its Skill cap is `unavailable`, and that is the
 * honest answer, because the quota is checked against what the root already
 * holds and an incomplete count is not a smaller count.
 */
export async function countSkillDocumentsV1(
  reads: WorkspaceReadsV1,
  root: WorkspaceInstructionRootV1,
  options: { stopAfter?: number } = {},
): Promise<SkillCountOutcomeV1> {
  const stopAfter = options.stopAfter;
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SKILL_MAX_COUNT_LIST_PAGES; page += 1) {
    const outcome = await reads.list(
      cursor === undefined ? { root } : { root, cursor },
    );
    if (outcome.status !== "ok") {
      return {
        status: "unavailable",
        reason: `the instruction root could not be listed: ${outcome.reason}`,
      };
    }
    count += outcome.entries.filter((entry) =>
      isSkillDocumentPathV1(entry.path.path),
    ).length;
    if (!outcome.cursor) return { status: "ok", count };
    if (stopAfter !== undefined && count > stopAfter) {
      return { status: "ok", count };
    }
    cursor = outcome.cursor;
  }
  return {
    status: "unavailable",
    reason: `the instruction root did not finish listing within ${SKILL_MAX_COUNT_LIST_PAGES} pages`,
  };
}

/**
 * Enumerates a Bot's Skill candidates and loads the ones the constitution
 * allows. Pure with respect to the Workspace: it reads, and never writes.
 */
export async function loadSkillCatalogV1(
  reads: WorkspaceReadsV1,
  owner: SkillOwnerV1,
  options: { maxSkills?: number } = {},
): Promise<SkillCatalogV1> {
  const maxSkills = options.maxSkills ?? SKILL_MAX_CATALOG_ENTRIES;
  const root = botInstructionRootV1(owner);
  const catalog = emptySkillCatalogV1(owner);
  const entries: WorkspaceEntryV1[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SKILL_MAX_LIST_PAGES; page += 1) {
    const outcome = await reads.list(
      cursor === undefined ? { root } : { root, cursor },
    );
    if (outcome.status !== "ok") {
      // "unavailable" is an ordinary answer, not an error condition: an
      // instruction root that cannot be read yields no instructions and says
      // so, rather than failing the Turn.
      catalog.refusals.push({
        path: "",
        kind: "unreadable",
        reason: `the instruction root could not be listed: ${outcome.reason}`,
      });
      return catalog;
    }
    entries.push(...outcome.entries);
    if (!outcome.cursor) break;
    cursor = outcome.cursor;
  }

  const candidates = entries
    .filter((entry) => isSkillDocumentPathV1(entry.path.path))
    .sort((left, right) => left.path.path.localeCompare(right.path.path));

  for (const entry of candidates) {
    const source = sourceOf(entry);
    const path = source.path.path;
    if (!isLoadableSkillSourceV1(source, owner)) {
      catalog.refusals.push({
        path,
        kind: "authority",
        reason: `written by ${describeWriter(source)} under ${describeRoot(source)}; only this Bot or its User, under this Bot's own instruction root, may write an instruction`,
      });
      continue;
    }
    if (catalog.skills.length >= maxSkills) {
      catalog.refusals.push({
        path,
        kind: "over-catalog",
        reason: `the Skill catalog is bounded at ${maxSkills} entries`,
      });
      continue;
    }
    if (source.generation.size > SKILL_MAX_FILE_BYTES) {
      catalog.refusals.push({
        path,
        kind: "oversized",
        reason: `the Skill is ${source.generation.size} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
      });
      continue;
    }
    const read = await reads.read(source.path);
    if (read.status !== "ok") {
      catalog.refusals.push({
        path,
        kind: "unreadable",
        reason: `the Skill could not be read: ${read.reason}`,
      });
      continue;
    }
    if (read.file.generation.generationId !== source.generation.generationId) {
      // The generation changed between listing and reading. Refuse rather than
      // load a body whose writer this Turn never checked.
      catalog.refusals.push({
        path,
        kind: "unreadable",
        reason: "the Skill changed generation while it was being loaded",
      });
      continue;
    }
    if (read.file.bytes.byteLength > SKILL_MAX_FILE_BYTES) {
      catalog.refusals.push({
        path,
        kind: "oversized",
        reason: `the Skill is ${read.file.bytes.byteLength} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
      });
      continue;
    }
    const parsed = parseSkillDocumentV1(
      new TextDecoder().decode(read.file.bytes),
    );
    if (parsed.status !== "ok") {
      catalog.refusals.push({ path, kind: "malformed", reason: parsed.reason });
      continue;
    }
    catalog.skills.push({
      path,
      name: parsed.document.name,
      description: parsed.document.description,
      body: parsed.document.body,
      generationId: source.generation.generationId,
      contentHash: source.generation.contentHash,
    });
  }
  return catalog;
}

/**
 * The progressive-disclosure prompt block, in GrokBot's shape: the catalog is
 * injected every Turn as `<agent_skills>` with each Skill's path and
 * description; bodies are not. The Bot reads a body on demand with
 * `skill_load`, and is told that mentioning a Skill is not running it
 * (`docs/research/grokbot-computer.md` §2.8).
 */
export function renderSkillCatalogPromptV1(catalog: SkillCatalogV1): string {
  if (catalog.skills.length === 0) return "";
  const entries = catalog.skills.map(
    (skill) =>
      `  <skill name="${escapeAttribute(skill.name)}" path="${escapeAttribute(skill.path)}">${escapeText(skill.description)}</skill>`,
  );
  return [
    "<agent_skills>",
    ...entries,
    "</agent_skills>",
    "These are your Skills: recipes you wrote, or your User wrote, for you.",
    "Only names, paths and descriptions are listed above. Call skill_load with a path to read a Skill's full instructions before you follow it.",
    "Mentioning a Skill is not running it.",
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
