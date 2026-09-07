// Project membership: the seam, not the authority.
//
// "A Project is an opt-in grouping a Bot creates or joins that carries its own
// shared Memory tier; only the Projects a Bot has joined are injected into its
// prompts." Membership is durable *User-scoped* state — "The User's Durable
// Object is the authority for everything User-scoped" — so this Package
// declares the interface and the Cloudflare app implements it over the User
// Durable Object. Nothing here stores anything.
//
// What *is* a Memory file is the Project descriptor: `projects/<slug>/
// project.md`, GrokBot's own path, with `name` and `description` in a
// frontmatter fence. It sits in the Project's own Memory root, outside any
// `by-agent/` shard, so `writerOwnsMemoryPathV1` allows only the User to write
// it — which is right: creating a Project is a User-scoped act, and the Bot
// performing it does so with its User's authority, recorded as such.
import type { MemoryProjectV1 } from "./render.js";

export type { MemoryProjectV1 };

/** The membership change the authority applied, or its refusal. */
export type MemoryProjectsOutcomeV1 =
  | { status: "ok"; joined: MemoryProjectV1[] }
  | { status: "refused"; reason: string };

/**
 * The durable Project authority, as this Package consumes it. Implemented by
 * the User Durable Object; `create` is join-if-it-exists, exactly as GrokBot's
 * `update_state project create` is.
 */
export interface MemoryProjectsV1 {
  joined(): Promise<MemoryProjectV1[]>;
  create(project: MemoryProjectV1): Promise<MemoryProjectsOutcomeV1>;
  join(projectId: string): Promise<MemoryProjectsOutcomeV1>;
  leave(projectId: string): Promise<MemoryProjectsOutcomeV1>;
}

/** The descriptor path inside a Project's Memory root. GrokBot's own layout. */
export function projectDocumentPathV1(projectId: string): string {
  return `projects/${projectId}/project.md`;
}

const FENCE = "---";

/** Renders `project.md`: a frontmatter fence, then the description as prose. */
export function renderProjectDocumentV1(project: MemoryProjectV1): string {
  return [
    FENCE,
    `name: ${project.name.replace(/[\r\n]+/g, " ").trim()}`,
    `description: ${project.description.replace(/[\r\n]+/g, " ").trim()}`,
    FENCE,
    "",
    project.description.trim(),
    "",
  ].join("\n");
}

/**
 * Reads `project.md` back. Deliberately minimal, like the Skill frontmatter
 * reader: flat `key: value` lines and nothing else, refused rather than
 * partially parsed, because this text reaches a system prompt.
 */
export function parseProjectDocumentV1(
  projectId: string,
  text: string,
): MemoryProjectV1 | undefined {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== FENCE) return undefined;
  const fields: Record<string, string> = {};
  for (let index = 1; index < lines.length && index < 32; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === FENCE) {
      const name = fields.name?.trim();
      if (!name) return undefined;
      return {
        projectId,
        name: name.slice(0, 128),
        description: (fields.description ?? "").trim().slice(0, 512),
      };
    }
    const match = /^([a-z][a-z0-9_-]{0,31}):\s*(.*)$/.exec(line);
    if (!match) return undefined;
    fields[match[1] ?? ""] = match[2] ?? "";
  }
  return undefined;
}
