export type PackageCheckStatus = "passed" | "failed";

export interface PackageCheckV1 {
  name: string;
  status: PackageCheckStatus;
}

export interface PackageCandidateV1 {
  source: string;
  applicationArtifact: string;
  checks: PackageCheckV1[];
}

export interface PublishPackageCommandV1 {
  schemaVersion: 1;
  commandId: string;
  expectedRevision: number;
  candidate: PackageCandidateV1;
}

export interface RollbackPackageCommandV1 {
  schemaVersion: 1;
  commandId: string;
  expectedRevision: number;
  packageRevision: number;
}

export interface PackageRevisionV1 {
  packageRevision: number;
  applicationHash: string;
  publishedAt: string;
  checks: PackageCheckV1[];
}

export interface PackageRevisionHistoryV1 {
  schemaVersion: 1;
  revision: number;
  activePackageRevision?: number;
  revisions: PackageRevisionV1[];
}

export interface PackagePublicationReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "active" | "failed";
  revision: number;
  packageRevision?: number;
  applicationHash?: string;
  failure?: string;
}

export class PackagePublisherDecodeError extends Error {
  override readonly name = "PackagePublisherDecodeError";
}

export class PackagePublisherConflictError extends Error {
  override readonly name = "PackagePublisherConflictError";
  constructor(readonly currentRevision: number) {
    super(`package revision is ${currentRevision}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackagePublisherDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new PackagePublisherDecodeError(
      `${label} has unknown or missing fields`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new PackagePublisherDecodeError(`${label} is invalid`);
  }
  return value;
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PackagePublisherDecodeError(`${label} is invalid`);
  }
  return value as number;
}

function decodeChecks(value: unknown): PackageCheckV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new PackagePublisherDecodeError("checks must not be empty");
  }
  return value.map((entry, index) => {
    const check = record(entry, `checks[${index}]`);
    exactKeys(check, ["name", "status"], `checks[${index}]`);
    const name = identifier(check.name, `checks[${index}].name`);
    if (check.status !== "passed" && check.status !== "failed") {
      throw new PackagePublisherDecodeError(
        `checks[${index}].status is invalid`,
      );
    }
    return { name, status: check.status };
  });
}

export function decodePublishPackageCommandV1(
  value: unknown,
): PublishPackageCommandV1 {
  const command = record(value, "publish command");
  exactKeys(
    command,
    ["schemaVersion", "commandId", "expectedRevision", "candidate"],
    "publish command",
  );
  if (command.schemaVersion !== 1) {
    throw new PackagePublisherDecodeError("schemaVersion must be 1");
  }
  const candidate = record(command.candidate, "candidate");
  exactKeys(
    candidate,
    ["source", "applicationArtifact", "checks"],
    "candidate",
  );
  if (
    typeof candidate.source !== "string" ||
    candidate.source.length < 1 ||
    candidate.source.length > 5_000_000
  ) {
    throw new PackagePublisherDecodeError("candidate source is invalid");
  }
  if (
    typeof candidate.applicationArtifact !== "string" ||
    candidate.applicationArtifact.length < 1 ||
    candidate.applicationArtifact.length > 10_000_000
  ) {
    throw new PackagePublisherDecodeError(
      "candidate application artifact is invalid",
    );
  }
  return {
    schemaVersion: 1,
    commandId: identifier(command.commandId, "commandId"),
    expectedRevision: revision(command.expectedRevision, "expectedRevision"),
    candidate: {
      source: candidate.source,
      applicationArtifact: candidate.applicationArtifact,
      checks: decodeChecks(candidate.checks),
    },
  };
}

export function decodePackageRevisionHistoryV1(
  value: unknown,
): PackageRevisionHistoryV1 {
  const history = record(value, "package revision history");
  const keys = Object.keys(history);
  const allowed = new Set([
    "schemaVersion",
    "revision",
    "activePackageRevision",
    "revisions",
  ]);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !keys.includes("schemaVersion") ||
    !keys.includes("revision") ||
    !keys.includes("revisions")
  ) {
    throw new PackagePublisherDecodeError(
      "package revision history has unknown or missing fields",
    );
  }
  if (history.schemaVersion !== 1 || !Array.isArray(history.revisions)) {
    throw new PackagePublisherDecodeError(
      "package revision history is invalid",
    );
  }
  const revisions = history.revisions.map((entry, index) => {
    const item = record(entry, `revisions[${index}]`);
    exactKeys(
      item,
      ["packageRevision", "applicationHash", "publishedAt", "checks"],
      `revisions[${index}]`,
    );
    if (
      typeof item.applicationHash !== "string" ||
      !item.applicationHash.startsWith("sha256:") ||
      typeof item.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(item.publishedAt))
    ) {
      throw new PackagePublisherDecodeError(`revisions[${index}] is invalid`);
    }
    const packageRevision = revision(
      item.packageRevision,
      `revisions[${index}].packageRevision`,
    );
    if (packageRevision < 1) {
      throw new PackagePublisherDecodeError(
        `revisions[${index}].packageRevision is invalid`,
      );
    }
    return {
      packageRevision,
      applicationHash: item.applicationHash,
      publishedAt: item.publishedAt,
      checks: decodeChecks(item.checks),
    };
  });
  const activePackageRevision =
    history.activePackageRevision === undefined
      ? undefined
      : revision(history.activePackageRevision, "activePackageRevision");
  if (activePackageRevision !== undefined && activePackageRevision < 1) {
    throw new PackagePublisherDecodeError("activePackageRevision is invalid");
  }
  return {
    schemaVersion: 1,
    revision: revision(history.revision, "revision"),
    ...(activePackageRevision === undefined ? {} : { activePackageRevision }),
    revisions,
  };
}

export function decodePackagePublicationReceiptV1(
  value: unknown,
): PackagePublicationReceiptV1 {
  const receipt = record(value, "publication receipt");
  const allowed = new Set([
    "schemaVersion",
    "commandId",
    "status",
    "revision",
    "packageRevision",
    "applicationHash",
    "failure",
  ]);
  if (
    Object.keys(receipt).some((key) => !allowed.has(key)) ||
    receipt.schemaVersion !== 1 ||
    (receipt.status !== "active" && receipt.status !== "failed")
  ) {
    throw new PackagePublisherDecodeError("publication receipt is invalid");
  }
  const result: PackagePublicationReceiptV1 = {
    schemaVersion: 1,
    commandId: identifier(receipt.commandId, "commandId"),
    status: receipt.status,
    revision: revision(receipt.revision, "revision"),
  };
  if (receipt.packageRevision !== undefined) {
    result.packageRevision = revision(
      receipt.packageRevision,
      "packageRevision",
    );
  }
  if (receipt.applicationHash !== undefined) {
    if (typeof receipt.applicationHash !== "string") {
      throw new PackagePublisherDecodeError("applicationHash is invalid");
    }
    result.applicationHash = receipt.applicationHash;
  }
  if (receipt.failure !== undefined) {
    if (typeof receipt.failure !== "string") {
      throw new PackagePublisherDecodeError("failure is invalid");
    }
    result.failure = receipt.failure;
  }
  return result;
}

export function decodeRollbackPackageCommandV1(
  value: unknown,
): RollbackPackageCommandV1 {
  const command = record(value, "rollback command");
  exactKeys(
    command,
    ["schemaVersion", "commandId", "expectedRevision", "packageRevision"],
    "rollback command",
  );
  if (command.schemaVersion !== 1) {
    throw new PackagePublisherDecodeError("schemaVersion must be 1");
  }
  const packageRevision = revision(command.packageRevision, "packageRevision");
  if (packageRevision < 1) {
    throw new PackagePublisherDecodeError("packageRevision is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: identifier(command.commandId, "commandId"),
    expectedRevision: revision(command.expectedRevision, "expectedRevision"),
    packageRevision,
  };
}
