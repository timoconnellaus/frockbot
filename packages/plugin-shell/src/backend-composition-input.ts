import type { CompositionFailureV1 } from "@frockbot/kernel-composition/activation";
import type { CompositionGenerationV1 } from "@frockbot/kernel-composition/generation";

/**
 * Model-visible durable input for the Turn that fell back from a broken
 * Composition. The caller places this exact text in `user/message`, from
 * which the exact recorded `model/request` is reconstructed.
 */
export function compositionFailureDurableInputV1(input: {
  attemptedGenerationId: string;
  generation?: CompositionGenerationV1;
  failure?: CompositionFailureV1;
  quarantined: boolean;
}): string {
  const origin = input.generation?.origin;
  const authoredPackageId =
    origin?.kind === "bot-authored"
      ? input.generation?.members.find(
          (member) =>
            member.provenance.kind === "bot" &&
            member.provenance.runId === origin.runId,
        )?.packageId
      : undefined;
  const failure = input.failure;
  const packageId =
    authoredPackageId ??
    failure?.message.match(/package "([^"]+)"/i)?.[1] ??
    (input.generation?.members.filter(
      (member) => member.provenance.kind === "bot",
    ).length === 1
      ? input.generation.members.find(
          (member) => member.provenance.kind === "bot",
        )?.packageId
      : undefined);
  const diagnostics = failure?.diagnostics.length
    ? failure.diagnostics.map((entry) => `- ${entry}`).join("\n")
    : "- none";
  return [
    "[Durable Package activation failure]",
    `Generation: ${input.attemptedGenerationId}`,
    `Package: ${packageId ?? "unknown"}`,
    `Phase: ${failure?.phase ?? "resolve"}`,
    `Message: ${failure?.message ?? "This quarantined generation remains unavailable."}`,
    "Diagnostics:",
    diagnostics,
    input.quarantined
      ? "Status: quarantined after repeated activation failures; the last working Package setup was mounted. Author a repair or use package_undo."
      : "Status: activation failed; the last working Package setup was mounted for this Turn. Author a repair or use package_undo.",
  ].join("\n");
}

/** The exact command text handed to the Agent loop on a fallback Turn. */
export function compositionFailureTurnTextV1(
  ordinaryInput: string,
  failure: Parameters<typeof compositionFailureDurableInputV1>[0],
): string {
  return `${compositionFailureDurableInputV1(failure)}\n\n${ordinaryInput}`;
}
