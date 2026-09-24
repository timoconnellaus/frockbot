// A demonstration, as the files a Bot is handed to learn from (parity row 54).
//
// The Computer hands back a capture: steps and a few screenshots. The person
// sends it to their Bot as an ordinary message carrying files, so it becomes
// exactly that — one JSON document, the step log, and one JPEG per
// screenshot. The document is rebuilt here field by field from decoded steps,
// so nothing reaches the Bot that the step decoder did not admit, and it says
// in its own words what was and was not recorded, because the Bot has to know
// that a typed value is missing on purpose rather than lost.
import type {
  ComputerDemonstrationCaptureV1,
  ComputerDemonstrationStepV1,
} from "@frockbot/computer/core/host";

/** One file a demonstration becomes. */
export interface ComputerDemonstrationFileV1 {
  name: string;
  mediaType: "application/json" | "image/jpeg";
  bytes: Uint8Array;
  /** The document's text, for a model request to read. */
  text?: string;
}

/** What the log says was left out, for the Bot and for the person. */
export const COMPUTER_DEMONSTRATION_RECORDED_V1 =
  "Only what was done in the Computer's browser, in this Bot's own window, was recorded; other apps on the desktop were not. What was typed, which option was chosen in a list, and anything done in a password, one-time-code or card-number field were never recorded. Every screenshot covers the page's form fields.";

const ABOUT =
  "A demonstration the person recorded on the Computer so you can learn the task. Load the managed/write-skill Skill and its demonstration.md reference, draft a Skill from these steps and screenshots, and ask the person before you save it.";

/** The name of a demonstration's log. */
export function computerDemonstrationLogNameV1(id: string): string {
  return `demonstration-${id}.json`;
}

function stepLine(step: ComputerDemonstrationStepV1, index: number): string {
  const common = { step: index + 1, t: step.t, tab: step.tab };
  switch (step.action) {
    case "navigate":
    case "switch-tab":
      return JSON.stringify({ ...common, action: step.action, url: step.url });
    case "click":
    case "type":
    case "choose":
      return JSON.stringify({
        ...common,
        action: step.action,
        role: step.role,
        ...(step.name === undefined ? {} : { name: step.name }),
        selector: step.selector,
      });
    case "key":
      return JSON.stringify({ ...common, action: "key", key: step.key });
  }
}

/**
 * The files a capture becomes: the log first, then its screenshots, which is
 * the order a message carries them in. At most five, the most one message
 * may carry.
 */
export function computerDemonstrationFilesV1(
  id: string,
  capture: ComputerDemonstrationCaptureV1,
): ComputerDemonstrationFileV1[] {
  const screenshots = capture.screenshots.map((shot, index) => ({
    name: `demonstration-${id}-screenshot-${index + 1}.jpg`,
    afterStep: shot.afterStep,
    bytes: shot.bytes,
  }));
  const header = {
    demonstration: id,
    about: ABOUT,
    recorded: COMPUTER_DEMONSTRATION_RECORDED_V1,
    startedAt: capture.startedAt,
    stoppedAt: capture.stoppedAt,
    stoppedBecause: capture.stoppedBecause,
    ...(capture.dropped > 0 ? { stepsLeftOut: capture.dropped } : {}),
  };
  const lines = [
    "{",
    ...Object.entries(header).map(
      ([key, value]) => ` ${JSON.stringify(key)}: ${JSON.stringify(value)},`,
    ),
    ' "steps": [',
    capture.steps
      .map((step, index) => `  ${stepLine(step, index)}`)
      .join(",\n"),
    " ],",
    ' "screenshots": [',
    screenshots
      .map(
        (shot) =>
          `  ${JSON.stringify({ file: shot.name, afterStep: shot.afterStep })}`,
      )
      .join(",\n"),
    " ]",
    "}",
  ];
  const text = `${lines.join("\n")}\n`;
  return [
    {
      name: computerDemonstrationLogNameV1(id),
      mediaType: "application/json",
      bytes: new TextEncoder().encode(text),
      text,
    },
    ...screenshots.map((shot) => ({
      name: shot.name,
      mediaType: "image/jpeg" as const,
      bytes: shot.bytes,
    })),
  ];
}
