// The Computer presence protocol crosses the hosted client, gateway and Bot
// Durable Object seams. It contains projections and commands only: notably,
// the viewer URL is present solely on a read projection and never on a command
// receipt, so an idempotency record cannot become durable secret storage.

export const COMPUTER_COMMAND_TYPES = [
  "connect",
  "takeControl",
  "releaseControl",
  "refreshControl",
  "refreshViewer",
  "closeViewer",
  "runDoctor",
] as const;

export type ComputerCommandTypeV1 = (typeof COMPUTER_COMMAND_TYPES)[number];

export interface ComputerCommandV1 {
  version: 1;
  commandId: string;
  botId: string;
  type: ComputerCommandTypeV1;
}

export interface ComputerViewerSessionViewV1 {
  version: 1;
  id: string;
  /**
   * A bearer secret for the VNC transport. It crosses this one projection,
   * lives only in client memory, and must never enter storage or a log.
   */
  url: string;
  expiresAt: string;
}

export interface ComputerControlLeaseViewV1 {
  version: 1;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ComputerScreenshotViewV1 {
  version: 1;
  path: string;
  capturedAt: string;
  contentHash: string;
  url: string;
}

export interface ComputerDoctorCheckViewV1 {
  version: 1;
  name: string;
  status: "pass" | "fail";
  detail: string;
}

export interface ComputerDoctorViewV1 {
  version: 1;
  capturedAt: string;
  summary: string;
  checks: ComputerDoctorCheckViewV1[];
}

export type ComputerProgressStepStatusV1 = "pending" | "active" | "complete";

export interface ComputerProgressStepViewV1 {
  version: 1;
  id: string;
  label: string;
  status: ComputerProgressStepStatusV1;
}

export interface ComputerProvisioningProgressViewV1 {
  version: 1;
  kind: "provision" | "update";
  label: string;
  index: number;
  total: number;
  resumed: boolean;
}

/** Durable progress projected from the Bot authority; it contains no secrets. */
export interface ComputerProgressViewV1 {
  version: 1;
  kind: "connect" | "update";
  startedAt: string;
  updatedAt: string;
  index: number;
  total: number;
  provisioning?: ComputerProvisioningProgressViewV1;
  steps: ComputerProgressStepViewV1[];
}

export const COMPUTER_PHASES = [
  "unconfigured",
  "idle",
  "provisioning",
  "updating",
  "ready",
  "taking-control",
  "human-control",
  "disconnected",
  "error",
] as const;

export type ComputerPhase = (typeof COMPUTER_PHASES)[number];

export const COMPUTER_UPDATE_MESSAGE_PREFIX = "Updating the Computer: ";

/** Extracts the provider's update phase label without coupling to a provider. */
export function computerUpdateLabelV1(
  message: string | undefined,
): string | undefined {
  if (!message?.startsWith(COMPUTER_UPDATE_MESSAGE_PREFIX)) return undefined;
  const label = message.slice(COMPUTER_UPDATE_MESSAGE_PREFIX.length).trim();
  return label || undefined;
}

export interface ComputerProjectionV1 {
  version: 1;
  botId: string;
  providerLabel: string;
  phase: ComputerPhase;
  message: string;
  progress?: ComputerProgressViewV1;
  viewerSession?: ComputerViewerSessionViewV1;
  controlLease?: ComputerControlLeaseViewV1;
  screenshots: ComputerScreenshotViewV1[];
  doctor?: ComputerDoctorViewV1;
}

export type ComputerCommandReceiptV1 =
  | {
      version: 1;
      commandId: string;
      type: ComputerCommandTypeV1;
      status: "applied";
      completedAt: string;
    }
  | {
      version: 1;
      commandId: string;
      type: ComputerCommandTypeV1;
      status: "rejected";
      completedAt: string;
      failure: string;
    };

export class ComputerProtocolDecodeError extends Error {
  override readonly name = "ComputerProtocolDecodeError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ComputerProtocolDecodeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new ComputerProtocolDecodeError(`${label} has unexpected fields`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new ComputerProtocolDecodeError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const decoded = text(value, label);
  if (!Number.isFinite(Date.parse(decoded))) {
    throw new ComputerProtocolDecodeError(`${label} is invalid`);
  }
  return decoded;
}

function commandType(value: unknown): ComputerCommandTypeV1 {
  const decoded = COMPUTER_COMMAND_TYPES.find((known) => known === value);
  if (!decoded) {
    throw new ComputerProtocolDecodeError("Computer command type is unknown");
  }
  return decoded;
}

function phase(value: unknown): ComputerPhase {
  const decoded = COMPUTER_PHASES.find((known) => known === value);
  if (!decoded) {
    throw new ComputerProtocolDecodeError("Computer phase is unknown");
  }
  return decoded;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ComputerProtocolDecodeError(`${label} is invalid`);
  }
  return value;
}

function decodeProgressStepV1(value: unknown): ComputerProgressStepViewV1 {
  const candidate = record(value, "Computer progress step");
  exactKeys(
    candidate,
    ["version", "id", "label", "status"],
    [],
    "Computer progress step",
  );
  if (
    candidate.version !== 1 ||
    (candidate.status !== "pending" &&
      candidate.status !== "active" &&
      candidate.status !== "complete")
  ) {
    throw new ComputerProtocolDecodeError("Computer progress step is invalid");
  }
  return {
    version: 1,
    id: text(candidate.id, "Computer progress step id"),
    label: text(candidate.label, "Computer progress step label"),
    status: candidate.status,
  };
}

function decodeProvisioningProgressV1(
  value: unknown,
): ComputerProvisioningProgressViewV1 {
  const candidate = record(value, "Computer provisioning progress");
  exactKeys(
    candidate,
    ["version", "kind", "label", "index", "total", "resumed"],
    [],
    "Computer provisioning progress",
  );
  if (
    candidate.version !== 1 ||
    (candidate.kind !== "provision" && candidate.kind !== "update") ||
    typeof candidate.resumed !== "boolean"
  ) {
    throw new ComputerProtocolDecodeError(
      "Computer provisioning progress is invalid",
    );
  }
  const total = boundedInteger(
    candidate.total,
    1,
    1_000,
    "Computer provisioning progress total",
  );
  return {
    version: 1,
    kind: candidate.kind,
    label: text(candidate.label, "Computer provisioning progress label"),
    index: boundedInteger(
      candidate.index,
      0,
      total,
      "Computer provisioning progress index",
    ),
    total,
    resumed: candidate.resumed,
  };
}

export function decodeComputerProgressViewV1(
  value: unknown,
): ComputerProgressViewV1 {
  const candidate = record(value, "Computer progress");
  exactKeys(
    candidate,
    ["version", "kind", "startedAt", "updatedAt", "index", "total", "steps"],
    ["provisioning"],
    "Computer progress",
  );
  if (
    candidate.version !== 1 ||
    (candidate.kind !== "connect" && candidate.kind !== "update") ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.length === 0 ||
    candidate.steps.length > 20
  ) {
    throw new ComputerProtocolDecodeError("Computer progress is invalid");
  }
  const total = boundedInteger(
    candidate.total,
    1,
    1_000,
    "Computer progress total",
  );
  const index = boundedInteger(
    candidate.index,
    0,
    total,
    "Computer progress index",
  );
  const steps = candidate.steps.map(decodeProgressStepV1);
  if (steps.filter((step) => step.status === "active").length > 1) {
    throw new ComputerProtocolDecodeError(
      "Computer progress has multiple active steps",
    );
  }
  return {
    version: 1,
    kind: candidate.kind,
    startedAt: timestamp(candidate.startedAt, "Computer progress startedAt"),
    updatedAt: timestamp(candidate.updatedAt, "Computer progress updatedAt"),
    index,
    total,
    ...(candidate.provisioning === undefined
      ? {}
      : {
          provisioning: decodeProvisioningProgressV1(candidate.provisioning),
        }),
    steps,
  };
}

export function decodeComputerCommandV1(value: unknown): ComputerCommandV1 {
  const candidate = record(value, "Computer command");
  exactKeys(
    candidate,
    ["version", "commandId", "botId", "type"],
    [],
    "Computer command",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer command version is unsupported",
    );
  }
  return {
    version: 1,
    commandId: text(candidate.commandId, "Computer commandId"),
    botId: text(candidate.botId, "Computer botId"),
    type: commandType(candidate.type),
  };
}

function decodeViewerSessionV1(value: unknown): ComputerViewerSessionViewV1 {
  const candidate = record(value, "Computer viewer session");
  exactKeys(
    candidate,
    ["version", "id", "url", "expiresAt"],
    [],
    "Computer viewer session",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer viewer session version is unsupported",
    );
  }
  return {
    version: 1,
    id: text(candidate.id, "Computer viewer session id"),
    url: text(candidate.url, "Computer viewer session URL"),
    expiresAt: timestamp(
      candidate.expiresAt,
      "Computer viewer session expiresAt",
    ),
  };
}

function decodeControlLeaseV1(value: unknown): ComputerControlLeaseViewV1 {
  const candidate = record(value, "Computer control lease");
  exactKeys(
    candidate,
    ["version", "ownerId", "acquiredAt", "expiresAt"],
    [],
    "Computer control lease",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer control lease version is unsupported",
    );
  }
  return {
    version: 1,
    ownerId: text(candidate.ownerId, "Computer control lease ownerId"),
    acquiredAt: timestamp(
      candidate.acquiredAt,
      "Computer control lease acquiredAt",
    ),
    expiresAt: timestamp(
      candidate.expiresAt,
      "Computer control lease expiresAt",
    ),
  };
}

function decodeScreenshotV1(value: unknown): ComputerScreenshotViewV1 {
  const candidate = record(value, "Computer screenshot");
  exactKeys(
    candidate,
    ["version", "path", "capturedAt", "contentHash", "url"],
    [],
    "Computer screenshot",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer screenshot version is unsupported",
    );
  }
  return {
    version: 1,
    path: text(candidate.path, "Computer screenshot path"),
    capturedAt: timestamp(
      candidate.capturedAt,
      "Computer screenshot capturedAt",
    ),
    contentHash: text(candidate.contentHash, "Computer screenshot contentHash"),
    url: text(candidate.url, "Computer screenshot URL"),
  };
}

function decodeDoctorCheckV1(value: unknown): ComputerDoctorCheckViewV1 {
  const candidate = record(value, "Computer doctor check");
  exactKeys(
    candidate,
    ["version", "name", "status", "detail"],
    [],
    "Computer doctor check",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer doctor check version is unsupported",
    );
  }
  if (candidate.status !== "pass" && candidate.status !== "fail") {
    throw new ComputerProtocolDecodeError(
      "Computer doctor check status is invalid",
    );
  }
  return {
    version: 1,
    name: text(candidate.name, "Computer doctor check name"),
    status: candidate.status,
    detail: text(candidate.detail, "Computer doctor check detail"),
  };
}

function decodeDoctorV1(value: unknown): ComputerDoctorViewV1 {
  const candidate = record(value, "Computer doctor report");
  exactKeys(
    candidate,
    ["version", "capturedAt", "summary", "checks"],
    [],
    "Computer doctor report",
  );
  if (candidate.version !== 1 || !Array.isArray(candidate.checks)) {
    throw new ComputerProtocolDecodeError("Computer doctor report is invalid");
  }
  return {
    version: 1,
    capturedAt: timestamp(
      candidate.capturedAt,
      "Computer doctor report capturedAt",
    ),
    summary: text(candidate.summary, "Computer doctor report summary"),
    checks: candidate.checks.map(decodeDoctorCheckV1),
  };
}

export function decodeComputerProjectionV1(
  value: unknown,
): ComputerProjectionV1 {
  const candidate = record(value, "Computer projection");
  exactKeys(
    candidate,
    ["version", "botId", "providerLabel", "phase", "message", "screenshots"],
    ["viewerSession", "controlLease", "doctor", "progress"],
    "Computer projection",
  );
  if (candidate.version !== 1 || !Array.isArray(candidate.screenshots)) {
    throw new ComputerProtocolDecodeError("Computer projection is invalid");
  }
  return {
    version: 1,
    botId: text(candidate.botId, "Computer projection botId"),
    providerLabel: text(
      candidate.providerLabel,
      "Computer projection providerLabel",
    ),
    phase: phase(candidate.phase),
    message: text(candidate.message, "Computer projection message"),
    ...(candidate.progress === undefined
      ? {}
      : { progress: decodeComputerProgressViewV1(candidate.progress) }),
    ...(candidate.viewerSession === undefined
      ? {}
      : { viewerSession: decodeViewerSessionV1(candidate.viewerSession) }),
    ...(candidate.controlLease === undefined
      ? {}
      : { controlLease: decodeControlLeaseV1(candidate.controlLease) }),
    screenshots: candidate.screenshots.map(decodeScreenshotV1),
    ...(candidate.doctor === undefined
      ? {}
      : { doctor: decodeDoctorV1(candidate.doctor) }),
  };
}

export function decodeComputerCommandReceiptV1(
  value: unknown,
): ComputerCommandReceiptV1 {
  const candidate = record(value, "Computer command receipt");
  const rejected = candidate.status === "rejected";
  exactKeys(
    candidate,
    ["version", "commandId", "type", "status", "completedAt"],
    rejected ? ["failure"] : [],
    "Computer command receipt",
  );
  if (candidate.version !== 1) {
    throw new ComputerProtocolDecodeError(
      "Computer command receipt version is unsupported",
    );
  }
  const common = {
    version: 1 as const,
    commandId: text(candidate.commandId, "Computer command receipt commandId"),
    type: commandType(candidate.type),
    completedAt: timestamp(
      candidate.completedAt,
      "Computer command receipt completedAt",
    ),
  };
  if (candidate.status === "applied") return { ...common, status: "applied" };
  if (candidate.status === "rejected") {
    return {
      ...common,
      status: "rejected",
      failure: text(candidate.failure, "Computer command receipt failure"),
    };
  }
  throw new ComputerProtocolDecodeError(
    "Computer command receipt status is invalid",
  );
}

export function computerCommandFingerprintV1(
  command: ComputerCommandV1,
): string {
  return JSON.stringify({
    version: 1,
    botId: command.botId,
    type: command.type,
  });
}
