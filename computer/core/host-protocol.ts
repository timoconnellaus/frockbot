import type {
  ComputerAssignment,
  ComputerBrowserAction,
  ComputerBrowserState,
  ComputerExecRequest,
  ComputerExecResult,
  ComputerIdentityV1,
  ComputerTenantV1,
} from "./core.js";

export type ComputerHostOperationV1 =
  | { type: "exec"; request: ComputerExecRequest }
  | { type: "browser"; action: ComputerBrowserAction };

export interface ComputerHostEffectRequestV1 {
  schemaVersion: 1;
  effectId: string;
  identity: ComputerIdentityV1;
  tenant: ComputerTenantV1;
  assignment: ComputerAssignment;
  operation: ComputerHostOperationV1;
}

export type ComputerHostEffectResultV1 =
  | { type: "exec"; result: ComputerExecResult }
  | { type: "browser"; result: ComputerBrowserState };

export type ComputerHostEffectResponseV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "completed";
      result: ComputerHostEffectResultV1;
    }
  | {
      schemaVersion: 1;
      effectId: string;
      status: "unresolved";
      failure: string;
    }
  | {
      schemaVersion: 1;
      effectId: string;
      status: "rejected";
      failure: string;
    };

function record(
  input: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== allowed.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !allowed.includes(key) ||
        !Object.prototype.propertyIsEnumerable.call(input, key),
    )
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return input as Record<string, unknown>;
}

function identifier(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return input;
}

function finiteInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return input as number;
}

function bytes(input: unknown, label: string): Uint8Array {
  if (
    !Array.isArray(input) ||
    input.some(
      (value) =>
        !Number.isSafeInteger(value) || (value as number) < 0 || value > 255,
    )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Uint8Array.from(input as number[]);
}

function browserAction(input: unknown): ComputerBrowserAction {
  if (typeof input !== "object" || input === null) {
    throw new Error("Computer browser action is invalid");
  }
  const type = (input as { type?: unknown }).type;
  const optionalExact = Object.hasOwn(input, "exact") ? ["exact"] : [];
  if (type === "snapshot") {
    record(input, ["type"], "Computer browser action");
    return { type };
  }
  if (type === "navigate") {
    const value = record(input, ["type", "url"], "Computer browser action");
    if (typeof value.url !== "string")
      throw new Error("Computer browser URL is invalid");
    return { type, url: value.url };
  }
  if (type === "close-origins") {
    const value = record(input, ["type", "origins"], "Computer browser action");
    if (
      !Array.isArray(value.origins) ||
      value.origins.length < 1 ||
      value.origins.length > 16 ||
      value.origins.some(
        (origin) => typeof origin !== "string" || origin.length > 2_048,
      )
    ) {
      throw new Error("Computer browser origins are invalid");
    }
    return { type, origins: value.origins as string[] };
  }
  if (type === "click") {
    const value = record(
      input,
      ["type", "role", "name", ...optionalExact],
      "Computer browser action",
    );
    if (
      typeof value.role !== "string" ||
      typeof value.name !== "string" ||
      (value.exact !== undefined && typeof value.exact !== "boolean")
    ) {
      throw new Error("Computer browser click is invalid");
    }
    return {
      type,
      role: value.role,
      name: value.name,
      ...(value.exact === undefined ? {} : { exact: value.exact }),
    };
  }
  if (type === "fill") {
    const value = record(
      input,
      ["type", "label", "text", ...optionalExact],
      "Computer browser action",
    );
    if (
      typeof value.label !== "string" ||
      typeof value.text !== "string" ||
      (value.exact !== undefined && typeof value.exact !== "boolean")
    ) {
      throw new Error("Computer browser fill is invalid");
    }
    return {
      type,
      label: value.label,
      text: value.text,
      ...(value.exact === undefined ? {} : { exact: value.exact }),
    };
  }
  if (type === "press") {
    const value = record(input, ["type", "key"], "Computer browser action");
    if (typeof value.key !== "string")
      throw new Error("Computer browser key is invalid");
    return { type, key: value.key };
  }
  if (type === "wait") {
    const value = record(
      input,
      ["type", "milliseconds"],
      "Computer browser action",
    );
    return {
      type,
      milliseconds: finiteInteger(value.milliseconds, "Computer browser wait"),
    };
  }
  throw new Error("Computer browser action is invalid");
}

export type ComputerHostEffectWireV1 = Record<string, unknown>;

function computerHostWireV1(
  input: ComputerHostEffectRequestV1 | ComputerHostEffectResponseV1,
): ComputerHostEffectWireV1 {
  const serialized = JSON.stringify(input, (_key, value) =>
    value instanceof Uint8Array ? [...value] : value,
  );
  try {
    return JSON.parse(serialized) as ComputerHostEffectWireV1;
  } catch {
    throw new Error("Computer host value could not be serialized");
  }
}

export function computerHostEffectRequestWireV1(
  input: ComputerHostEffectRequestV1,
): ComputerHostEffectWireV1 {
  return computerHostWireV1(input);
}

export function computerHostEffectResponseWireV1(
  input: ComputerHostEffectResponseV1,
): ComputerHostEffectWireV1 {
  return computerHostWireV1(input);
}

export function decodeComputerHostEffectRequestV1(
  input: unknown,
): ComputerHostEffectRequestV1 {
  const value = record(
    input,
    [
      "schemaVersion",
      "effectId",
      "identity",
      "tenant",
      "assignment",
      "operation",
    ],
    "Computer host request",
  );
  if (value.schemaVersion !== 1)
    throw new Error("Computer host version is invalid");
  const identity = record(value.identity, ["userId"], "Computer identity");
  const tenant = record(value.tenant, ["botId"], "Computer tenant");
  const assignment = record(
    value.assignment,
    ["providerId", "generation"],
    "Computer assignment",
  );
  const operationValue = value.operation;
  if (typeof operationValue !== "object" || operationValue === null) {
    throw new Error("Computer operation is invalid");
  }
  const operationType = (operationValue as { type?: unknown }).type;
  let operation: ComputerHostOperationV1;
  if (operationType === "exec") {
    const decoded = record(
      operationValue,
      ["type", "request"],
      "Computer exec operation",
    );
    if (typeof decoded.request !== "object" || decoded.request === null) {
      throw new Error("Computer exec request is invalid");
    }
    const request = record(
      decoded.request,
      [
        "executable",
        "args",
        "cwd",
        "env",
        "stdin",
        "timeoutMs",
        "maxOutputBytes",
      ].filter((key) => Object.hasOwn(decoded.request as object, key)),
      "Computer exec request",
    );
    if (typeof request.executable !== "string" || !request.executable) {
      throw new Error("Computer executable is invalid");
    }
    operation = {
      type: "exec",
      request: {
        executable: request.executable,
        ...(Array.isArray(request.args) &&
        request.args.every((item) => typeof item === "string")
          ? { args: request.args as string[] }
          : request.args === undefined
            ? {}
            : (() => {
                throw new Error("Computer args are invalid");
              })()),
        ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
        ...(request.env === undefined
          ? {}
          : {
              env: record(
                request.env,
                Object.keys(request.env as object),
                "Computer env",
              ) as Record<string, string>,
            }),
        ...(request.stdin === undefined
          ? {}
          : { stdin: bytes(request.stdin, "Computer stdin") }),
        ...(request.timeoutMs === undefined
          ? {}
          : {
              timeoutMs: finiteInteger(request.timeoutMs, "Computer timeout"),
            }),
        ...(request.maxOutputBytes === undefined
          ? {}
          : {
              maxOutputBytes: finiteInteger(
                request.maxOutputBytes,
                "Computer output limit",
              ),
            }),
      },
    };
  } else if (operationType === "browser") {
    const decoded = record(
      operationValue,
      ["type", "action"],
      "Computer browser operation",
    );
    operation = { type: "browser", action: browserAction(decoded.action) };
  } else {
    throw new Error("Computer operation is invalid");
  }
  return {
    schemaVersion: 1,
    effectId: identifier(value.effectId, "Computer effect ID"),
    identity: {
      userId: identifier(identity.userId, "Computer user ID"),
    },
    tenant: {
      botId: identifier(tenant.botId, "Computer Bot ID"),
    },
    assignment: {
      providerId: identifier(assignment.providerId, "Computer provider ID"),
      generation: finiteInteger(assignment.generation, "Computer generation"),
    },
    operation,
  };
}

export function decodeComputerHostEffectResponseV1(
  input: unknown,
): ComputerHostEffectResponseV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Computer host response must be an object");
  }
  const status = (input as { status?: unknown }).status;
  const allowed =
    status === "completed"
      ? ["schemaVersion", "effectId", "status", "result"]
      : ["schemaVersion", "effectId", "status", "failure"];
  const value = record(input, allowed, "Computer host response");
  if (value.schemaVersion !== 1)
    throw new Error("Computer host response version is invalid");
  const effectId = identifier(value.effectId, "Computer effect ID");
  if (status === "unresolved" || status === "rejected") {
    if (typeof value.failure !== "string" || !value.failure) {
      throw new Error("Computer host failure is invalid");
    }
    return { schemaVersion: 1, effectId, status, failure: value.failure };
  }
  if (status !== "completed")
    throw new Error("Computer host status is invalid");
  const result = value.result as ComputerHostEffectResultV1;
  if (result?.type === "exec") {
    return {
      schemaVersion: 1,
      effectId,
      status,
      result: {
        type: "exec",
        result: {
          ...result.result,
          stdout: bytes(result.result.stdout, "Computer stdout"),
          stderr: bytes(result.result.stderr, "Computer stderr"),
        },
      },
    };
  }
  if (result?.type === "browser") {
    return { schemaVersion: 1, effectId, status, result };
  }
  throw new Error("Computer host result is invalid");
}
