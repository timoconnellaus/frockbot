// The Skills runtime Contribution.
//
// Three responsibilities, and no authority of its own:
//
//  1. Load the Bot's Skills once per admitted Turn, through the
//     kernel-declared `WorkspaceReadsV1`. "Skills are files under the Bot's
//     instruction roots. An edit is visible to the Bot on its next admitted
//     Turn" — so the catalog is loaded at the Turn's first step and reused for
//     every later step of that Turn, and an edit made mid-Turn is not visible
//     until the next one.
//  2. Record what it injected. "What Memory enters a model request, and when,
//     is Package policy, and the session event log records exactly what was
//     injected, so an injection gap is visible in durable state rather than
//     silently changing the Bot's behavior." A Skill is an instruction, so the
//     same rule binds: `skill/injected` names every loaded Skill with its
//     generation, and every refused candidate with its reason.
//  3. Offer the two tools: `skill_load` reads one body on demand (progressive
//     disclosure, GrokBot parity), `skill_write` authors a Skill into one of
//     the Bot's instruction roots — its own (self-modification) or its User's
//     shared root, which every Bot of that User reads.
//
// It never calls the Computer interface and never wakes a Computer; see the
// hibernation seam documented in `./catalog.ts`.
import { latestOpenStepPositionV1 } from "@frockbot/core/contracts";
import { sha256HexBytesV1, sha256HexTextV1 } from "@frockbot/core/crypto";
import type {
  Session,
  SkillRefV1,
  ToolDefinition,
  ToolExecutionContext,
  WorkspaceFilesV1,
  WorkspaceReadsV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/core/contracts";
import { formatSkillRefV1, parseSkillRefV1 } from "@frockbot/core/contracts";
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import {
  botInstructionRootV1,
  countSkillDocumentsV1,
  emptySkillCatalogV1,
  type InvokedSkillV1,
  type SkillIndexLoadV1,
  loadFullSkillCatalogV1,
  renderInvokedSkillsPromptV1,
  renderSkillCatalogPromptV1,
  resolveSkillRefV1,
  type LoadedSkillV1,
  type SkillCatalogV1,
  type SkillOwnerV1,
  userInstructionRootV1,
} from "./catalog.js";
import { parseSkillDocumentV1 } from "./skill-md.js";
import type { PluginSkillContributionV1 } from "./plugin.js";
import { writeSkillDocumentV1, writeSkillReferenceV1 } from "./write.js";
import {
  checkSkillQuotaV1,
  SKILL_QUOTA_DEFAULTS_V1,
  type SkillQuotaConfigV1,
  type SkillQuotaScopeV1,
} from "./quota.js";
import {
  isSkillReferenceNameV1,
  isSkillSlugV1,
  skillReferenceNameForV1,
  skillSlugFromNameV1,
  SKILL_MAX_DESCRIPTION_LENGTH,
  SKILL_MAX_NAME_LENGTH,
} from "./skill-md.js";

/** Bot write provenance: the Session and Turn that authored a Skill. */
export interface SkillWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * The host seam this Package receives. The Durable Object supplies it for one
 * admitted Turn: `reads` is always present, `files` and `writer` only when the
 * Turn may author, so a Bot cannot write a Skill outside a Turn whose Session
 * and Turn its provenance can name.
 */
export interface SkillsRuntimeHostV1 {
  owner: SkillOwnerV1;
  reads: WorkspaceReadsV1;
  files?: WorkspaceFilesV1;
  writer?: SkillWriterIdentityV1;
  quota?: SkillQuotaConfigV1;
  /**
   * The Skills the Plugins this Bot runs contribute (ADR 0030). A Plugin's
   * Skill goes exactly where its tools go, so the host resolves the Bot's
   * enable map and hands over only what it is running; an absent list is a
   * Turn with no Plugin Skills.
   */
  pluginSkills?: readonly PluginSkillContributionV1[];
  /**
   * Managed Skills this Bot is not offered, by slug. A managed Skill is a
   * Package's own reference, and the host knows which Packages this Bot's
   * account may reach; a Skill that teaches tools the Turn does not have
   * would tell the model they were there.
   */
  withheldManagedSlugs?: readonly string[];
  /**
   * Admitted Skill metadata and the content-addressed bodies it names.
   * Absent, the Turn has no Workspace Skills rather than scanning the root.
   */
  skillIndexes?: SkillIndexSourceV1;
}

export interface SkillIndexSourceV1 {
  load(): Promise<SkillIndexLoadV1>;
  readBody(
    bodyKey: string,
    contentHash: string,
  ): Promise<Uint8Array | undefined>;
}

export const sha256HexV1 = sha256HexTextV1;

/** The turn and step a Skill write is recorded under. */
export interface SkillTurnPositionV1 {
  turn: number;
  step: number;
}

/**
 * The open step a Skill event belongs to. The session log is the
 * reconstruction surface, so an event without its turn and step would not
 * replay in place.
 */
export function openSkillTurnPositionV1(session: Session): SkillTurnPositionV1 {
  const position = latestOpenStepPositionV1(session);
  if (!position) {
    throw new Error("a Skill write has no open step to record against");
  }
  return position;
}

/** What resolving a Turn's invoked refs produced. Declared, never thrown. */
export type SkillInvocationOutcomeV1 =
  | { status: "ok"; invoked: InvokedSkillV1[] }
  | { status: "unresolved"; reason: string };

/**
 * The Turn-scoped catalog. Deep module, small surface: `refresh` is the only
 * way a catalog changes, and `current` is what the prompt and `skill_load`
 * both read, so those two can never disagree about what this Turn loaded.
 */
export class SkillCatalog {
  #owner: SkillOwnerV1;
  #reads: WorkspaceReadsV1;
  #withheldManagedSlugs: readonly string[];
  #pluginSkills: readonly PluginSkillContributionV1[];
  #indexes: SkillIndexSourceV1 | undefined;
  #catalog: SkillCatalogV1;
  #turn: number | undefined;
  #invoked: InvokedSkillV1[] = [];
  #invokedTurn: number | undefined;
  #step: { turn: number; step: number } | undefined;

  constructor(
    owner: SkillOwnerV1,
    reads: WorkspaceReadsV1,
    withheldManagedSlugs: readonly string[] = [],
    pluginSkills: readonly PluginSkillContributionV1[] = [],
    indexes?: SkillIndexSourceV1,
  ) {
    this.#owner = owner;
    this.#reads = reads;
    this.#withheldManagedSlugs = withheldManagedSlugs;
    this.#pluginSkills = pluginSkills;
    this.#indexes = indexes;
    this.#catalog = emptySkillCatalogV1(owner);
  }

  current(): SkillCatalogV1 {
    return this.#catalog;
  }

  loadedTurn(): number | undefined {
    return this.#turn;
  }

  /** Loads the Turn's Skills and records the injection in the session log. */
  async refresh(turn: number, session: Session): Promise<SkillCatalogV1> {
    const indexes = this.#indexes ? await this.#indexes.load() : undefined;
    this.#catalog = await loadFullSkillCatalogV1(this.#reads, this.#owner, {
      withheldManagedSlugs: this.#withheldManagedSlugs,
      pluginSkills: this.#pluginSkills,
      ...(indexes ? { indexes } : {}),
    });
    this.#turn = turn;
    session.append({
      type: "skill/injected",
      turn,
      skills: this.#catalog.skills.map((skill) => ({
        path: skill.path,
        name: skill.name,
        generationId: skill.generationId,
        contentHash: skill.contentHash,
        // Whose Skill it is, when it is not this Bot's own. A shared tier
        // whose durable record did not say who wrote the instruction would
        // make "the Bot ran under an instruction it did not author" invisible.
        ...(skill.by ? { by: skill.by } : {}),
        // What the Skill offered to be loaded on demand, with the exact
        // generation each file was at when the catalog was assembled.
        ...(skill.references.length > 0
          ? {
              references: skill.references.map((reference) => ({
                path: reference.path,
                // Whose reference it is, when it is not this Bot's own: the
                // file beside a `SKILL.md` can have a different writer, and a
                // Turn that read it must say which.
                ...(reference.by ? { by: reference.by } : {}),
                generationId: reference.generationId,
              })),
            }
          : {}),
      })),
      refusals: this.#catalog.refusals.map((refusal) => ({
        path: refusal.path,
        reason: `${refusal.kind}: ${refusal.reason}`,
      })),
    });
    await session.flush();
    return this.#catalog;
  }

  /**
   * Resolves the Skills one Turn's input invoked, and records each one.
   *
   * An unresolvable ref is a declared failure, never a silent drop: a User who
   * typed `/daily-standup` and got an answer that ignored it would have no way
   * to tell. The caller turns this into a blocked Turn with the reason.
   */
  async invoke(
    turn: number,
    session: Session,
    refs: readonly SkillRefV1[],
  ): Promise<SkillInvocationOutcomeV1> {
    const invoked: InvokedSkillV1[] = [];
    for (const ref of refs) {
      const listed = resolveSkillRefV1(this.#catalog, ref);
      if (!listed) {
        return {
          status: "unresolved",
          reason: `no Skill "${formatSkillRefV1(ref)}" is available to this Bot on this Turn`,
        };
      }
      const materialized = await this.materialize(listed);
      if (materialized.status !== "ok") {
        return { status: "unresolved", reason: materialized.reason };
      }
      invoked.push({ ref, skill: materialized.skill });
    }
    if (invoked.length > 0) {
      session.appendBatch(
        invoked.map((entry) => ({
          type: "skill/invoked" as const,
          turn,
          ref: entry.ref,
          generationId: entry.skill.generationId,
          contentHash: entry.skill.contentHash,
        })),
      );
      await session.flush();
    }
    this.#invoked = invoked;
    this.#invokedTurn = turn;
    return { status: "ok", invoked };
  }

  /**
   * The Skills whose bodies belong in the request being assembled right now.
   *
   * Empty unless this is the first step of the Turn that invoked them: an
   * invocation expands once, into the step the User's message enters, and the
   * later steps of the same Turn run on the conversation the expansion already
   * produced.
   */
  invokedFor(turn: number, step: number): readonly InvokedSkillV1[] {
    return turn === this.#invokedTurn && step === 1 ? this.#invoked : [];
  }

  /** The step whose request the prompt is being assembled for. */
  enterStep(turn: number, step: number): void {
    this.#step = { turn, step };
  }

  /** The invoked bodies for the open step, as the prompt section renders them. */
  currentInvoked(): readonly InvokedSkillV1[] {
    const open = this.#step;
    return open ? this.invokedFor(open.turn, open.step) : [];
  }

  /**
   * One reference of a Skill this Turn loaded, read on demand (ADR 0030).
   *
   * The catalog carries the index; the bytes are fetched here, from wherever
   * that source keeps them — a managed or Plugin reference travels in the
   * artifact, and a Workspace one is read through the same `WorkspaceReadsV1`
   * its listing came through, at the generation the catalog recorded. A
   * reference that moved generation since is refused rather than served: the
   * Turn would otherwise follow instructions it never listed.
   */
  async reference(
    skill: LoadedSkillV1,
    name: string,
  ): Promise<
    | { status: "ok"; path: string; by?: string; text: string }
    | { status: "refused"; reason: string }
  > {
    const reference = skill.references.find(
      (candidate) =>
        skillReferenceNameForV1(skill.path, candidate.path) === name,
    );
    if (!reference) {
      return {
        status: "refused",
        reason: `Skill "${skill.name}" offers no reference "${name}" on this Turn.`,
      };
    }
    const by = reference.by;
    if (reference.text !== undefined) {
      return {
        status: "ok",
        path: reference.path,
        ...(by ? { by } : {}),
        text: reference.text,
      };
    }
    if (reference.bodyKey && reference.contentHash) {
      const bytes = await this.readPinned(
        reference.bodyKey,
        reference.contentHash,
      );
      if (!bytes) {
        return {
          status: "refused",
          reason: "the admitted reference bytes are unavailable",
        };
      }
      return {
        status: "ok",
        path: reference.path,
        ...(by ? { by } : {}),
        text: new TextDecoder().decode(bytes),
      };
    }
    const root =
      skill.source === "user"
        ? userInstructionRootV1(this.#owner)
        : botInstructionRootV1(this.#owner);
    const read = await this.#reads.read({ root, path: reference.path });
    if (read.status !== "ok") {
      return {
        status: "refused",
        reason: `the reference could not be read: ${read.reason}`,
      };
    }
    if (read.file.generation.generationId !== reference.generationId) {
      return {
        status: "refused",
        reason: "the reference changed generation since this Turn listed it",
      };
    }
    return {
      status: "ok",
      path: reference.path,
      ...(by ? { by } : {}),
      text: new TextDecoder().decode(read.file.bytes),
    };
  }

  /**
   * The admitted body. A Workspace Skill's catalog entry carries no body;
   * this reads the content-addressed bytes the index named, and refuses when
   * those bytes are gone instead of opening the mutable path.
   */
  async materialize(
    skill: LoadedSkillV1,
  ): Promise<
    | { status: "ok"; skill: LoadedSkillV1 }
    | { status: "unavailable"; reason: string }
  > {
    if (!skill.bodyKey) return { status: "ok", skill };
    const bytes = await this.readPinned(skill.bodyKey, skill.contentHash);
    if (!bytes) {
      return {
        status: "unavailable",
        reason: `the admitted bytes for ${skill.path} are unavailable`,
      };
    }
    const parsed = parseSkillDocumentV1(new TextDecoder().decode(bytes));
    if (parsed.status !== "ok") {
      return {
        status: "unavailable",
        reason: `the admitted bytes for ${skill.path} are unavailable`,
      };
    }
    return { status: "ok", skill: { ...skill, body: parsed.document.body } };
  }

  private async readPinned(
    bodyKey: string,
    contentHash: string,
  ): Promise<Uint8Array | undefined> {
    if (!this.#indexes) return undefined;
    const bytes = await this.#indexes.readBody(bodyKey, contentHash);
    if (!bytes) return undefined;
    const hash = await sha256HexBytesV1(bytes);
    return hash === contentHash ? bytes : undefined;
  }

  /** Drops the catalog, so the next Turn reloads it rather than reusing it. */
  invalidate(): void {
    this.#catalog = emptySkillCatalogV1(this.#owner);
    this.#turn = undefined;
    this.#invoked = [];
    this.#invokedTurn = undefined;
    this.#step = undefined;
  }
}

const SKILL_LOAD_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        'The Skill\'s ref exactly as listed in <agent_skills> — bot/daily-standup, managed/add-connector, or plugin/<pluginId>/<slug>. The path listed beside it is also accepted. This field is named "path" whichever of the two you send.',
    },
    reference: {
      type: "string",
      description:
        "Optional file name of one of that Skill's references, like forms.md, as its instructions name it. With it you get that file instead of the Skill's own body.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const SKILL_WRITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The Skill's display name. Required unless you are writing a reference.",
    },
    description: {
      type: "string",
      description:
        'When to use this Skill, phrased as "Use this when ...". This is the only part always in your prompt. Required unless you are writing a reference.',
    },
    body: {
      type: "string",
      description:
        "The Markdown the Skill runs through, or the reference's own Markdown.",
    },
    slug: {
      type: "string",
      description:
        "Optional directory slug, lowercase letters, digits and hyphens. Derived from the name when omitted, and required when writing a reference. Reuse a slug to supersede that Skill.",
    },
    reference: {
      type: "string",
      description:
        "Optional file name, like forms.md, to write beside that Skill's instructions instead of the Skill itself. Your SKILL.md should say when to load it.",
    },
    scope: {
      type: "string",
      enum: ["bot", "user"],
      description:
        "Where the Skill is written: your own instruction root (bot, the default), or your User's shared root (user), where every one of their Bots can read it. Managed and plugin Skills are not editable this way.",
    },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

/** C0 controls, DEL, and the C1 range: never valid in a frontmatter scalar. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Where a `skill_write` lands.
 *
 * All three sources are named so a refusal can be specific about *why* one of
 * them is not writable, rather than reading as an unknown-field error. `bot`
 * and `user` are the two instruction roots and both are written the same way,
 * with the Bot's own provenance recorded. `managed` is not a durable-root file
 * at all — it is bytes of a first-party artifact — so it has no write path to
 * route to.
 */
export type SkillWriteScopeV1 = "bot" | "user" | "managed" | "plugin";

const SKILL_WRITE_SCOPES: readonly SkillWriteScopeV1[] = [
  "bot",
  "user",
  "managed",
  "plugin",
];

/** Why a scope is refused, or `undefined` when it is writable. GrokBot's own wording for managed. */
export function skillWriteScopeRefusalV1(
  scope: SkillWriteScopeV1,
): string | undefined {
  const target = skillWriteTargetV1(scope);
  return target.status === "refused" ? target.reason : undefined;
}

/**
 * The instruction root a scope writes, or the reason there is none.
 *
 * Declared rather than narrowed at the call site: the two writable scopes are
 * exactly the two instruction roots, and this is the one place that says so,
 * so a caller cannot reach the write path holding `managed`.
 */
export type SkillWriteTargetV1 =
  | { status: "writable"; scope: SkillQuotaScopeV1 }
  | { status: "refused"; reason: string };

export function skillWriteTargetV1(
  scope: SkillWriteScopeV1,
): SkillWriteTargetV1 {
  switch (scope) {
    case "bot":
    case "user":
      return { status: "writable", scope };
    case "managed":
      return {
        status: "refused",
        reason: "managed skills are not editable this way",
      };
    case "plugin":
      // A Plugin's Skill is bytes of its artifact, like a managed one: there
      // is no durable-root file to write, and a Bot changes what a Plugin
      // teaches by writing the Plugin.
      return {
        status: "refused",
        reason: "plugin skills are not editable this way",
      };
  }
}

/**
 * One `skill_write` call, decoded.
 *
 * Two writes share the tool because they share everything that matters —
 * the root, the quota, the provenance — and differ only in what lands: a
 * `SKILL.md` rendered from `name`, `description` and `body`, or one reference
 * file whose bytes are the body. `reference` is what says which, and the two
 * shapes are exclusive, so a Bot cannot half-write either one.
 */
type SkillWriteInputV1 =
  | {
      kind: "skill";
      name: string;
      description: string;
      body: string;
      slug?: string;
      scope?: SkillWriteScopeV1;
    }
  | {
      kind: "reference";
      reference: string;
      slug: string;
      body: string;
      scope?: SkillWriteScopeV1;
    };

function decodeSkillWriteInputV1(input: unknown): SkillWriteInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("skill_write input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["name", "description", "body", "slug", "reference", "scope"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new Error("skill_write input has unknown fields");
  }
  const text = (key: string, maximum: number, singleLine: boolean): string => {
    const candidate = value[key];
    if (
      typeof candidate !== "string" ||
      candidate.trim().length === 0 ||
      candidate.length > maximum
    ) {
      throw new Error(`skill_write ${key} must be a bounded string`);
    }
    // `name` and `description` become one frontmatter line each. A newline or
    // a control character there renders a `SKILL.md` this Package's own parser
    // refuses, so the Bot would have written a Skill it can never load.
    if (singleLine && CONTROL_CHARACTERS.test(candidate)) {
      throw new Error(
        `skill_write ${key} must not contain newlines or control characters`,
      );
    }
    return candidate.trim();
  };
  if (value.slug !== undefined && !isSkillSlugV1(value.slug)) {
    throw new Error("skill_write slug is invalid");
  }
  const slug = value.slug as string | undefined;
  let scope: SkillWriteScopeV1 | undefined;
  if (value.scope !== undefined) {
    scope = SKILL_WRITE_SCOPES.find((candidate) => candidate === value.scope);
    if (!scope) throw new Error("skill_write scope is invalid");
  }
  const body = text("body", 65_536, false);
  if (value.reference !== undefined) {
    if (!isSkillReferenceNameV1(value.reference)) {
      throw new Error(
        "skill_write reference must be a single .md file name, like forms.md",
      );
    }
    if (value.name !== undefined || value.description !== undefined) {
      throw new Error(
        "skill_write name and description belong to a Skill, not to one of its references",
      );
    }
    if (slug === undefined) {
      throw new Error(
        "skill_write reference needs the slug of the Skill it belongs to",
      );
    }
    return {
      kind: "reference",
      reference: value.reference,
      slug,
      body,
      ...(scope ? { scope } : {}),
    };
  }
  return {
    kind: "skill",
    name: text("name", SKILL_MAX_NAME_LENGTH, true),
    description: text("description", SKILL_MAX_DESCRIPTION_LENGTH, true),
    body,
    ...(slug ? { slug } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * What `skill_load` was actually asked for, from either field name.
 *
 * The prompt said "call `skill_load` with a ref" while the schema named the
 * field `path`, so the model reached for `ref` and got the loop's generic
 * `Invalid input for tool: skill_load` — no field named, no shape offered. The
 * prompt now names `path`, and `ref` is accepted as an alias so the older
 * phrasing (and the model's own instinct) still lands.
 */
export function skillLoadNameV1(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as { path?: unknown; ref?: unknown };
  const named = typeof record.path === "string" ? record.path : record.ref;
  if (typeof named !== "string") return undefined;
  const trimmed = named.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The reference a `skill_load` asked for: the file name as the Skill's
 * instructions index it.
 */
export function skillLoadReferenceV1(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const named = (input as { reference?: unknown }).reference;
  if (typeof named !== "string") return undefined;
  const trimmed = named.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Why a `skill_load` input could not be used, and what to send instead. */
export const SKILL_LOAD_INPUT_REFUSAL =
  'skill_load input is invalid: "path" must be a non-empty string naming a Skill from <agent_skills> — its ref (bot/daily-standup, managed/add-connector, plugin/<pluginId>/<slug>) or the path listed beside it. Expected {"path":"managed/add-connector"}.';

export function createSkillLoadTool(catalog: SkillCatalog): ToolDefinition {
  return {
    name: "skill_load",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      'Read one of your Skills in full. Pass the ref or the path listed in <agent_skills> as "path". Add "reference" to read one of the files that Skill\'s instructions name instead of its body. Only Skills listed there can be loaded.',
    inputSchema: SKILL_LOAD_INPUT_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    // Deliberately permissive: a wrong shape reaches `execute`, which says
    // what was wrong. A bare `false` here becomes the generic
    // `Invalid input for tool: skill_load`, which cost a step every time the
    // model reached for the field name the prompt used.
    validate: (input: unknown) => !!input && typeof input === "object",
    execute: async (input: unknown) => {
      const named = skillLoadNameV1(input);
      if (named === undefined) {
        return { content: SKILL_LOAD_INPUT_REFUSAL, isError: true };
      }
      const loaded = catalog.current().skills;
      // A ref first, then the path. Both are printed in `<agent_skills>`, and
      // a ref is the only form that names a managed or plugin Skill, since
      // neither is a file under any root the Bot could path into.
      const ref = parseSkillRefV1(named);
      const skill =
        (ref
          ? loaded.find(
              (candidate) =>
                candidate.ref !== undefined &&
                formatSkillRefV1(candidate.ref) === formatSkillRefV1(ref),
            )
          : undefined) ?? loaded.find((candidate) => candidate.path === named);
      if (!skill) {
        // A candidate refused as an instruction is not readable here either:
        // `skill_load` discloses only what this Turn actually loaded.
        return {
          content: `No Skill "${named}" is loaded for this Turn. Use only the refs listed in <agent_skills>.`,
          isError: true,
        };
      }
      const materialized = await catalog.materialize(skill);
      if (materialized.status !== "ok") {
        return { content: materialized.reason, isError: true };
      }
      const body = materialized.skill;
      const wanted = skillLoadReferenceV1(input);
      if (wanted !== undefined) {
        // Only a reference of a Skill this Turn loaded, at the generation the
        // catalog listed: the same disclosure rule the body follows.
        const reference = await catalog.reference(body, wanted);
        if (reference.status !== "ok") {
          return { content: reference.reason, isError: true };
        }
        return {
          content: [
            `# ${skill.name} · ${wanted}`,
            `${reference.by ? `By: ${reference.by}\n` : ""}Path: ${reference.path}`,
            "",
            reference.text,
          ].join("\n"),
          isError: false,
        };
      }
      return {
        content: [
          `# ${body.name}`,
          `${body.ref ? `Ref: ${formatSkillRefV1(body.ref)}\n` : ""}Path: ${body.path} (generation ${body.generationId})`,
          "",
          body.body,
        ].join("\n"),
        isError: false,
      };
    },
  };
}

function writeRefusal(reason: string): { content: string; isError: boolean } {
  return { content: `skill_write was refused: ${reason}`, isError: true };
}

/**
 * The effect id one Skill write is recorded under.
 *
 * The root is part of it. The two instruction roots address Skills by the same
 * relative path, so `bot` and `user` writes of one slug with one body would
 * otherwise share an id, and a replay could match the wrong recorded effect.
 * `bot` keeps its historical form, so ids already in durable logs still match.
 */
function effectIdOf(
  scope: SkillQuotaScopeV1,
  path: string,
  contentHash: string,
): string {
  return scope === "bot"
    ? `skill:${path}:${contentHash}`
    : `skill:${scope}:${path}:${contentHash}`;
}

export function createSkillWriteTool(
  host: SkillsRuntimeHostV1 & { files: WorkspaceFilesV1 },
  writer: SkillWriterIdentityV1,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  const quota = host.quota ?? SKILL_QUOTA_DEFAULTS_V1;
  return {
    name: "skill_write",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Write a Skill: a Markdown recipe stored under your own instruction root, or under your User's shared root where all of their Bots can read it. It becomes visible to you on your next Turn, not this one.",
    inputSchema: SKILL_WRITE_INPUT_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input: unknown) => {
      try {
        decodeSkillWriteInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: SkillWriteInputV1;
      try {
        decoded = decodeSkillWriteInputV1(input);
      } catch (error) {
        return writeRefusal(
          error instanceof Error ? error.message : String(error),
        );
      }
      const target = skillWriteTargetV1(decoded.scope ?? "bot");
      if (target.status === "refused") return writeRefusal(target.reason);
      const scope = target.scope;
      const slug =
        decoded.kind === "reference"
          ? decoded.slug
          : (decoded.slug ?? skillSlugFromNameV1(decoded.name));
      if (!slug) {
        return writeRefusal(
          "the Skill name yields no usable slug; pass an explicit slug",
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return writeRefusal(
          `session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      let position: { turn: number; step: number };
      try {
        position = openSkillTurnPositionV1(session);
      } catch (error) {
        return writeRefusal(
          error instanceof Error ? error.message : String(error),
        );
      }
      const provenance = {
        kind: "bot" as const,
        botId: host.owner.botId,
        sessionId: writer.sessionId,
        turnId: writer.turnId,
        runId: writer.runId,
      };
      // Intent before effect, and durable before the write is attempted.
      const onIntent = async ({
        path: relativePath,
        contentHash,
      }: {
        path: string;
        contentHash: string;
      }): Promise<void> => {
        session.append({
          type: "skill/write-intent",
          ...position,
          effectId: effectIdOf(scope, relativePath, contentHash),
          path: relativePath,
          contentHash,
        });
        await session.flush();
      };
      // The writer is this Bot, inside the Turn whose Session and Turn it names.
      const outcome =
        decoded.kind === "reference"
          ? await writeSkillReferenceV1(
              host.files,
              host.owner,
              provenance,
              { slug, reference: decoded.reference, text: decoded.body },
              { scope, quota, onIntent },
            )
          : await writeSkillDocumentV1(
              host.files,
              host.owner,
              provenance,
              {
                slug,
                name: decoded.name,
                description: decoded.description,
                body: decoded.body,
              },
              { scope, quota, onIntent },
            );
      if (outcome.status === "refused") return writeRefusal(outcome.reason);
      session.append({
        type: "skill/written",
        ...position,
        effectId: effectIdOf(scope, outcome.path, outcome.contentHash),
        path: outcome.path,
        generationId: outcome.generationId,
        contentHash: outcome.contentHash,
      });
      // The model must not be told it succeeded before the record is durable.
      await session.flush();
      return {
        content: [
          decoded.kind === "reference"
            ? `Wrote reference "${decoded.reference}" of Skill "${slug}" to ${outcome.path} as generation ${outcome.generationId}.`
            : `Wrote Skill "${decoded.name}" to ${outcome.path} as generation ${outcome.generationId}.`,
          scope === "user"
            ? "It is under your User's shared instruction root, with your provenance recorded, so every one of their Bots can read it and will be told you wrote it."
            : "It is under your own instruction root with your provenance recorded.",
          decoded.kind === "reference"
            ? "Your Skill catalog is fixed for this Turn, so skill_load can read it on your next Turn."
            : "Your Skill catalog is fixed for this Turn, so it appears in <agent_skills> on your next Turn.",
        ].join(" "),
        isError: false,
      };
    },
  };
}

/**
 * The runtime Contribution. Registers the prompt section, `skill_load`, and —
 * only when the host supplies a writable Workspace and Bot provenance —
 * `skill_write`.
 */
export function createSkillsRuntimeFeature(
  host: SkillsRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const catalog = new SkillCatalog(
      host.owner,
      host.reads,
      host.withheldManagedSlugs ?? [],
      host.pluginSkills ?? [],
      host.skillIndexes,
    );
    const disposers: Array<() => void> = [];
    disposers.push(
      runtime.systemPrompt.register({
        id: "skills",
        order: 90,
        render: () =>
          [
            renderSkillCatalogPromptV1(catalog.current()),
            renderInvokedSkillsPromptV1(catalog.currentInvoked()),
          ]
            .filter((block) => block.length > 0)
            .join("\n\n"),
      }),
    );
    disposers.push(runtime.tools.register(createSkillLoadTool(catalog)));
    if (host.files && host.writer) {
      disposers.push(
        runtime.tools.register(
          createSkillWriteTool(
            { ...host, files: host.files },
            host.writer,
            runtime.sessions,
          ),
        ),
      );
    }
    disposers.push(
      runtime.hooks.add({
        preStep: async (agent, inputs, turn, step, next) => {
          // Once per Turn, at its first step: "an edit is visible to the Bot
          // on its next admitted Turn", so a Skill written mid-Turn does not
          // change the instructions the Turn is already running under.
          if (step === 1 || catalog.loadedTurn() !== turn) {
            await catalog.refresh(turn, agent.session);
          }
          catalog.enterStep(turn, step);
          if (step === 1) {
            const refs = inputs.flatMap((input) => input.skills ?? []);
            const outcome = await catalog.invoke(turn, agent.session, refs);
            if (outcome.status === "unresolved") {
              return { kind: "reject", reason: outcome.reason };
            }
          }
          return next();
        },
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      catalog.invalidate();
    };
  };
}
