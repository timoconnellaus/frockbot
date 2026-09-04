/**
 * What the Bot is doing to the focused Applet, in words a person reads.
 *
 * Building an Applet takes minutes: the Bot scaffolds it, edits the files on
 * the Computer, runs `applet check` and `applet build` there, and only then
 * publishes it. Until that publish lands there is nothing to run, so the
 * canvas beside the conversation used to say "Not published yet" for the whole
 * of it — true, unchanging, and no help to somebody watching. This module is
 * the missing sentence: it reads what the client already knows and returns the
 * one line that says where the work has got to.
 *
 * It is a projection, never an authority. Nothing here is stored, nothing here
 * is asked of the backend, and every input is something the thread was already
 * drawing. When the signals say nothing specific, the answer is the honest
 * fallback rather than an invented step.
 */
import type {
  AppletBuildViewV1,
  AppletSourceViewV1,
  AppletSummaryV1,
} from "@frockbot/kernel-contracts";
import type { WebChatMessage, WebToolActivity } from "../shared.js";

/**
 * Where the work has got to.
 *
 * The order is the order the Bot does them in, and the projection takes the
 * furthest one it has evidence for. `unknown` is a draft with nothing said
 * about it yet — the Bot has been asked, and the Turn that answers has not
 * reached the Applet.
 */
export type AppletProgressStageV1 =
  | "unknown"
  | "created"
  | "writing"
  | "checking"
  | "building"
  | "publishing"
  | "published";

/** The tail of a check or a build, so a long log never fills the panel. */
export const APPLET_PROGRESS_OUTPUT_LINES_V1 = 12;
export const APPLET_PROGRESS_LINE_CHARACTERS_V1 = 200;
/** A failure is a sentence in the panel, not a wall of text. */
export const APPLET_PROGRESS_FAILURE_CHARACTERS_V1 = 400;

export interface AppletProgressV1 {
  stage: AppletProgressStageV1;
  /** The line the canvas and the phone both show. */
  label: string;
  /** True while the Turn doing this is still going. */
  working: boolean;
  /** True when this step finished and finished cleanly. */
  done: boolean;
  /** What went wrong, in the words of whatever refused. */
  failure?: string;
  /** The last lines the check or the build printed. */
  output?: string[];
}

export interface AppletProgressInputV1 {
  /** The focused Applet's directory entry, when there is one. */
  applet?: AppletSummaryV1 | null;
  /** The Applet's source, as the canvas already reads it. */
  source?: AppletSourceViewV1;
  /** The outcome the Applet authority recorded, when it has recorded one. */
  build?: AppletBuildViewV1;
  /** The newest Turn's tool activity, oldest first. */
  tools?: readonly WebToolActivity[];
  /** True while that Turn is still running. */
  running?: boolean;
}

/**
 * The words for each step, and for the step having finished.
 *
 * A check that has come back clean is worth its own sentence: "Checking the
 * code" would keep saying a thing was happening after it stopped happening.
 */
const LABELS: Record<AppletProgressStageV1, { doing: string; done: string }> = {
  // Matches the Applets list, which says "Still being built" for a draft.
  unknown: { doing: "Still being built", done: "Still being built" },
  created: { doing: "Just getting started", done: "Just getting started" },
  writing: { doing: "Writing the code", done: "Writing the code" },
  checking: { doing: "Checking the code", done: "The code checks out" },
  building: {
    doing: "Putting it together",
    done: "Built and ready to go live",
  },
  publishing: {
    doing: "Getting it ready to open",
    done: "Getting it ready to open",
  },
  published: { doing: "Ready to use", done: "Ready to use" },
};

const ORDER: AppletProgressStageV1[] = [
  "unknown",
  "created",
  "writing",
  "checking",
  "building",
  "publishing",
  "published",
];

function furthest(
  left: AppletProgressStageV1,
  right: AppletProgressStageV1,
): AppletProgressStageV1 {
  return ORDER.indexOf(right) > ORDER.indexOf(left) ? right : left;
}

/** The bare tool name, whether it arrived namespaced or native. */
function toolName(activity: WebToolActivity): string {
  const slash = activity.name.lastIndexOf("/");
  return slash < 0 ? activity.name : activity.name.slice(slash + 1);
}

/**
 * Whether this tool call is about the Applet in the canvas.
 *
 * A dynamic call carries its parsed arguments, so a publish of some other
 * Applet never moves this one's line. `applet_create` names no id — it is
 * making one — so it counts for whichever Applet the Session then focuses,
 * which is the one it just created.
 */
function namesApplet(activity: WebToolActivity, appletId: string): boolean {
  const input = activity.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return true;
  const named = (input as Record<string, unknown>).appletId;
  return typeof named === "string" ? named === appletId : true;
}

function trimLine(line: string): string {
  return line.length > APPLET_PROGRESS_LINE_CHARACTERS_V1
    ? `${line.slice(0, APPLET_PROGRESS_LINE_CHARACTERS_V1 - 1)}…`
    : line;
}

function tail(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-APPLET_PROGRESS_OUTPUT_LINES_V1).map(trimLine);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > APPLET_PROGRESS_FAILURE_CHARACTERS_V1
    ? `${trimmed.slice(0, APPLET_PROGRESS_FAILURE_CHARACTERS_V1 - 1)}…`
    : trimmed;
}

/**
 * Whether a shell command's output is the `applet` CLI reporting on itself.
 *
 * The client is never told what a `computer_exec` ran: the Turn projection
 * carries the input of dynamic tool calls only, and `computer_exec` is a
 * native tool. What it does carry is the result, and the CLI's output is a
 * stated contract — `applet check:` on one line, and the three `dist/` paths a
 * build writes — so recognising it is reading a published shape rather than
 * guessing at a command. Anything else the Bot ran on the Computer looks like
 * nothing here and is ignored, which is the right failure: no line rather than
 * a wrong one.
 */
export function appletCommandOutputV1(
  text: string | undefined,
): { command: "check" | "build"; output: string[] } | undefined {
  if (!text) return undefined;
  if (/^applet check:/m.test(text)) {
    return { command: "check", output: tail(text) };
  }
  if (/dist\/manifest\.json\b/.test(text) && /dist\/server\.js\b/.test(text)) {
    return { command: "build", output: tail(text) };
  }
  return undefined;
}

/** Whether the `applet check` output the CLI printed found errors. */
function checkFailed(text: string): boolean {
  return /^applet check: \d+ error/m.test(text);
}

/**
 * The one line about the focused Applet, and what sits under it.
 *
 * Returns `undefined` when there is no Applet in the canvas to say it about.
 */
export function appletProgressV1(
  input: AppletProgressInputV1,
): AppletProgressV1 | undefined {
  const applet = input.applet;
  if (!applet) return undefined;

  let stage: AppletProgressStageV1 = "unknown";
  let failure: string | undefined;
  let output: string[] | undefined;
  let done = false;

  // The directory entry is the settled fact: a generation is current, so the
  // Applet runs. A Turn working on it now moves the line off this again.
  if (applet.currentGenerationId) {
    stage = "published";
    done = true;
  }

  // What the Applet authority recorded, where it has recorded anything. It is
  // read before the Turn's own evidence so a running Turn wins.
  const recorded = input.build;
  if (recorded && recorded.status !== "unknown") {
    stage = furthest(
      stage,
      recorded.command === "build" ? "building" : "checking",
    );
    done = recorded.status === "passed";
    if (recorded.status === "failed") {
      failure = sentence(recorded.summary ?? "The last check did not pass.");
      if (recorded.diagnostics && recorded.diagnostics.length > 0) {
        output = recorded.diagnostics
          .slice(-APPLET_PROGRESS_OUTPUT_LINES_V1)
          .map(trimLine);
      }
    }
  }

  // Source on the Workspace means the Bot has written files, whether or not
  // this Turn is the one that wrote them.
  if ((input.source?.files.length ?? 0) > 0) stage = furthest(stage, "writing");

  let working = false;
  for (const activity of input.tools ?? []) {
    const name = toolName(activity);
    if (name === "computer_exec") {
      const ran = appletCommandOutputV1(activity.text);
      if (activity.status === "running") {
        // A shell command in flight during a build is the Bot working on the
        // Applet; which command it is only becomes knowable when it returns.
        working = true;
        done = false;
        continue;
      }
      if (!ran) continue;
      stage = furthest(
        stage,
        ran.command === "build" ? "building" : "checking",
      );
      output = ran.output;
      const wrong =
        activity.status === "failed" ||
        (ran.command === "check" && checkFailed(activity.text ?? ""));
      failure = wrong
        ? ran.command === "build"
          ? "Putting it together did not work."
          : "The code has problems that need fixing."
        : undefined;
      done = !wrong;
      continue;
    }
    if (!namesApplet(activity, applet.appletId)) continue;
    if (name === "applet_create") {
      stage = furthest(stage, "created");
      if (activity.status === "running") {
        working = true;
        done = false;
      } else if (activity.status === "failed") {
        failure = sentence(activity.text ?? "This Applet could not be made.");
        done = false;
      } else done = true;
      continue;
    }
    if (name === "applet_publish") {
      if (activity.status === "running") {
        stage = furthest(stage, "publishing");
        working = true;
        failure = undefined;
        done = false;
        continue;
      }
      if (activity.status === "failed") {
        stage = furthest(stage, "publishing");
        failure = sentence(
          activity.text ?? "It could not be made ready to open.",
        );
        done = false;
        continue;
      }
      stage = furthest(stage, "published");
      failure = undefined;
      done = true;
      continue;
    }
  }

  if (input.running) working = true;

  return {
    stage,
    label: done ? LABELS[stage].done : LABELS[stage].doing,
    working,
    done,
    ...(failure ? { failure } : {}),
    ...(output && output.length > 0 ? { output } : {}),
  };
}

/**
 * The tool activity the line is read from: every Turn's, oldest first.
 *
 * Not just the Turn that is running. Building an Applet takes several Turns —
 * the Bot writes, checks, fixes, builds, publishes, and the User says things
 * in between — and the last thing that happened to the Applet is what a person
 * wants to know, whether or not it happened in the Turn still open. The
 * reducer takes the last relevant activity, so a settled failure stays on
 * screen until something newer replaces it.
 */
export function appletProgressToolsV1(
  messages: readonly Pick<WebChatMessage, "role" | "tools">[],
): WebToolActivity[] {
  const tools: WebToolActivity[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    tools.push(...message.tools);
  }
  return tools;
}

/**
 * Whether the canvas should be showing the building view rather than the
 * Applet. A published Applet with a Turn working on it keeps showing what it
 * has: replacing a working Applet with a progress line takes something away.
 */
export function appletIsBeingBuiltV1(
  progress: AppletProgressV1 | undefined,
): boolean {
  return Boolean(progress && progress.stage !== "published");
}
