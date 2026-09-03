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
  AUDIT_TARGET_WORKSPACE_V1,
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
  // The registered machine's file verbs (register rows 48, 49). They are file
  // effects on "a separate filesystem" — the User's own laptop — which is why
  // their target is `machine:<id>` and never `computer`.
  "machine_read",
  "machine_copy_to_computer",
  "machine_copy_from_computer",
]);

/**
 * File effects that land in the User's Workspace, not on the Computer.
 *
 * Memory and Skills are object storage: they are written while the Computer is
 * hibernated, and by Bots whose User has no Computer configured at all. Their
 * rows said "This Computer", which named the wrong place and, in the case we
 * saw, a place that did not exist.
 */
const WORKSPACE_FILE_TOOLS = new Set([
  "memory_write",
  "memory_forget",
  "skill_write",
  "package_author",
]);

/**
 * The registered machine's shell verb.
 *
 * It is a `shell` row for the same reason `computer_exec` is: §2.16 says the
 * machine runs `Shell`, row 30 audits "every shell command … with turn id and
 * target", and the target is what tells the two apart. It is never
 * `background`: a machine command outlives its Turn by construction — the
 * approval ends the Turn before anything runs — so there is no foreground case
 * for a `process` row to be the exception to.
 */
const MACHINE_SHELL_TOOL = "machine_exec";

/**
 * The registered Mac's Messages verbs (register row 57g).
 *
 * They are `mcp` rows and not `file` ones: reading somebody's Messages history
 * or sending as them is reaching a *service* on that machine — the shape §4.2
 * itself gives them, beside the connector tools — and the target says which
 * machine it was. Prefix-matched rather than listed one by one because the
 * seven names all belong to one Package and one classification, so a Package
 * that adds an eighth cannot accidentally add an unaudited one.
 */
const MACHINE_MESSAGES_PREFIX = "machine_messages_";

// The slug capture is LAZY. Greedy, `mcp__gh__list__files` reported server
// `gh__list` — a target that names no Connection, so `resolveAuditTargetV1`
// could never resolve it to a host and the row filtered under a server nobody
// has. The slug is the first segment; everything after the second `__` is the
// remote tool's own name, `__` included.
const MCP_TOOL = /^mcp__([a-zA-Z0-9_]{1,64}?)__(.{1,96})$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The wrapper every namespaced Package tool is journalled under. */
const DYNAMIC_TOOL = "call_dynamic_tool";

/**
 * The tool a call actually made.
 *
 * `package_author` was dead code here: it is a namespaced dynamic tool, so the
 * journalled `tool/call` name is `call_dynamic_tool` and no row was ever
 * produced for it — the same hole hid every Composio and publisher call. The
 * wrapper's own input names the tool, exactly as the provider's presented name
 * does, so the classifier reads it off the call and stays pure.
 */
export function resolveDynamicToolNameV1(name: string, input: unknown): string {
  if (name !== DYNAMIC_TOOL || !isObject(input)) return name;
  const { namespace, toolName } = input;
  if (typeof namespace !== "string" || typeof toolName !== "string") {
    return name;
  }
  return namespace === "frockbot" ? toolName : `${namespace}/${toolName}`;
}

/** The arguments the wrapped tool was actually given. */
export function dynamicToolInputV1(input: unknown): unknown {
  if (!isObject(input)) return input;
  return Object.hasOwn(input, "input") ? input.input : input;
}

/** Whether a tool reaches the User's registered machine rather than the Computer. */
function isMachineToolV1(name: string): boolean {
  return (
    name === MACHINE_SHELL_TOOL ||
    name.startsWith(MACHINE_MESSAGES_PREFIX) ||
    name === "machine_read" ||
    name === "machine_copy_to_computer" ||
    name === "machine_copy_from_computer"
  );
}

/**
 * The registered Mac, when the call named one.
 *
 * GrokBot reaches Tim's laptop by passing `machineId` to `Shell`, and its
 * `audit.jsonl` records which target the command ran on
 * (`grokbot-computer.md:361`). `plugin-user-machine` carries `machineId` on
 * every one of its tool inputs verbatim, for exactly this reason: the target a
 * command ran on is read off the call, and this function did not have to learn
 * anything about the Package to say so.
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
  // Only a tool that actually reaches a registered machine may be targeted at
  // one. The target used to come off `machineId` for every tool, and
  // `machineId` is model-supplied: a Bot could run a command on the Computer
  // and have the audit row say it ran on the User's laptop. A Computer tool is
  // audited against the Computer, whatever its arguments claim.
  const resolved = resolveDynamicToolNameV1(name, input);
  const onMachine = isMachineToolV1(resolved)
    ? (machineTarget(input) ?? AUDIT_TARGET_COMPUTER_V1)
    : AUDIT_TARGET_COMPUTER_V1;
  const onComputer = onMachine;
  name = resolved;
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
  if (name === MACHINE_SHELL_TOOL) {
    // No `machineId` on the input is not a machine command; it is a call that
    // could not have run, and it is audited against the target it named.
    return { kind: "shell", target: onComputer };
  }
  if (name === "computer_browser") {
    return { kind: "browser", target: onComputer };
  }
  if (name.startsWith("computer_process_")) {
    return { kind: "process", target: onComputer };
  }
  if (name.startsWith(MACHINE_MESSAGES_PREFIX)) {
    return { kind: "mcp", target: onComputer };
  }
  if (WORKSPACE_FILE_TOOLS.has(name)) {
    return { kind: "file", target: AUDIT_TARGET_WORKSPACE_V1 };
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
