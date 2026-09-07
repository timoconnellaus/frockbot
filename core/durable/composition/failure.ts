// Why a Composition member failed to come up, named by the load site it failed
// at. The host raises it; the Durable Object's activation records it.

/**
 * Where activation gave up. `resolve` is the artifact read, `mount` is
 * `LOADER.get` and the first RPC into the loaded Worker, `health` is a mounted
 * isolate that answered but failed its declared check. `bundle` is the
 * authoring-time site.
 */
export type CompositionFailurePhaseV1 =
  "resolve" | "bundle" | "mount" | "health";

export const COMPOSITION_FAILURE_PHASES_V1: readonly CompositionFailurePhaseV1[] =
  ["resolve", "bundle", "mount", "health"];

export const MAX_COMPOSITION_DIAGNOSTICS_V1 = 32;
export const MAX_COMPOSITION_DIAGNOSTIC_LENGTH_V1 = 2_000;

/**
 * A mount or verification failure that names the load site it came from, so
 * the recorded `phase` is evidence rather than a guess.
 */
export class CompositionMountFailureError extends Error {
  readonly phase: CompositionFailurePhaseV1;
  readonly diagnostics: string[];

  constructor(
    phase: CompositionFailurePhaseV1,
    message: string,
    diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = "CompositionMountFailureError";
    this.phase = phase;
    this.diagnostics = [...diagnostics].slice(
      0,
      MAX_COMPOSITION_DIAGNOSTICS_V1,
    );
  }
}
