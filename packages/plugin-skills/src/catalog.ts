// The Skills loader: what a Turn is allowed to load as instructions.
//
// FOUR SOURCES, ONE CATALOG. This module loads the Bot's two instruction roots
// — its own, and the User-global one every Bot of that User shares (ADR 0016)
// — and assembles them with the sources that are not durable-root files at all
// — the managed set compiled into this Package's artifact (`./managed.ts`) and
// the index over the User's installed Catalog entries (`./plugin-index.ts`).
// Those two never meet `isLoadableSkillSourceV1`, because they are not
// Workspace files: they are a Package contributing prompt content, which the
// constitution already permits, and they are pinned by the Turn's Composition
// and the User's Catalog pin respectively. The predicate below still decides
// every question it decided before, about every file it decided it for.
//
// "The kernel treats every Workspace file as data. Only Skills under a Bot's
// instruction roots — its own and its User's — written under the Bot's own
// authority or its User's, are loaded as instructions." That sentence is
// decided in exactly one place —
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
  formatSkillRefV1,
  isLoadableSkillSourceV1,
  isSkillRefSlugV1,
  SKILL_REF_SOURCES_V1,
  type SkillRefSourceV1,
  type SkillRefV1,
  type SkillSourceV1,
  type WorkspaceEntryV1,
  type WorkspaceInstructionRootV1,
  type WorkspaceReadsV1,
} from "@frockbot/kernel-contracts";
import { loadManagedSkillsV1 } from "./managed.js";
import {
  loadPluginSkillsV1,
  type PluginSkillsSourceV1,
} from "./plugin-index.js";
import {
  SKILL_FILE_NAME,
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
  /**
   * Where the Skill is listed. Relative to the Bot's instruction root for a
   * `bot` Skill; the synthetic `managed/<slug>/SKILL.md` or
   * `plugin/<packageId>/<slug>/SKILL.md` for the two sources that are not
   * durable-root files at all.
   */
  path: string;
  /**
   * The ref that names this Skill for invocation and for `skill_load`.
   *
   * Optional only for a `bot` Skill whose directory is not a well-formed slug:
   * an instruction root is an ordinary durable root, so a `SKILL.md` can sit
   * anywhere, and such a Skill is still listed and still loadable by path — it
   * just has no name the composer can attach. Every managed and plugin Skill
   * always has one.
   */
  ref?: SkillRefV1;
  /**
   * Who this Skill is attributed to in the rendered catalog: the shared-tier
   * attribution GrokBot spells `[via]`. A Bot's own Skill carries none.
   */
  by?: string;
  name: string;
  description: string;
  body: string;
  generationId: string;
  contentHash: string;
}

export type SkillRefusalKindV1 =
  | "authority"
  | "malformed"
  | "oversized"
  | "unreadable"
  | "over-catalog"
  | "over-source-cap";

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

/**
 * The User-global instruction root, shared by every Bot this User owns.
 *
 * It is named from the owner rather than passed in, exactly as the Bot root
 * is: a caller cannot ask this Package to load another User's Skills, because
 * there is no argument with which to ask.
 */
export function userInstructionRootV1(
  owner: SkillOwnerV1,
): WorkspaceInstructionRootV1 {
  return { kind: "user-instructions", userId: owner.userId };
}

/** The two roots a Turn's Skills may come out of, in catalog order. */
export function skillInstructionRootsV1(
  owner: SkillOwnerV1,
): { source: "bot" | "user"; root: WorkspaceInstructionRootV1 }[] {
  return [
    { source: "bot", root: botInstructionRootV1(owner) },
    { source: "user", root: userInstructionRootV1(owner) },
  ];
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

/**
 * How a loaded Skill is attributed in the rendered catalog, or `undefined`
 * when the Bot wrote it itself and there is nothing to disclose.
 *
 * A Skill written by the Bot's User, or by another of the User's Bots in the
 * User-global root, is a Skill the reading Bot did not author. Saying so in
 * the catalog line is the shared-tier attribution GrokBot spells `[via]`, and
 * it is what makes a shared tier honest: the Bot is told whose instruction it
 * is about to follow.
 */
function attributionFor(
  source: SkillSourceV1,
  owner: SkillOwnerV1,
): string | undefined {
  const writer = source.writer;
  if (writer.kind === "user") return "your User";
  if (writer.kind === "bot") {
    return writer.botId === owner.botId ? undefined : `Bot "${writer.botId}"`;
  }
  return undefined;
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
  if (root.kind === "user-instructions") {
    return `User "${root.userId}"'s instruction root`;
  }
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
 * Enumerates one instruction root's Skill candidates and loads the ones the
 * constitution allows. Pure with respect to the Workspace: it reads, and never
 * writes.
 *
 * The root defaults to the Bot's own, which is what every caller wanted while
 * there was only one. Passing the User-global root loads the shared tier, and
 * `isLoadableSkillSourceV1` decides both the same way: nothing here widens
 * what may be loaded, it only says which root is being walked. `source` is the
 * ref source the loaded Skills are named under, and it must match the root —
 * which is why both come from `skillInstructionRootsV1` rather than from a
 * caller's two independent arguments.
 */
export async function loadSkillCatalogV1(
  reads: WorkspaceReadsV1,
  owner: SkillOwnerV1,
  options: {
    maxSkills?: number;
    root?: WorkspaceInstructionRootV1;
    source?: "bot" | "user";
  } = {},
): Promise<SkillCatalogV1> {
  const maxSkills = options.maxSkills ?? SKILL_MAX_CATALOG_ENTRIES;
  const root = options.root ?? botInstructionRootV1(owner);
  const refSource = options.source ?? "bot";
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
        reason: `the ${refSource} instruction root could not be listed: ${outcome.reason}`,
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
    const slug = skillSlugFromDocumentPathV1(path);
    catalog.skills.push({
      path,
      ...(slug
        ? { ref: { schemaVersion: 1 as const, source: refSource, slug } }
        : {}),
      ...(attributionFor(source, owner)
        ? { by: attributionFor(source, owner) as string }
        : {}),
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
 * Per-source bounds on one Turn's Skill catalog, mirroring `MEMORY_*_CAPS_V1`.
 *
 * The four numbers are per source rather than one total because the sources do
 * not compete for the same thing: a Bot's own Skills are its self-modification
 * surface and should be generous, the managed set is fixed and small, and a
 * plugin-borne set is written by whoever published the Package and is the one
 * a hostile publisher could inflate. `totalBytes` bounds what the *rendered
 * block* costs — names, descriptions and paths, since bodies are never
 * injected — so a catalog cannot crowd out the conversation no matter how the
 * per-source counts land.
 *
 * Every drop is a recorded `over-source-cap` refusal, so a truncated catalog is
 * visible in durable state rather than silently changing the Bot's behaviour.
 */
export interface SkillCatalogCapsV1 {
  bot: number;
  user: number;
  managed: number;
  plugin: number;
  totalBytes: number;
}

export const SKILL_CATALOG_CAPS_V1: SkillCatalogCapsV1 = {
  bot: 40,
  user: 40,
  managed: 8,
  plugin: 24,
  totalBytes: 16_384,
};

/** One source's contribution to a Turn's catalog. */
export interface SkillSourceResultV1 {
  skills: LoadedSkillV1[];
  refusals: SkillRefusalV1[];
}

/** The four sources, keyed as the canonical ordering names them. */
export type SkillCatalogSourcesV1 = Partial<
  Record<SkillRefSourceV1, SkillSourceResultV1>
>;

function catalogCostOf(skill: LoadedSkillV1): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(skill.name).byteLength +
    encoder.encode(skill.description).byteLength +
    encoder.encode(skill.path).byteLength
  );
}

function orderingKeyOf(skill: LoadedSkillV1): string {
  return skill.ref
    ? `${skill.ref.packageId ?? ""}\u0000${skill.ref.slug}`
    : `\uffff${skill.path}`;
}

/**
 * Assembles one Turn's catalog from its sources.
 *
 * Ordering is `bot` → `user` → `managed` → `plugin`, then by ref within a
 * source, and it is a *deterministic ordering only*: refs are globally unique,
 * so nothing here shadows anything. Two Skills may share a name; the rendered
 * block disambiguates those by ref, which is what makes a User's edit visible
 * on every Bot instead of silently losing to a same-named local one.
 */
export function assembleSkillCatalogV1(
  owner: SkillOwnerV1,
  sources: SkillCatalogSourcesV1,
  caps: SkillCatalogCapsV1 = SKILL_CATALOG_CAPS_V1,
): SkillCatalogV1 {
  const catalog = emptySkillCatalogV1(owner);
  let bytes = 0;
  for (const source of SKILL_REF_SOURCES_V1) {
    const result = sources[source];
    if (!result) continue;
    catalog.refusals.push(...result.refusals);
    const cap = caps[source];
    const ordered = [...result.skills].sort((left, right) =>
      orderingKeyOf(left).localeCompare(orderingKeyOf(right)),
    );
    let admitted = 0;
    for (const skill of ordered) {
      if (admitted >= cap) {
        catalog.refusals.push({
          path: skill.path,
          kind: "over-source-cap",
          reason: `the ${source} Skill source is bounded at ${cap} entries in one catalog`,
        });
        continue;
      }
      const cost = catalogCostOf(skill);
      if (bytes + cost > caps.totalBytes) {
        catalog.refusals.push({
          path: skill.path,
          kind: "over-source-cap",
          reason: `the Skill catalog is bounded at ${caps.totalBytes} rendered bytes`,
        });
        continue;
      }
      bytes += cost;
      admitted += 1;
      catalog.skills.push(skill);
    }
  }
  return catalog;
}

/**
 * The whole catalog one Turn runs under: the Bot's own instruction root, the
 * User-global instruction root its User's Bots share, the managed set compiled
 * into this Package, and the index over the User's installed Catalog entries —
 * assembled, ordered and capped.
 *
 * Both roots are read every Turn, through the same `WorkspaceReadsV1` and the
 * same predicate. A User-global root that holds nothing contributes an empty
 * source rather than being skipped: it was read, and saying so is what makes a
 * missing Skill a fact about the root instead of a fact about the loader.
 */
export async function loadFullSkillCatalogV1(
  reads: WorkspaceReadsV1,
  owner: SkillOwnerV1,
  options: {
    pluginSkills?: PluginSkillsSourceV1;
    managed?: boolean;
    caps?: SkillCatalogCapsV1;
  } = {},
): Promise<SkillCatalogV1> {
  const sources: SkillCatalogSourcesV1 = {};
  for (const { source, root } of skillInstructionRootsV1(owner)) {
    const loaded = await loadSkillCatalogV1(reads, owner, { root, source });
    sources[source] = { skills: loaded.skills, refusals: loaded.refusals };
  }
  if (options.managed !== false) {
    sources.managed = await loadManagedSkillsV1();
  }
  if (options.pluginSkills) {
    sources.plugin = await loadPluginSkillsV1(options.pluginSkills);
  }
  return assembleSkillCatalogV1(owner, sources, options.caps);
}

/**
 * The progressive-disclosure prompt block, in GrokBot's shape: the catalog is
 * injected every Turn as `<agent_skills>` with each Skill's ref, source and
 * description; bodies are not. The Bot reads a body on demand with
 * `skill_load`, and is told that mentioning a Skill is not running it
 * (`docs/research/grokbot-computer.md` §2.8).
 *
 * `source` and `by` are rendered because they change what a Skill *is*: a
 * managed one is first-party and unchangeable, a plugin one arrived with
 * something the User installed, and a Bot's own is one it wrote. A duplicated
 * name is qualified by its ref, since names are not unique and refs are.
 */
export function renderSkillCatalogPromptV1(catalog: SkillCatalogV1): string {
  if (catalog.skills.length === 0) return "";
  const counts = new Map<string, number>();
  for (const skill of catalog.skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  const entries = catalog.skills.map((skill) => {
    const ref = skill.ref ? formatSkillRefV1(skill.ref) : undefined;
    const source = skill.ref?.source ?? "bot";
    const name =
      (counts.get(skill.name) ?? 0) > 1 && ref
        ? `${skill.name} (${ref})`
        : skill.name;
    const attributes = [
      `name="${escapeAttribute(name)}"`,
      `source="${escapeAttribute(source)}"`,
      ...(ref ? [`ref="${escapeAttribute(ref)}"`] : []),
      `path="${escapeAttribute(skill.path)}"`,
      ...(skill.by ? [`by="${escapeAttribute(skill.by)}"`] : []),
    ].join(" ");
    return `  <skill ${attributes}>${escapeText(skill.description)}</skill>`;
  });
  return [
    "<agent_skills>",
    ...entries,
    "</agent_skills>",
    "These are your Skills: recipes you wrote, or your User wrote, for you; the managed ones ship with FrockBot; the plugin ones came with a Package your User installed.",
    'Only names, refs, paths and descriptions are listed above. Call skill_load with the ref in its "path" field to read a Skill\'s full instructions before you follow it.',
    "Mentioning a Skill is not running it.",
  ].join("\n");
}

/**
 * The slug a Skill document path carries, or `undefined` when the path names
 * no usable slug.
 *
 * An instruction root is an ordinary durable root, so a `SKILL.md` can sit
 * anywhere a Bot or a shell put it. The slug is the directory that holds it,
 * and a directory that is not a well-formed slug simply has no ref: the Skill
 * is still listed and still loadable by path, it just cannot be invoked from
 * the composer, which is the honest answer rather than an invented name.
 */
export function skillSlugFromDocumentPathV1(path: string): string | undefined {
  const segments = path.split("/");
  if (segments[segments.length - 1] !== SKILL_FILE_NAME) return undefined;
  const slug = segments[segments.length - 2];
  return isSkillRefSlugV1(slug) ? slug : undefined;
}

/**
 * The ref that names a loaded Skill, or `undefined` when it has none.
 *
 * The loader that produced the Skill already decided this — a managed Skill's
 * ref is its slug, a plugin Skill's is qualified by its Package, and a Bot's
 * own comes from its directory — so this reads the recorded ref rather than
 * re-deriving one from a path that no longer determines the source.
 */
export function skillRefForLoadedSkillV1(
  skill: LoadedSkillV1,
): SkillRefV1 | undefined {
  return skill.ref;
}

/**
 * Resolves an invoked ref against what this Turn actually loaded.
 *
 * `undefined` is the whole answer for an unresolvable ref: the caller fails
 * the command with a visible reason rather than dropping the invocation, so a
 * User who asked for a Skill is never silently answered without it.
 */
export function resolveSkillRefV1(
  catalog: SkillCatalogV1,
  ref: SkillRefV1,
): LoadedSkillV1 | undefined {
  const wanted = formatSkillRefV1(ref);
  return catalog.skills.find(
    (skill) =>
      skill.ref !== undefined && formatSkillRefV1(skill.ref) === wanted,
  );
}

/** One Skill the User invoked, with the ref that named it. */
export interface InvokedSkillV1 {
  ref: SkillRefV1;
  skill: LoadedSkillV1;
}

/**
 * The invoked Skills' bodies, expanded for the Turn's first step.
 *
 * This is what makes `/` an *invocation* rather than a mention. The catalog
 * block above says bodies are read on demand and that mentioning a Skill is
 * not running it; that stays true for every Skill the User did not invoke.
 * The expansion sits in the system prompt so the exact instructions the model
 * received are reconstructable from the Turn's `model/request` alone.
 */
export function renderInvokedSkillsPromptV1(
  invoked: readonly InvokedSkillV1[],
): string {
  if (invoked.length === 0) return "";
  const blocks = invoked.map((entry) =>
    [
      `  <skill ref="${escapeAttribute(formatSkillRefV1(entry.ref))}" name="${escapeAttribute(entry.skill.name)}" path="${escapeAttribute(entry.skill.path)}" generation="${escapeAttribute(entry.skill.generationId)}">`,
      escapeText(entry.skill.body),
      "  </skill>",
    ].join("\n"),
  );
  return [
    "<invoked_skills>",
    ...blocks,
    "</invoked_skills>",
    "Your User invoked these Skills for this message. Their full instructions are above; follow them.",
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
