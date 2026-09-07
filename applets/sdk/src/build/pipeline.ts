/**
 * The whole Applet build, as five named stages over one directory.
 *
 * `applet check` and `applet build` are two entry points onto these stages;
 * the cloud build service is a third. There is one implementation of each, so
 * a Bot that checks its Applet locally and a publish that builds it in the
 * cloud cannot disagree about whether the code is admissible or about what it
 * hashes to.
 *
 * A stage that fails stops the run and names itself, which is what turns a
 * wall of diagnostics into "your `server.ts` does not type-check". The two
 * stages that produce no diagnostic list of their own — `bundle` and
 * `describe` — report the thrown message as one diagnostic against
 * `applet.json`, so a caller has one shape to render.
 */

import { lintApplet, type AppletDiagnostic } from "../lint/index.js";
import { buildAppletArtifacts, type AppletArtifactsV1 } from "./artifacts.js";
import { typeCheckApplet } from "./check.js";
import { readDescriptor } from "./manifest.js";

export type AppletBuildStage =
  "descriptor" | "typecheck" | "lint" | "bundle" | "describe";

export type AppletBuildOutcome =
  | { status: "checked" }
  | ({ status: "built" } & AppletArtifactsV1)
  | {
      status: "failed";
      stage: AppletBuildStage;
      diagnostics: AppletDiagnostic[];
    };

/** A thrown stage failure, reported at `applet.json` for want of a position. */
function thrown(error: unknown): AppletDiagnostic[] {
  return [
    {
      file: "applet.json",
      line: 1,
      column: 1,
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
    },
  ];
}

function hasError(diagnostics: AppletDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export interface AppletBuildPipelineOptions {
  /** `check` stops after the linter; `build` goes on to the artifacts. */
  mode: "check" | "build";
}

export async function runAppletBuildV1(
  directory: string,
  options: AppletBuildPipelineOptions,
): Promise<AppletBuildOutcome> {
  try {
    await readDescriptor(directory);
  } catch (error) {
    return {
      status: "failed",
      stage: "descriptor",
      diagnostics: thrown(error),
    };
  }

  const types = await typeCheckApplet(directory);
  if (hasError(types)) {
    return { status: "failed", stage: "typecheck", diagnostics: types };
  }
  const lint = await lintApplet(directory);
  if (hasError(lint)) {
    return { status: "failed", stage: "lint", diagnostics: lint };
  }
  if (options.mode === "check") return { status: "checked" };

  let artifacts: AppletArtifactsV1;
  try {
    artifacts = await buildAppletArtifacts(directory);
  } catch (error) {
    // `describe` is the only stage that boots the built module, and both of
    // its failures say so in their own words; anything else thrown here came
    // out of the bundler.
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      stage: /^The Applet (failed to mount|could not describe)/.test(message)
        ? "describe"
        : "bundle",
      diagnostics: thrown(error),
    };
  }
  return { status: "built", ...artifacts };
}
