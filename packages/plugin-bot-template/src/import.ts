// Planning an import: the read-only half, and the step list the apply walks.
//
// NOTHING HERE APPLIES ANYTHING. Planning is a pure function of the template
// and the importing User's own durable state, which is what makes the review
// card honest: the User is shown exactly the steps the apply will take, and the
// apply takes exactly those steps.
//
// THIS DEPLOYMENT'S PACKAGES ARE THE ONLY INDEX CONSULTED. A `packageId` this
// deployment does not compile in is a **missing** line, never an install of
// something the application cannot execute.
//
// WHAT IMPORT NEVER CREATES. No Connection or credential. An enabled Package
// is available account-wide, while Connections remain the importing User's
// explicit choice. A template is a recipe that stops at that authority
// boundary. Every server it names becomes a line on the card telling the User
// what they would have to connect themselves.
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
  packageId: string;
  displayName: string;
  version: string;
  status: TemplateImportPackageStatusV1;
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
  /** The `packageId`, Skill slug or Routine slug this step acts on. */
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
  steps: TemplateImportStepV1[];
}

/** One installed Package, as the importing User's settings record it. */
export interface ImportingInstallationV1 {
  packageId: string;
  state: "installed" | "disabled" | "failed";
}

export interface TemplateImportPlanInputV1 {
  importId: string;
  shareId: string;
  hash: string;
  botId: string;
  template: BotTemplateV1;
  installedPackages: readonly ImportingInstallationV1[];
  /** Every `packageId` this deployment's compiled application offers. */
  availablePackageIds: readonly string[];
}

function packageLines(
  input: TemplateImportPlanInputV1,
): TemplateImportPackageLineV1[] {
  const installed = new Set(
    input.installedPackages
      .filter((entry) => entry.state !== "failed")
      .map((entry) => entry.packageId),
  );
  const available = new Set(input.availablePackageIds);
  return input.template.packages.map((entry) => ({
    packageId: entry.packageId,
    displayName: entry.displayName,
    version: entry.version,
    status: installed.has(entry.packageId)
      ? ("already-installed" as const)
      : available.has(entry.packageId)
        ? ("will-install" as const)
        : // Not a Package this deployment compiles in. It is reported as a gap
          // the User can see, never installed.
          ("missing" as const),
  }));
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
        key: `install:${entry.packageId}`,
        kind: "user/install-package" as const,
        subject: entry.packageId,
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
      ? `${missing} Package(s) are not available in this deployment and will be skipped.`
      : "",
    "No Connection or credential is created by an import.",
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
