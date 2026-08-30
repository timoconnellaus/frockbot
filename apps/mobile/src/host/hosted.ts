import { Capacitor } from "@capacitor/core";
import {
  isApplicationDeploymentHash,
  isRpcIdentifier,
} from "@frockbot/configuration-core";
import type { MobileCommandResult } from "@frockbot/mobile-core";
import { createCapacitorAdapters } from "./capacitor-adapters.ts";
import {
  createMobileHost,
  type MobileHost,
  type MobileHostPackage,
} from "./index.ts";

const MAX_REQUEST_BYTES = 1_100_000;
const MAX_RESULT_BYTES = 1_100_000;
const MAX_ERROR_BYTES = 512;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const MAX_INVOKE_TIMEOUT_MS = 60_000;
const encoder = new TextEncoder();

class MobileInvocationTimeoutError extends Error {
  constructor() {
    super("mobile capability invocation timed out");
    this.name = "MobileInvocationTimeoutError";
  }
}

export interface HostedMobileInvokeRequestV1 {
  schemaVersion: 1;
  action: "invoke";
  commandId: string;
  input: unknown;
}

export type HostedMobileInvokeResultV1 =
  | { schemaVersion: 1; status: "ok"; result?: MobileCommandResult }
  | {
      schemaVersion: 1;
      status: "unavailable" | "error" | "cancelled";
      error: string;
    };

export interface HostedMobileCapabilities {
  readonly schemaVersion: 1;
  readonly applicationHash: string;
  list(): readonly { id: string }[];
  invoke(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<HostedMobileInvokeResultV1>;
}

declare global {
  interface Window {
    /** Present only after trusted native Contribution mounting succeeds. */
    frockbotMobile?: HostedMobileCapabilities;
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("mobile capability request must be an object");
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.prototype.propertyIsEnumerable.call(input, key),
    )
  ) {
    throw new Error("mobile capability request has unknown fields");
  }
  return input as Record<string, unknown>;
}

function decodeInvokeRequest(input: unknown): HostedMobileInvokeRequestV1 {
  const value = exactRecord(input, [
    "schemaVersion",
    "action",
    "commandId",
    "input",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.action !== "invoke" ||
    !isRpcIdentifier(value.commandId)
  ) {
    throw new Error("mobile capability request is invalid");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value.input);
  } catch {
    throw new Error("mobile capability input must be JSON");
  }
  if (
    serialized === undefined ||
    encoder.encode(serialized).byteLength > MAX_REQUEST_BYTES
  ) {
    throw new Error(
      `mobile capability input exceeds ${MAX_REQUEST_BYTES} bytes`,
    );
  }
  return {
    schemaVersion: 1,
    action: "invoke",
    commandId: value.commandId,
    input: value.input,
  };
}

function normalizedResult(result: MobileCommandResult): MobileCommandResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("mobile capability result must be JSON");
  }
  if (serialized === undefined) return undefined;
  if (encoder.encode(serialized).byteLength > MAX_RESULT_BYTES) {
    throw new Error(
      `mobile capability result exceeds ${MAX_RESULT_BYTES} bytes`,
    );
  }
  return JSON.parse(serialized) as MobileCommandResult;
}

function boundedError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Mobile capability failed";
  let output = "";
  for (const character of message) {
    if (encoder.encode(output + character).byteLength > MAX_ERROR_BYTES) break;
    output += character;
  }
  return output || "Mobile capability failed";
}

function safelyReportFailure(
  report: (message: string) => void | Promise<void>,
  message: string,
): void {
  try {
    void Promise.resolve(report(message)).catch(() => {});
  } catch {
    // Optional platform diagnostics cannot affect hosted product execution.
  }
}

async function invokeWithLifetime(
  host: MobileHost,
  commandId: string,
  input: unknown,
  callerSignal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal,
  timeoutMs: number,
): Promise<MobileCommandResult> {
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const callerAbort = () => abortFrom(callerSignal!);
  const lifecycleAbort = () => abortFrom(lifecycleSignal);
  callerSignal?.addEventListener("abort", callerAbort, { once: true });
  lifecycleSignal.addEventListener("abort", lifecycleAbort, { once: true });
  if (callerSignal?.aborted) abortFrom(callerSignal);
  if (lifecycleSignal.aborted) abortFrom(lifecycleSignal);
  const timer = setTimeout(
    () => controller.abort(new MobileInvocationTimeoutError()),
    timeoutMs,
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    }
  });
  try {
    return await Promise.race([
      host.invoke(commandId, input, controller.signal),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", callerAbort);
    lifecycleSignal.removeEventListener("abort", lifecycleAbort);
  }
}

function installedCapabilities(
  host: MobileHost,
  applicationHash: string,
  lifecycleSignal: AbortSignal,
  timeoutMs: number,
): HostedMobileCapabilities {
  return Object.freeze({
    schemaVersion: 1 as const,
    applicationHash,
    list: () => host.list().map(({ id }) => ({ id })),
    async invoke(
      input: unknown,
      signal?: AbortSignal,
    ): Promise<HostedMobileInvokeResultV1> {
      let request: HostedMobileInvokeRequestV1;
      try {
        request = decodeInvokeRequest(input);
      } catch (error) {
        return {
          schemaVersion: 1,
          status: "error",
          error: boundedError(error),
        };
      }
      try {
        const result = normalizedResult(
          await invokeWithLifetime(
            host,
            request.commandId,
            request.input,
            signal,
            lifecycleSignal,
            timeoutMs,
          ),
        );
        return {
          schemaVersion: 1,
          status: "ok",
          ...(result === undefined ? {} : { result }),
        };
      } catch (error) {
        if (signal?.aborted || lifecycleSignal.aborted) {
          return {
            schemaVersion: 1,
            status: "cancelled",
            error: boundedError(signal?.reason ?? lifecycleSignal.reason),
          };
        }
        const message = boundedError(error);
        return {
          schemaVersion: 1,
          status: message.includes("is unavailable") ? "unavailable" : "error",
          error: message,
        };
      }
    },
  });
}

export interface HostedMobileMountOptions {
  native: boolean;
  configuredServerUrl: string;
  currentUrl: string;
  applicationHash: string | undefined;
  bodyApplicationHash: string | undefined;
  packages: readonly MobileHostPackage[];
  createHost?: typeof createMobileHost;
  invokeTimeoutMs?: number;
  reportFailure?(message: string): void | Promise<void>;
  onPageHide?(dispose: () => void): void;
}

/**
 * Mounts only immutable-application mobile Contributions on the configured
 * hosted origin. A missing or failed optional host leaves the WebUI untouched.
 */
export async function mountHostedMobileCapabilities(
  options: HostedMobileMountOptions,
): Promise<HostedMobileCapabilities | undefined> {
  if (!options.native) return undefined;
  let configured: URL;
  let current: URL;
  try {
    configured = new URL(options.configuredServerUrl);
    current = new URL(options.currentUrl);
  } catch {
    return undefined;
  }
  if (
    configured.origin !== current.origin ||
    !options.applicationHash ||
    options.applicationHash !== options.bodyApplicationHash ||
    !isApplicationDeploymentHash(options.applicationHash)
  ) {
    return undefined;
  }
  const reportFailure =
    options.reportFailure ??
    ((message: string) =>
      console.error("Optional mobile capabilities failed", message));
  let host: MobileHost;
  try {
    host = await (options.createHost ?? createMobileHost)({
      adapters: createCapacitorAdapters(),
      packages: options.packages,
    });
  } catch (error) {
    safelyReportFailure(reportFailure, boundedError(error));
    return undefined;
  }
  const timeoutMs = Math.min(
    MAX_INVOKE_TIMEOUT_MS,
    Math.max(1, options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS),
  );
  const lifecycle = new AbortController();
  const capabilities = installedCapabilities(
    host,
    options.applicationHash,
    lifecycle.signal,
    timeoutMs,
  );
  options.onPageHide?.(() => {
    lifecycle.abort(new Error("mobile capability lifecycle detached"));
    void Promise.resolve()
      .then(() => host.dispose())
      .catch((error) =>
        safelyReportFailure(reportFailure, boundedError(error)),
      );
  });
  return capabilities;
}

export async function startHostedMobileCapabilities(
  packages: readonly MobileHostPackage[],
): Promise<void> {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="frockbot-application"]',
  )?.content;
  const capabilities = await mountHostedMobileCapabilities({
    native: Capacitor.isNativePlatform(),
    configuredServerUrl: (
      Capacitor as typeof Capacitor & { getServerUrl(): string }
    ).getServerUrl(),
    currentUrl: window.location.href,
    applicationHash: meta,
    bodyApplicationHash: document.body.dataset.frockbotUserApplication,
    packages,
    onPageHide(dispose) {
      window.addEventListener(
        "pagehide",
        () => {
          delete window.frockbotMobile;
          dispose();
        },
        { once: true },
      );
    },
  });
  if (capabilities) window.frockbotMobile = capabilities;
}
