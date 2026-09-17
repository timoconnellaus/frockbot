// How the kernel draws one of the locked first-party Cards (ADR 0030 step 7).
//
// The five rich things `send_to_user` could say before Cards existed —
// `approval`, `widget`, `attachment`, `secret-request` and `agent-card` — are
// drawn by locked seeded Plugins now, so first-party takes exactly the path a
// customisation takes: a descriptor's `cards` entry, a `renderCard` in an
// untrusted worker, and the same seam that folds a Plugin's card into the
// Session.
//
// The Shell owns the send and the Plugin host owns the worker, and neither
// may import the other. So the host puts this on the runtime when it mounts,
// and the Shell's send seam reads it: the same shape the `credentials` field
// already has on the foundation runtime, for the same reason.
import type { ToolExecutionContext } from "./tool-execution.js";

/** One draw the kernel asks a locked Plugin for. */
export interface FirstPartyCardDrawV1 {
  pluginId: string;
  cardId: string;
  /** Already shaped for the card's declared `dataSchema`; the seam validates. */
  data: Record<string, unknown>;
  /**
   * The Approvals the kernel has already recorded, in the order the surface's
   * `ApprovalActions` bind to them.
   *
   * Only the `approval` mapping carries this. An `approval` send is still the
   * kernel's own record under the id the Bot chose — the id its Machine
   * command, its Plugin intent and the durable input its next Turn receives
   * are all keyed by — so the Card is bound to that decision rather than
   * being asked to mint a second one over the same question.
   */
  approvalIds?: readonly string[];
}

/** What the draw did. A refusal is a sentence, never a throw. */
export type FirstPartyCardDrawOutcomeV1 =
  | { status: "drawn"; surfaceId: string }
  | { status: "unavailable"; reason: string };

/**
 * Set by the Plugin host when it mounts; read by the Shell's send seam.
 *
 * Absent on a host that cannot run Plugins at all, which is what makes the
 * fallback line rather than the card the thing the person reads there.
 */
export interface FirstPartyCardDrawsV1 {
  draw(
    request: FirstPartyCardDrawV1,
    context: ToolExecutionContext,
  ): Promise<FirstPartyCardDrawOutcomeV1>;
}
