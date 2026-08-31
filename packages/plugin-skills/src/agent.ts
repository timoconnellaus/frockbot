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
//     shared root, which every Bot of that User reads (ADR 0016).
//
// It never calls the Computer interface and never wakes a Computer; see the
// hibernation seam documented in `./catalog.ts`.
import type {
  Session,
  SkillRefV1,
  ToolDefinition,
  ToolExecutionContext,
  WorkspaceFilesV1,
  WorkspaceReadsV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/kernel-contracts";
import { formatSkillRefV1, parseSkillRefV1 } from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  botInstructionRootV1,
  countSkillDocumentsV1,
  emptySkillCatalogV1,
  type InvokedSkillV1,
  loadFullSkillCatalogV1,
  renderInvokedSkillsPromptV1,
  renderSkillCatalogPromptV1,
  resolveSkillRefV1,
  type SkillCatalogV1,
  type SkillOwnerV1,
} from "./catalog.js";
import type { PluginSkillsSourceV1 } from "./plugin-index.js";
import { writeSkillDocumentV1 } from "./write.js";
import {
  checkSkillQuotaV1,
  SKILL_QUOTA_DEFAULTS_V1,
  type SkillQuotaConfigV1,
  type SkillQuotaScopeV1,
} from "./quota.js";
import {
  isSkillSlugV1,
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
   * The index over the User's installed Catalog entries. Absent when the
   * deployment has no Catalog, and the Turn then carries no plugin-borne
   * Skills — which is the true answer, not a failure.
   */
  pluginSkills?: PluginSkillsSourceV1;
}

export async function sha256HexV1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error("a Skill write has no open step to record against");
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error("a Skill write has no open step to record against");
  }
  return { turn: started.turn, step: started.step };
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
  #pluginSkills: PluginSkillsSourceV1 | undefined;
  #catalog: SkillCatalogV1;
  #turn: number | undefined;
  #invoked: InvokedSkillV1[] = [];
  #invokedTurn: number | undefined;
  #step: { turn: number; step: number } | undefined;

  constructor(
    owner: SkillOwnerV1,
    reads: WorkspaceReadsV1,
    pluginSkills?: PluginSkillsSourceV1,
  ) {
    this.#owner = owner;
    this.#reads = reads;
    this.#pluginSkills = pluginSkills;
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
    this.#catalog = await loadFullSkillCatalogV1(this.#reads, this.#owner, {
      ...(this.#pluginSkills ? { pluginSkills: this.#pluginSkills } : {}),
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
      const skill = resolveSkillRefV1(this.#catalog, ref);
      if (!skill) {
        return {
          status: "unresolved",
          reason: `no Skill "${formatSkillRefV1(ref)}" is available to this Bot on this Turn`,
        };
      }
      invoked.push({ ref, skill });
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
        "The Skill's ref exactly as listed in <agent_skills> — bot/daily-standup, managed/add-connector, or plugin/<packageId>/<slug>. The path listed beside it is also accepted.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const SKILL_WRITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The Skill's display name." },
    description: {
      type: "string",
      description:
        'When to use this Skill, phrased as "Use this when ...". This is the only part always in your prompt.',
    },
    body: {
      type: "string",
      description: "The Markdown recipe the Skill runs through.",
    },
    slug: {
      type: "string",
      description:
        "Optional directory slug, lowercase letters, digits and hyphens. Derived from the name when omitted. Reuse a slug to supersede that Skill.",
    },
    scope: {
      type: "string",
      enum: ["bot", "user"],
      description:
        "Where the Skill is written: your own instruction root (bot, the default), or your User's shared root (user), where every one of their Bots can read it. Managed and plugin Skills are not editable this way.",
    },
  },
  required: ["name", "description", "body"],
  additionalProperties: false,
} as const;

/** C0 controls, DEL, and the C1 range: never valid in a frontmatter scalar. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Where a `skill_write` lands.
 *
 * All four sources are named so a refusal can be specific about *why* two of
 * them are not writable, rather than reading as an unknown-field error. `bot`
 * and `user` are the two instruction roots (ADR 0016) and both are written the
 * same way, with the Bot's own provenance recorded. `managed` and `plugin` are
 * not durable-root files at all — one is bytes of a first-party artifact, the
 * other an index over a pinned Catalog generation — so neither has a write
 * path to route to.
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
    case "plugin":
      return {
        status: "refused",
        reason: "managed skills are not editable this way",
      };
  }
}

interface SkillWriteInputV1 {
  name: string;
  description: string;
  body: string;
  slug?: string;
  scope?: SkillWriteScopeV1;
}

function decodeSkillWriteInputV1(input: unknown): SkillWriteInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("skill_write input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["name", "description", "body", "slug", "scope"];
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
  const decoded: SkillWriteInputV1 = {
    name: text("name", SKILL_MAX_NAME_LENGTH, true),
    description: text("description", SKILL_MAX_DESCRIPTION_LENGTH, true),
    body: text("body", 65_536, false),
  };
  if (value.slug !== undefined) {
    if (!isSkillSlugV1(value.slug)) {
      throw new Error("skill_write slug is invalid");
    }
    decoded.slug = value.slug;
  }
  if (value.scope !== undefined) {
    const scope = SKILL_WRITE_SCOPES.find(
      (candidate) => candidate === value.scope,
    );
    if (!scope) throw new Error("skill_write scope is invalid");
    decoded.scope = scope;
  }
  return decoded;
}

export function createSkillLoadTool(catalog: SkillCatalog): ToolDefinition {
  return {
    name: "skill_load",
    description:
      "Read one of your Skills in full. Pass the path listed in <agent_skills>. Only Skills listed there can be loaded.",
    inputSchema: SKILL_LOAD_INPUT_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    validate: (input: unknown) =>
      !!input &&
      typeof input === "object" &&
      typeof (input as { path?: unknown }).path === "string",
    execute: (input: unknown) => {
      const named = String((input as { path: string }).path).trim();
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
        return Promise.resolve({
          content: `No Skill "${named}" is loaded for this Turn. Use only the refs listed in <agent_skills>.`,
          isError: true,
        });
      }
      return Promise.resolve({
        content: [
          `# ${skill.name}`,
          `${skill.ref ? `Ref: ${formatSkillRefV1(skill.ref)}\n` : ""}Path: ${skill.path} (generation ${skill.generationId})`,
          "",
          skill.body,
        ].join("\n"),
        isError: false,
      });
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
      const slug = decoded.slug ?? skillSlugFromNameV1(decoded.name);
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
      // One write path, shared with the template import (`./write.ts`); the
      // only thing that differs between them is the writer, and here it is
      // this Bot inside the Turn whose Session and Turn it names.
      const outcome = await writeSkillDocumentV1(
        host.files,
        host.owner,
        {
          kind: "bot",
          botId: host.owner.botId,
          sessionId: writer.sessionId,
          turnId: writer.turnId,
          runId: writer.runId,
        },
        {
          slug,
          name: decoded.name,
          description: decoded.description,
          body: decoded.body,
        },
        {
          scope,
          quota,
          // Intent before effect, and durable before the write is attempted.
          onIntent: async ({ path: relativePath, contentHash }) => {
            session.append({
              type: "skill/write-intent",
              ...position,
              effectId: effectIdOf(scope, relativePath, contentHash),
              path: relativePath,
              contentHash,
            });
            await session.flush();
          },
        },
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
          `Wrote Skill "${decoded.name}" to ${outcome.path} as generation ${outcome.generationId}.`,
          scope === "user"
            ? "It is under your User's shared instruction root, with your provenance recorded, so every one of their Bots can read it and will be told you wrote it."
            : "It is under your own instruction root with your provenance recorded.",
          "Your Skill catalog is fixed for this Turn, so it appears in <agent_skills> on your next Turn.",
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
export function createSkillsRuntimePlugin(
  host: SkillsRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const catalog = new SkillCatalog(host.owner, host.reads, host.pluginSkills);
    const disposers: Array<() => void> = [];
    disposers.push(
      ctx.systemPrompt.register({
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
    disposers.push(ctx.tools.register(createSkillLoadTool(catalog)));
    if (host.files && host.writer) {
      disposers.push(
        ctx.tools.register(
          createSkillWriteTool(
            { ...host, files: host.files },
            host.writer,
            ctx.sessions,
          ),
        ),
      );
    }
    disposers.push(
      ctx.on("agent/pre-step", async (agent, inputs, turn, step, next) => {
        // Once per Turn, at its first step: "an edit is visible to the Bot on
        // its next admitted Turn", so a Skill written mid-Turn does not change
        // the instructions the Turn is already running under.
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
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      catalog.invalidate();
    };
  };
  plugin.inject = ["tools", "systemPrompt", "sessions"];
  return plugin;
}
