// Planning an import: the read-only half, and the step list the apply walks.
//
// NOTHING HERE APPLIES ANYTHING. Planning is a pure function of the template
// and the importing User's own durable state, which is what makes the review
// card honest: the User is shown exactly the steps the apply will take, and the
// apply takes exactly those steps.
//
// THE PINNED GENERATION IS THE ONLY INDEX CONSULTED. A `catalogId` absent from
// the generation this User is pinned to is a **missing** line, never an install
// off a moved index: "Composition consumes immutable, content-addressed
// artifacts", and an install validated against anything else is not that.
//
// WHAT IMPORT NEVER CREATES. No Connection and no Assignment. "Package
// availability is User-level. A Bot receives authority solely through an
// explicit, durable Assignment and, when required, a Connection." A template is
// a recipe; granting authority off the back of one would be the recipe handing
// itself permissions. Every server the template names becomes a line on the
// card telling the User what they would have to connect themselves.
import type {
  BotTemplateV1,
  TemplateSheepRecipeV1,
  TemplateSkillV1,
  TemplateRoutineV1,
} from "@frockbot/template-core";
import { TemplateDecodeError } from "@frockbot/template-core";

export type TemplateImportPackageStatusV1 =
  "will-install" | "already-installed" | "missing";

export interface TemplateImportPackageLineV1 {
  catalogId: string;
  packageId: string;
  displayName: string;
  version: string;
  status: TemplateImportPackageStatusV1;
}

/** One server the importer would have to connect themselves. */
export interface TemplateImportConnectionLineV1 {
  name: string;
  connectionTypeId?: string;
  /** Present only for a public server; a placeholder carries no address. */
  url?: string;
  hint?: string;
}

export type TemplateImportStepKindV1 =
  | "bot/create"
  | "user/install-package"
  | "skill/write"
  | "routine/create"
  | "routine/disable";

export interface TemplateImportStepV1 {
  /** Stable across replays: it is what a receipt is filed under. */
  key: string;
  kind: TemplateImportStepKindV1;
  /** The `catalogId`, Skill slug or Routine slug this step acts on. */
  subject?: string;
}

export interface TemplateImportPlanV1 {
  schemaVersion: 1;
  importId: string;
  shareId: string;
  hash: string;
  /** The Bot this import would create. Derived, so a replay asks for the same. */
  botId: string;
  profile: { name: string; title?: string; description?: string };
  sheep: TemplateSheepRecipeV1;
  skills: TemplateSkillV1[];
  routines: TemplateRoutineV1[];
  packages: TemplateImportPackageLineV1[];
  connections: TemplateImportConnectionLineV1[];
  /** The generation the plan was diffed against; absent when unpinned. */
  catalogGeneration?: string;
  steps: TemplateImportStepV1[];
}

/** One installed Package, as the importing User's settings record it. */
export interface ImportingInstallationV1 {
  packageId: string;
  state: "installed" | "disabled" | "failed";
  catalogId?: string;
}

export interface TemplateImportPlanInputV1 {
  importId: string;
  shareId: string;
  hash: string;
  botId: string;
  template: BotTemplateV1;
  installedPackages: readonly ImportingInstallationV1[];
  /** The importing User's own pin. Absent leaves every Package `missing`. */
  catalogGeneration?: string;
  /** Every `catalogId` the pinned generation's index holds. */
  availableCatalogIds: readonly string[];
}

function packageLines(
  input: TemplateImportPlanInputV1,
): TemplateImportPackageLineV1[] {
  const installed = new Set(
    input.installedPackages
      .filter((entry) => entry.state !== "failed" && entry.catalogId)
      .map((entry) => entry.catalogId as string),
  );
  const available = new Set(input.availableCatalogIds);
  return input.template.packages.map((entry) => ({
    catalogId: entry.catalogId,
    packageId: entry.packageId,
    displayName: entry.displayName,
    version: entry.version,
    status: installed.has(entry.catalogId)
      ? ("already-installed" as const)
      : input.catalogGeneration && available.has(entry.catalogId)
        ? ("will-install" as const)
        : // Not in the generation this User is pinned to. It is reported as a
          // gap the User can close, never installed off an index that moved.
          ("missing" as const),
  }));
}

function connectionLines(
  template: BotTemplateV1,
): TemplateImportConnectionLineV1[] {
  // Every server is a line, public ones included: the import creates no
  // Connection at all, so even a server whose address travelled is still
  // something the importing User has to connect for themselves.
  return template.mcpServers.map((server) =>
    server.kind === "public"
      ? {
          name: server.name,
          url: server.url,
          hint: "Add this server as your own Connection to use it.",
        }
      : {
          name: server.name,
          connectionTypeId: server.connectionTypeId,
          ...(server.hint === undefined ? {} : { hint: server.hint }),
        },
  );
}

/**
 * The steps one apply will take, in order.
 *
 * The Bot first, because everything else is written into it; installs next, so
 * a Skill that leans on a Package finds it there; then Skills and Routines. A
 * webhook Routine is created and then disabled, because a Routine is created
 * enabled and a webhook one has no key in this deployment yet — an imported
 * Routine that fired on a stranger's schedule with no key would be a surprise,
 * not a feature.
 */
function importSteps(
  plan: Omit<TemplateImportPlanV1, "steps">,
  packages: TemplateImportPackageLineV1[],
): TemplateImportStepV1[] {
  return [
    { key: "bot/create", kind: "bot/create" as const },
    ...packages
      .filter((entry) => entry.status === "will-install")
      .map((entry) => ({
        key: `install:${entry.catalogId}`,
        kind: "user/install-package" as const,
        subject: entry.catalogId,
      })),
    ...plan.skills.map((skill) => ({
      key: `skill:${skill.slug}`,
      kind: "skill/write" as const,
      subject: skill.slug,
    })),
    ...plan.routines.flatMap((routine) => [
      {
        key: `routine:${routine.slug}`,
        kind: "routine/create" as const,
        subject: routine.slug,
      },
      ...(routine.triggerKind === "webhook"
        ? [
            {
              key: `routine-disable:${routine.slug}`,
              kind: "routine/disable" as const,
              subject: routine.slug,
            },
          ]
        : []),
    ]),
  ];
}

export function planBotTemplateImportV1(
  input: TemplateImportPlanInputV1,
): TemplateImportPlanV1 {
  const packages = packageLines(input);
  const base: Omit<TemplateImportPlanV1, "steps"> = {
    schemaVersion: 1,
    importId: input.importId,
    shareId: input.shareId,
    hash: input.hash,
    botId: input.botId,
    profile: {
      name: input.template.profile.name,
      ...(input.template.profile.title === undefined
        ? {}
        : { title: input.template.profile.title }),
      ...(input.template.profile.description === undefined
        ? {}
        : { description: input.template.profile.description }),
    },
    sheep: input.template.profile.avatar.recipe,
    skills: input.template.skills,
    routines: input.template.routines,
    packages,
    connections: connectionLines(input.template),
    ...(input.catalogGeneration === undefined
      ? {}
      : { catalogGeneration: input.catalogGeneration }),
  };
  return { ...base, steps: importSteps(base, packages) };
}

/**
 * The Bot id one import asks for.
 *
 * Derived from the importing User and the import's own id, so a replay after
 * eviction asks for the *same* Bot and collides with the one it already made
 * rather than registering a second. Exactly the fence `plugin-flock`'s
 * `bot_create` uses, for exactly the same reason. The readable half is the
 * template's name, because names become roles.
 */
export async function importedBotIdV1(
  userId: string,
  importId: string,
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "bot";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${userId} ${importId}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${base}-${hex.slice(0, 12)}`;
}

/** The Routine id an imported Routine takes, stable across replays. */
export function importedRoutineIdV1(importId: string, slug: string): string {
  const id = `${importId}-${slug}`.replace(/[^a-zA-Z0-9._:-]/g, "-");
  return id.slice(0, 120);
}

/** One line of the review card, as prose. */
export function describeImportPlanV1(plan: TemplateImportPlanV1): string {
  const missing = plan.packages.filter(
    (entry) => entry.status === "missing",
  ).length;
  const installing = plan.packages.filter(
    (entry) => entry.status === "will-install",
  ).length;
  return [
    `Will create the Bot "${plan.profile.name}" with ${plan.skills.length} Skill(s) and ${plan.routines.length} Routine(s).`,
    installing > 0 ? `Will install ${installing} Package(s).` : "",
    missing > 0
      ? `${missing} Package(s) are missing from your catalog and will be skipped.`
      : "",
    plan.connections.length > 0
      ? `${plan.connections.length} server(s) need your own Connection; none is created for you.`
      : "",
    "No Connection and no Assignment is created by an import.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function assertImportPlanMatchesV1(
  plan: TemplateImportPlanV1,
  expected: { shareId: string; hash: string },
): void {
  if (plan.shareId !== expected.shareId || plan.hash !== expected.hash) {
    throw new TemplateDecodeError(
      "the import plan does not match the template it was planned from",
    );
  }
}
