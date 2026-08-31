// The classifier: one pure table from a tool call to an audit kind and target.
//
// PURITY IS THE CONTRACT. A settlement-time projection and a rebuild months
// later must produce byte-identical rows, or the index stops being a
// projection and starts being a second authority that can disagree with the
// first. This function therefore reads only its arguments — never the clock,
// never a registry, never the Bot's mounted Composition — exactly as
// `searchRowsFromClientRunV1` does for the transcript index.
//
// The MCP target is the one thing a tool name cannot answer on its own: the
// name carries the Connection's *slug* (`mcp__<slug>__<tool>`,
// `plugin-mcp/src/agent.ts`), and the host lives in the Connection's settings,
// which the User Durable Object owns. So this answers `remote:<slug>` and the
// User object — the authority for Connections — resolves it to `remote:<host>`
// on the one code path both projection and rebuild go through
// (`resolveAuditTargetV1` in `user.ts`). One resolution point, in the object
// that holds the registry, is the only arrangement where the two cannot drift.
import {
  AUDIT_TARGET_COMPUTER_V1,
  AUDIT_TARGET_MACHINE_PREFIX_V1,
  AUDIT_TARGET_REMOTE_PREFIX_V1,
  type AuditKindV1,
} from "./shared.js";

/** What one tool call is, for audit. */
export interface AuditClassificationV1 {
  kind: AuditKindV1;
  /**
   * `computer`, `machine:<id>`, or the provisional `remote:<slug>` an MCP call
   * carries until the Connection registry resolves its host.
   */
  target: string;
}

/**
 * Tools whose effect is a write to the Workspace rather than a command.
 *
 * `AGENTS.md` § Memory notes the parity gap this closes: GrokBot audits
 * neither Memory writes nor Routine edits (`grokbot-computer.md:194-195`).
 * They already carry their own intent and result events here, so auditing them
 * costs one table row and no new authority.
 */
const FILE_TOOLS = new Set([
  "memory_write",
  "memory_forget",
  "skill_write",
  "package_author",
]);

const MCP_TOOL = /^mcp__([a-zA-Z0-9_]{1,64})__(.{1,96})$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The registered Mac, when the call named one.
 *
 * GrokBot reaches Tim's laptop by passing `machineId` to `Shell`, and its
 * `audit.jsonl` records which target the command ran on
 * (`grokbot-computer.md:361`). FrockBot has no registered-machine Capability
 * yet, so nothing writes `machineId` today — but the shape is honoured now,
 * which is what makes `machine:<id>` a reservation rather than a promise.
 */
function machineTarget(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const machineId = input.machineId;
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) {
    return undefined;
  }
  return `${AUDIT_TARGET_MACHINE_PREFIX_V1}${machineId}`;
}

/**
 * What kind of audited effect a tool call is, or `undefined` when it is none.
 *
 * `undefined` is the common answer and deliberately so: a Turn that asks the
 * time or searches Memory performs no external effect, and an audit surface
 * that logged every tool call would be a transcript, not an audit.
 */
export function auditKindForToolV1(
  name: string,
  input: unknown,
): AuditClassificationV1 | undefined {
  const onComputer = machineTarget(input) ?? AUDIT_TARGET_COMPUTER_V1;
  if (name === "computer_exec") {
    // A background command outlives the Turn that launched it and is acted on
    // afterwards by the three `computer_process_*` tools, so it is a process
    // rather than a command that ended with the call. GrokBot draws the same
    // line, as `shellKind: foreground | background` on its own audit line
    // (`docs/research/grokbot-computer.md:189`).
    const background =
      isObject(input) && input.background === true ? "process" : "shell";
    return { kind: background, target: onComputer };
  }
  if (name === "computer_browser") {
    return { kind: "browser", target: onComputer };
  }
  if (name.startsWith("computer_process_")) {
    return { kind: "process", target: onComputer };
  }
  if (FILE_TOOLS.has(name)) return { kind: "file", target: onComputer };
  const mcp = MCP_TOOL.exec(name);
  if (mcp) {
    return {
      kind: "mcp",
      target: `${AUDIT_TARGET_REMOTE_PREFIX_V1}${mcp[1]}`,
    };
  }
  return undefined;
}
