// The Skills runtime Contribution.
//
// Three responsibilities, and no authority of its own:
//
//  1. Load the Bot's Skills once per admitted Turn, through the
//     kernel-declared `WorkspaceReadsV1`. "Skills are files under the Bot's
//     instruction root. An edit is visible to the Bot on its next admitted
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
//     disclosure, GrokBot parity), `skill_write` authors a Skill into the
//     Bot's own instruction root (self-modification).
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
import { formatSkillRefV1 } from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import {
  botInstructionRootV1,
  countSkillDocumentsV1,
  emptySkillCatalogV1,
  type InvokedSkillV1,
  loadSkillCatalogV1,
  renderInvokedSkillsPromptV1,
  renderSkillCatalogPromptV1,
  resolveSkillRefV1,
  type SkillCatalogV1,
  type SkillOwnerV1,
} from "./catalog.js";
import {
  checkSkillQuotaV1,
  SKILL_QUOTA_DEFAULTS_V1,
  type SkillQuotaConfigV1,
} from "./quota.js";
import {
  isSkillSlugV1,
  renderSkillDocumentV1,
  skillDocumentPathV1,
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
  #catalog: SkillCatalogV1;
  #turn: number | undefined;
  #invoked: InvokedSkillV1[] = [];
  #invokedTurn: number | undefined;
  #step: { turn: number; step: number } | undefined;

  constructor(owner: SkillOwnerV1, reads: WorkspaceReadsV1) {
    this.#owner = owner;
    this.#reads = reads;
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
    this.#catalog = await loadSkillCatalogV1(this.#reads, this.#owner);
    this.#turn = turn;
    session.append({
      type: "skill/injected",
      turn,
      skills: this.#catalog.skills.map((skill) => ({
        path: skill.path,
        name: skill.name,
        generationId: skill.generationId,
        contentHash: skill.contentHash,
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
        "The Skill's path exactly as listed in <agent_skills>, for example skills/daily-standup/SKILL.md.",
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
  },
  required: ["name", "description", "body"],
  additionalProperties: false,
} as const;

/** C0 controls, DEL, and the C1 range: never valid in a frontmatter scalar. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

interface SkillWriteInputV1 {
  name: string;
  description: string;
  body: string;
  slug?: string;
}

function decodeSkillWriteInputV1(input: unknown): SkillWriteInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("skill_write input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["name", "description", "body", "slug"];
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
      const path = String((input as { path: string }).path).trim();
      const skill = catalog
        .current()
        .skills.find((candidate) => candidate.path === path);
      if (!skill) {
        // A candidate refused as an instruction is not readable here either:
        // `skill_load` discloses only what this Turn actually loaded.
        return Promise.resolve({
          content: `No Skill "${path}" is loaded for this Turn. Use only the paths listed in <agent_skills>.`,
          isError: true,
        });
      }
      return Promise.resolve({
        content: [
          `# ${skill.name}`,
          `Path: ${skill.path} (generation ${skill.generationId})`,
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

export function createSkillWriteTool(
  host: SkillsRuntimeHostV1 & { files: WorkspaceFilesV1 },
  writer: SkillWriterIdentityV1,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  const quota = host.quota ?? SKILL_QUOTA_DEFAULTS_V1;
  return {
    name: "skill_write",
    description:
      "Write one of your own Skills: a Markdown recipe stored under your instruction root. It becomes visible to you on your next Turn, not this one.",
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
      const slug = decoded.slug ?? skillSlugFromNameV1(decoded.name);
      if (!slug) {
        return writeRefusal(
          "the Skill name yields no usable slug; pass an explicit slug",
        );
      }
      const relativePath = skillDocumentPathV1(slug);
      const session = sessions.get(context.sessionId);
      if (!session) {
        return writeRefusal(
          `session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      const text = renderSkillDocumentV1({
        name: decoded.name,
        description: decoded.description,
        body: decoded.body,
      });
      const bytes = new TextEncoder().encode(text);

      const path = {
        root: botInstructionRootV1(host.owner),
        path: relativePath,
      };
      const existing = await host.files.stat(path);
      if (existing.status !== "ok" && existing.status !== "not-found") {
        return writeRefusal(
          `the instruction root is unavailable: ${existing.reason}`,
        );
      }
      // The count is paged to completion, and a listing that cannot be read is
      // a refusal rather than a zero: a quota that falls open is not a quota.
      const counted = await countSkillDocumentsV1(host.files, path.root, {
        // The quota only asks whether the root already holds more than it
        // allows, so the count is bounded by Skills rather than by files.
        stopAfter: quota.maxSkillsPerBot,
      });
      if (counted.status !== "ok") {
        return writeRefusal(
          `${counted.reason}, so the per-Bot Skill quota cannot be enforced`,
        );
      }
      const verdict = checkSkillQuotaV1(
        {
          bytes: bytes.byteLength,
          existingSkills: counted.count,
          replaces: existing.status === "ok",
        },
        quota,
      );
      if (verdict.status === "refused") {
        // A quota breach is an observable outcome, not a throw. The refusal is
        // durable through this Turn's `tool/result` event.
        return writeRefusal(verdict.reason);
      }

      const contentHash = await sha256HexV1(text);
      const effectId = `skill:${relativePath}:${contentHash}`;
      const position = openSkillTurnPositionV1(session);
      // Intent before effect.
      session.append({
        type: "skill/write-intent",
        ...position,
        effectId,
        path: relativePath,
        contentHash,
      });
      await session.flush();

      const request: WorkspaceWriteRequestV1 = {
        path,
        bytes,
        writer: {
          kind: "bot",
          botId: host.owner.botId,
          sessionId: writer.sessionId,
          turnId: writer.turnId,
          runId: writer.runId,
        },
        expectedGenerationId:
          existing.status === "ok"
            ? existing.entry.generation.generationId
            : null,
        mediaType: "text/markdown",
      };
      const outcome = await host.files.write(request);
      if (outcome.status !== "ok") {
        return writeRefusal(
          `the write was ${outcome.status}: ${outcome.reason}`,
        );
      }
      session.append({
        type: "skill/written",
        ...position,
        effectId,
        path: relativePath,
        generationId: outcome.generation.generationId,
        contentHash,
      });
      // The model must not be told it succeeded before the record is durable.
      await session.flush();
      return {
        content: [
          `Wrote Skill "${decoded.name}" to ${relativePath} as generation ${outcome.generation.generationId}.`,
          "It is under your own instruction root with your provenance recorded.",
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
    const catalog = new SkillCatalog(host.owner, host.reads);
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
