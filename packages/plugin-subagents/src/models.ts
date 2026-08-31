// Per-turn subagent model slugs.
//
// GrokBot injects `<available_subagent_models>` into the system prompt of every
// turn that may dispatch one, and `createTaskTool` reads the slug back out of
// the `model` argument (`docs/research/grokbot-computer.md` l.472–474). Two
// rules come with it: an automation turn holds exactly one slug — the Bot's own
// default binding, GrokBot's `sand-automation` — and an omitted `model`
// inherits the parent's binding rather than picking anything.
//
// A slug is `<packageId>/<providerModelId>`. It names an *Assignment*, not a
// provider: resolution runs against the Bot's enabled model Assignments, so a
// slug the Bot invents resolves to nothing and the dispatch is refused.

import type { TurnTypeV1 } from "@frockbot/kernel-contracts";
import {
  decodeTaskModelBindingV1,
  SubagentDecodeError,
  type TaskModelBindingV1,
  type TaskModelV1,
} from "./records.js";

/** Most slugs the prompt section will ever render. A catalog, not a directory. */
export const SUBAGENT_MODEL_CATALOG_LIMIT_V1 = 32;

/** One offerable model, projected from one enabled model Assignment. */
export interface SubagentModelOptionV1 {
  slug: string;
  binding: TaskModelBindingV1;
  /** True for the Bot's own durable binding: what an omitted `model` inherits. */
  isDefault: boolean;
}

export function subagentModelSlugV1(binding: {
  packageId: string;
  providerModelId: string;
}): string {
  return `${binding.packageId}/${binding.providerModelId}`;
}

/**
 * The turn types that may see more than one slug.
 *
 * An `automation` or `subagent` turn renders exactly one — the Bot's default
 * binding. It is not a permission (the Assignments are the same either way); it
 * is that an unattended Turn choosing a model per task is a decision with
 * nobody to answer for it.
 */
export function subagentModelsAreNarrowedV1(turnType: TurnTypeV1): boolean {
  return turnType === "automation" || turnType === "subagent";
}

/**
 * The catalog one Turn is offered.
 *
 * `assignments` are the Bot's enabled model Assignments, already resolved by
 * the Shell; `defaultBinding` is the Bot's own durable binding. A duplicate
 * slug is kept once — two Assignments naming one provider model are one choice.
 */
export function subagentModelCatalogV1(input: {
  assignments: readonly TaskModelBindingV1[];
  defaultBinding?: TaskModelBindingV1;
  turnType: TurnTypeV1;
}): SubagentModelOptionV1[] {
  const defaultSlug = input.defaultBinding
    ? subagentModelSlugV1(input.defaultBinding)
    : undefined;
  const seen = new Set<string>();
  const options: SubagentModelOptionV1[] = [];
  const consider = (binding: TaskModelBindingV1) => {
    const slug = subagentModelSlugV1(binding);
    if (seen.has(slug)) return;
    if (options.length >= SUBAGENT_MODEL_CATALOG_LIMIT_V1) return;
    seen.add(slug);
    options.push({ slug, binding, isDefault: slug === defaultSlug });
  };
  // The default first, so the one slug a narrowed turn renders is always the
  // Bot's own binding and never whichever Assignment happens to sort first.
  if (input.defaultBinding) consider(input.defaultBinding);
  if (!subagentModelsAreNarrowedV1(input.turnType)) {
    for (const assignment of input.assignments) consider(assignment);
  }
  return subagentModelsAreNarrowedV1(input.turnType)
    ? options.slice(0, 1)
    : options;
}

export type SubagentModelResolutionV1 =
  | { status: "resolved"; model: TaskModelV1 }
  | { status: "refused"; reason: string };

/**
 * The model one dispatch pins.
 *
 * An omitted slug inherits the parent's binding. A named slug must be in the
 * catalog this Turn was offered — a Bot that names a model it was not shown is
 * refused with the list it *was* shown, which is the honest answer and also the
 * one that repairs the next attempt.
 */
export function resolveSubagentModelV1(
  catalog: readonly SubagentModelOptionV1[],
  requested: string | undefined,
): SubagentModelResolutionV1 {
  if (requested === undefined) {
    const inherited = catalog.find((option) => option.isDefault) ?? catalog[0];
    if (!inherited) {
      return {
        status: "refused",
        reason:
          "this Bot has no enabled model Assignment, so a subagent has no model to run on",
      };
    }
    return {
      status: "resolved",
      model: { binding: inherited.binding, slug: inherited.slug },
    };
  }
  const match = catalog.find((option) => option.slug === requested);
  if (!match) {
    const offered = catalog.map((option) => option.slug).join(", ");
    return {
      status: "refused",
      reason:
        offered.length > 0
          ? `model "${requested}" is not one of this Turn's subagent models (${offered})`
          : `model "${requested}" is not available: this Bot has no enabled model Assignment`,
    };
  }
  return {
    status: "resolved",
    model: { binding: match.binding, slug: match.slug },
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The `<available_subagent_models>` block, in the shape
 * `renderSkillCatalogPromptV1` established: an element per entry, then the
 * sentences that say what the list is and what reading it does not authorize.
 * An empty catalog renders nothing at all rather than an empty element.
 */
export function renderAvailableSubagentModelsPromptV1(
  catalog: readonly SubagentModelOptionV1[],
): string {
  if (catalog.length === 0) return "";
  const entries = catalog.map((option) => {
    const attributes = [
      `slug="${escapeAttribute(option.slug)}"`,
      `provider="${escapeAttribute(option.binding.provider)}"`,
      ...(option.isDefault ? ['default="true"'] : []),
    ].join(" ");
    return `  <model ${attributes} />`;
  });
  return [
    "<available_subagent_models>",
    ...entries,
    "</available_subagent_models>",
    "These are the models a subagent you dispatch may run on. Pass one slug as the Task tool's `model`.",
    "Omit `model` and the subagent inherits the model you are running on.",
  ].join("\n");
}

/**
 * Decodes a model binding that crossed the Shell seam. The Shell resolves it
 * from the Bot's own configuration and the User's Connection; this Package
 * accepts nothing else, and never anything a Bot supplied.
 */
export function decodeSubagentModelBindingV1(
  value: unknown,
  label = "subagent model binding",
): TaskModelBindingV1 {
  try {
    return decodeTaskModelBindingV1(value, label);
  } catch (error) {
    throw error instanceof SubagentDecodeError
      ? error
      : new SubagentDecodeError(`${label} is invalid`);
  }
}
