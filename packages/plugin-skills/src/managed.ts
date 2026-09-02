// The managed Skills: first-party recipes compiled into this Package.
//
// PARITY. GrokBot ships four read-only skills under
// `managed-skills/skills/<slug>/SKILL.md` — `add-connector`,
// `export-bot-template`, `import-bot-template`, `learn-from-demonstration` —
// which `update_state` cannot edit (`docs/research/grokbot-computer.md` lines
// 73-74, 284-285). The four slugs and the shape of what each one is for are
// mirrored here; every body is written for FrockBot's own tools, because a
// recipe that names another product's tools is not a recipe.
//
// WHERE THEY LIVE, AND WHY IT IS NOT A ROOT. These are string constants in
// this module, so they are bytes of the `plugin-skills` artifact and nothing
// else. That is the whole design: "the kernel treats every Workspace file as
// data. Only Skills under the Bot's own instruction root, written under the
// Bot's own authority or its User's, are loaded as instructions" stays exactly
// true, because a managed Skill is not a Workspace file at all. It is a
// Package contributing prompt content — which the constitution already
// permits, and which the Composition already pins: the Turn's
// `CompositionPinV1.artifactSetHash` covers the artifact these bytes live in,
// so the reconstructed prompt is exact without any second store to consult.
//
// READ-ONLY follows from the same fact. There is no path from `skill_write` to
// an artifact, so `scope: "managed"` is refused rather than routed anywhere.
import {
  parseSkillDocumentV1,
  SKILL_FILE_NAME,
  isSkillSlugV1,
} from "./skill-md.js";
import type { LoadedSkillV1, SkillRefusalV1 } from "./catalog.js";

/** The directory prefix a managed Skill's synthetic path carries. */
export const MANAGED_SKILL_PATH_PREFIX = "managed";

/** Who a managed Skill is attributed to in the rendered catalog. */
export const MANAGED_SKILL_ATTRIBUTION = "FrockBot";

/** One bundled `SKILL.md`, exactly as it would sit on disk. */
export interface ManagedSkillDocumentV1 {
  slug: string;
  text: string;
}

const ADD_CONNECTOR = `---
name: Add connector
description: Use this when the User asks for an app, MCP server, or model provider that this Bot cannot already reach.
---
# Add a connector

Connections are User acts performed out of band. You cannot create or request
one, render a connect card, provide an authorization link, or direct the User
through a connection flow. You discover a service only after it is connected.

1. Name the unavailable operation and the missing capability plainly.
2. Do not invent a substitute credential path and never ask for a secret in
   conversation; credentials never belong in a Turn or Memory.
3. Offer any useful alternative that uses authority you already hold.
4. Stop. Do not retry the missing capability in a loop and do not turn the
   refusal into a request for more authority.
`;

const EXPORT_BOT_TEMPLATE = `---
name: Export bot template
description: Use this when the User wants to reuse this Bot's setup for another Bot, or to keep a record of how it is configured.
---
# Export a bot template

A template is a written description of a Bot's setup, not a file format and not
a copy of anything secret.

1. Gather what actually defines this Bot: its name and description, the
   Packages its behaviour depends on, its model setting, and the Skills under
   its own instruction root.
2. Read each Skill you intend to include with \`skill_load\` before you describe
   it. Describing a Skill from its catalog line alone is describing a name.
3. Write the template as Markdown, in this order: Identity, Packages, Model,
   Skills, Notes. Under Skills, give each Skill's slug,
   name, description, and full body — that is what makes the template
   importable.
4. Exclude every credential. Connection ids, API keys, OAuth tokens, and
   account identifiers are the User's, not the template's.
5. Hand the template to the User with \`send_to_user\`. If they want it kept,
   write it into your own Memory with \`memory_write\`, not into a Skill: a
   template is a record, and a Skill is a recipe.

Say explicitly that a template cannot carry Connections, so nobody expects an
import to reproduce them.
`;

const IMPORT_BOT_TEMPLATE = `---
name: Import bot template
description: Use this when the User gives you a bot template and wants a Bot set up from it.
---
# Import a bot template

1. Read the template through once before you change anything, and say back what
   it will produce: a Bot's name, its Skills, and what it will still be missing.
2. Decide where it lands. If the template is for a new Bot, use \`bot_create\` to
   add one to your User's flock; it follows your User's default model, exactly
   as one the User creates in the sidebar does.
   If it is for you, use \`bot_update\` for the identity fields and continue.
3. Recreate the Skills you can. For each Skill in the template, call
   \`skill_write\` with its name, description, body, and slug. They land under
   your own instruction root and become visible on your next Turn, not this
   one, so do not try to run one immediately after writing it.
4. Do not create or request Connections. If the imported setup lacks authority,
   report the affected operation as unavailable without rendering or directing
   a connection flow. Do not attempt a workaround that reaches the same service
   by another route.
5. Report what was created, what was skipped, and what the User still has to
   do. A half-imported template that reads as finished is worse than one that
   names its gaps.

If the template names a Skill for another Bot, you cannot write it there. Say
so rather than writing it to yourself under a changed name.
`;

const LEARN_FROM_DEMONSTRATION = `---
name: Learn from demonstration
description: Use this when the User has walked you through a task and wants you to be able to repeat it.
---
# Turn a demonstration into a Skill

The demonstration is whatever the User just showed you: a transcript, a series
of steps they narrated, or a run you performed together. Your job is to turn it
into a recipe you can follow later without them.

1. Recover the actual sequence. Read back over this conversation, and use
   \`memory_search\` for anything the User told you earlier that the steps
   depend on. Do not invent a step you did not see.
2. Separate the recipe from the instance. Names, dates, ids, and amounts from
   the demonstration are examples, not the Skill. Replace each one with what it
   was an example *of*.
3. Check it against what you can actually do. A step that needs a tool you do
   not have is a step the Skill must ask the User for, not one to write as
   though it will work.
4. Write it with \`skill_write\`: a short name, a description that starts "Use
   this when …" so your future self can tell from the catalog line alone
   whether it applies, and a numbered body. Keep the body under a page.
5. Confirm with the User: give the slug, the description, and the steps, and
   ask whether anything is wrong. A Skill is an instruction you wrote for
   yourself, so a wrong one is a durable mistake.

The Skill is visible to you on your next Turn, not this one. Do not claim to
have run it in the Turn that wrote it — mentioning a Skill is not running it.
`;

/**
 * The bundled documents, in slug order. Ordering is fixed here rather than
 * sorted later so the catalog a Turn assembles is the same on every host.
 */
export const MANAGED_SKILL_DOCUMENTS_V1: readonly ManagedSkillDocumentV1[] = [
  { slug: "add-connector", text: ADD_CONNECTOR },
  { slug: "export-bot-template", text: EXPORT_BOT_TEMPLATE },
  { slug: "import-bot-template", text: IMPORT_BOT_TEMPLATE },
  { slug: "learn-from-demonstration", text: LEARN_FROM_DEMONSTRATION },
];

/** The synthetic path a managed Skill is listed and loadable under. */
export function managedSkillPathV1(slug: string): string {
  return `${MANAGED_SKILL_PATH_PREFIX}/${slug}/${SKILL_FILE_NAME}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parses the bundled documents into loaded Skills.
 *
 * A malformed bundled document is a recorded refusal, never a throw. The
 * bodies here are first-party and reviewed, but a Turn that dies because one
 * of them was mis-edited would take the Bot's whole prompt with it, and a
 * loader with two failure modes has one too many: every other source in this
 * catalog answers a bad document with a refusal, and so does this one.
 *
 * The generation of a managed Skill is its content hash. There is no mutable
 * store to version it against — the bytes are the artifact's — so the hash is
 * the only honest name for "which one this Turn used", and the artifact set
 * hash the Composition pins is what makes that name reproducible.
 */
export async function loadManagedSkillsV1(
  documents: readonly ManagedSkillDocumentV1[] = MANAGED_SKILL_DOCUMENTS_V1,
): Promise<{ skills: LoadedSkillV1[]; refusals: SkillRefusalV1[] }> {
  const skills: LoadedSkillV1[] = [];
  const refusals: SkillRefusalV1[] = [];
  for (const document of documents) {
    const path = managedSkillPathV1(document.slug);
    if (!isSkillSlugV1(document.slug)) {
      refusals.push({
        path,
        kind: "malformed",
        reason: `the managed Skill slug "${document.slug}" is not a well-formed slug`,
      });
      continue;
    }
    const parsed = parseSkillDocumentV1(document.text);
    if (parsed.status !== "ok") {
      refusals.push({ path, kind: "malformed", reason: parsed.reason });
      continue;
    }
    const contentHash = await sha256Hex(document.text);
    skills.push({
      path,
      ref: { schemaVersion: 1, source: "managed", slug: document.slug },
      by: MANAGED_SKILL_ATTRIBUTION,
      name: parsed.document.name,
      description: parsed.document.description,
      body: parsed.document.body,
      generationId: contentHash,
      contentHash,
    });
  }
  return { skills, refusals };
}
