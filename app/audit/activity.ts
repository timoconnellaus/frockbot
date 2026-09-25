// The Activity page: the audit table as a person reads it.
//
// The conversation shows what was said, and nothing of how a Bot got there.
// This is the one place a person sees what their Bots did outside it — mail
// sent, services called, commands run, a device used — so each row is a plain
// sentence about one Turn's effects in one place, written here rather than on
// the device, so every client says the same thing.
//
// The projection still infers nothing about an outcome. A row whose effects
// the durable log cannot explain says "Outcome unknown" beside it; a failure
// says it failed. The two judgements it does make are presentational and
// fail safe: a row is drawn quietly only when every tool it ran is one that
// reads, and "You approved" only when the tool refuses to run unapproved.
import {
  decodeProtocol,
  type ActivityPage,
  type ActivityRow,
} from "@frockbot/core/protocol-schemas";
import { EMAIL_OWNER_TOOL, EMAIL_SEND_TOOL } from "./classify.js";
import {
  AUDIT_TARGET_COMPUTER_V1,
  AUDIT_TARGET_DEVICE_PREFIX_V1,
  AUDIT_TARGET_MACHINE_PREFIX_V1,
  AUDIT_TARGET_REMOTE_PREFIX_V1,
  AUDIT_TARGET_WORKSPACE_V1,
  type AuditActivityGroupV1,
  type AuditActivityPageV1,
} from "./shared.js";

/** The device kinds a client reports, in the words the person uses. */
const DEVICE_LABELS: Record<string, string> = {
  web: "Web browser",
  android: "Android",
  ios: "iPhone",
  macos: "Mac",
  windows: "Windows",
  linux: "Linux",
};

/**
 * The first words of a tool name that only read.
 *
 * Deliberately short. A tool this misses is drawn at full strength, which is
 * the right way to be wrong on a page about what changed.
 */
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "find",
  "query",
  "describe",
  "lookup",
  "view",
  "retrieve",
]);

/** Host labels that name a protocol or a tier rather than the service. */
const HOST_NOISE = new Set(["mcp", "api", "www", "app", "server"]);

function capitalise(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/** A tool's own name, as words: `mcp-notion/createPage` is "create page". */
export function toolWordsV1(toolName: string): string[] {
  const tool = toolName.slice(toolName.lastIndexOf("/") + 1);
  return tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function isReadToolV1(toolName: string): boolean {
  if (toolName === "machine_read") return true;
  if (!toolName.startsWith("mcp-")) return false;
  return READ_VERBS.has(toolWordsV1(toolName)[0] ?? "");
}

/** A connected service, by the name a person knows it by. */
export function serviceNameV1(target: string): string {
  const where = target.slice(AUDIT_TARGET_REMOTE_PREFIX_V1.length);
  // An unresolved namespace, `mcp-<name>`, still says which server it was.
  if (where.startsWith("mcp-")) {
    return capitalise(where.slice(4).replace(/-/g, " "));
  }
  const host = where.replace(/:\d+$/, "");
  const labels = host.split(".").filter((label) => label.length > 0);
  while (labels.length > 2 && HOST_NOISE.has(labels[0]!)) labels.shift();
  return capitalise(labels.length >= 2 ? labels[0]! : host);
}

/** Where the effect happened, as the tag on its row. */
export function activityPlaceV1(group: AuditActivityGroupV1): string {
  const { target } = group;
  if (target === AUDIT_TARGET_COMPUTER_V1) return "Computer";
  if (target === AUDIT_TARGET_WORKSPACE_V1) {
    if (group.toolNames.every((tool) => tool.startsWith("memory_"))) {
      return "Memory";
    }
    return group.toolNames.every(
      (tool) => tool === "skill_write" || tool === "package_author",
    )
      ? "Skills"
      : "Workspace";
  }
  if (target.startsWith(AUDIT_TARGET_MACHINE_PREFIX_V1)) return "Your computer";
  if (target.startsWith(AUDIT_TARGET_REMOTE_PREFIX_V1)) {
    return serviceNameV1(target);
  }
  if (target.startsWith(AUDIT_TARGET_DEVICE_PREFIX_V1)) {
    const device = target.slice(AUDIT_TARGET_DEVICE_PREFIX_V1.length);
    return DEVICE_LABELS[device] ?? capitalise(device);
  }
  if (group.kind === "email") return "Email";
  return "Conversation";
}

/** How long a device use lasted, the way a person says it. */
export function lastedV1(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function times(count: number, one: string, many: (n: number) => string) {
  return count === 1 ? one : many(count);
}

function quoted(text: string): string {
  return `“${text.trim()}”`;
}

/** What the Bot did, as the rest of a sentence that begins with its name. */
export function activityTextV1(group: AuditActivityGroupV1): string {
  const { count, target, toolNames } = group;
  const single = count === 1;
  const onMachine = target.startsWith(AUDIT_TARGET_MACHINE_PREFIX_V1);
  const where = onMachine ? "your computer" : "its Computer";
  switch (group.kind) {
    case "shell": {
      if (!single) return `ran ${count} commands on ${where}`;
      // A machine command's preview ends with the machine it named.
      const machineId = target.slice(AUDIT_TARGET_MACHINE_PREFIX_V1.length);
      const command =
        onMachine && group.preview.endsWith(` ${machineId}`)
          ? group.preview.slice(0, -machineId.length - 1)
          : group.preview;
      return command.length > 0 && command !== toolNames[0]
        ? `ran ${quoted(command)} on ${where}`
        : `ran a command on ${where}`;
    }
    case "process":
      return times(
        count,
        `managed a background command on ${where}`,
        (n) => `managed background commands on ${where}, ${n} times`,
      );
    case "browser":
      return times(
        count,
        "used the web browser on its Computer",
        (n) => `took ${n} steps in the web browser on its Computer`,
      );
    case "file": {
      if (target === AUDIT_TARGET_WORKSPACE_V1) {
        const place = activityPlaceV1(group);
        if (place === "Memory" || place === "Skills") {
          const what = place === "Memory" ? "its memory" : "its skills";
          return times(
            count,
            `updated ${what}`,
            (n) => `updated ${what} ${n} times`,
          );
        }
        return times(
          count,
          "changed a file in its Workspace",
          (n) => `changed ${n} files in its Workspace`,
        );
      }
      const mine = onMachine ? "your computer" : "its Computer";
      if (toolNames.every((tool) => tool === "machine_read")) {
        return times(
          count,
          `read a file on ${mine}`,
          (n) => `read ${n} files on ${mine}`,
        );
      }
      if (toolNames.every((tool) => tool === "machine_copy_to_computer")) {
        return times(
          count,
          "copied a file from your computer to its own",
          (n) => `copied ${n} files from your computer to its own`,
        );
      }
      if (toolNames.every((tool) => tool === "machine_copy_from_computer")) {
        return times(
          count,
          "copied a file from its Computer to yours",
          (n) => `copied ${n} files from its Computer to yours`,
        );
      }
      return times(
        count,
        "moved a file between its Computer and yours",
        (n) => `moved ${n} files between its Computer and yours`,
      );
    }
    case "mcp": {
      const service = serviceNameV1(target);
      if (!single) return `made ${count} calls to ${service}`;
      const words = toolWordsV1(toolNames[0] ?? "").join(" ");
      return words.length > 0
        ? `called ${service}: ${words}`
        : `called ${service}`;
    }
    case "email": {
      if (toolNames.every((tool) => tool === EMAIL_OWNER_TOOL)) {
        if (!single) return `emailed you ${count} times`;
        const subject = group.preview.replace(/^Emailed you:\s*/, "");
        return subject.length > 0
          ? `emailed you: ${quoted(subject)}`
          : "emailed you";
      }
      return times(count, "sent an email", (n) => `sent ${n} emails`);
    }
    case "device": {
      const ability = toolNames[0] ?? "a device";
      const suffix = ` used the ${ability}`;
      const plugin = group.preview.endsWith(suffix)
        ? group.preview.slice(0, -suffix.length)
        : "";
      return [
        `used the ${ability}`,
        group.durationMs === undefined
          ? ""
          : ` for ${lastedV1(group.durationMs)}`,
        plugin.length > 0 ? `, through ${plugin}` : "",
      ].join("");
    }
    case "supervision":
      return times(
        count,
        `was held back from the conversation: ${group.preview}`,
        (n) => `was held back from the conversation ${n} times`,
      );
  }
}

/** What went other than to plan, or nothing when everything did. */
export function activityNoteV1(
  group: AuditActivityGroupV1,
): string | undefined {
  const single = group.count === 1;
  const parts: string[] = [];
  if (group.unknown > 0) {
    parts.push(single ? "Outcome unknown" : `${group.unknown} outcome unknown`);
  }
  if (group.failed > 0)
    parts.push(single ? "Failed" : `${group.failed} failed`);
  // Held back is what a supervision row is, not something that went wrong.
  if (group.refused > 0 && group.kind !== "supervision") {
    parts.push(single ? "Refused" : `${group.refused} refused`);
  }
  if (group.interrupted > 0) {
    parts.push(single ? "Interrupted" : `${group.interrupted} interrupted`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** One group as the row the page draws. */
export function activityRowV1(
  group: AuditActivityGroupV1,
  botName: string,
): ActivityRow {
  const note = activityNoteV1(group);
  const quiet =
    group.toolNames.length > 0 && group.toolNames.every(isReadToolV1);
  // Only a send that went through is one the person approved; a draft they
  // turned down never sends, so it never has a row.
  const approved =
    group.approved > 0 && group.toolNames.includes(EMAIL_SEND_TOOL);
  return {
    botId: group.botId,
    botName: botName.slice(0, 120),
    at: new Date(group.at).toISOString(),
    text: activityTextV1(group).replace(/\s+/g, " ").slice(0, 400),
    place: activityPlaceV1(group).slice(0, 80),
    ...(approved ? { approved: true } : {}),
    ...(quiet ? { quiet: true } : {}),
    ...(note === undefined ? {} : { note }),
    // A device use was no Turn's, so there is no work to open.
    ...(group.kind === "device" ? {} : { runId: group.runId }),
  };
}

/** A page of groups as the page the Activity surface draws. */
export function activityPageV1(
  page: AuditActivityPageV1,
  botNames: Readonly<Record<string, string>>,
): ActivityPage {
  return decodeProtocol("ActivityPage", {
    schemaVersion: 1,
    rows: page.groups.map((group) =>
      activityRowV1(group, botNames[group.botId] || "A Bot"),
    ),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    indexState: page.indexState,
  });
}
