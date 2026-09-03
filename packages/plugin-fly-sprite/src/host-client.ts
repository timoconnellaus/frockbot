/**
 * The Bot Durable Object's side of the shared Computer host (ADR 0004).
 *
 * This is a transport and nothing else. It speaks the v1 protocol of
 * `@frockbot/computer-host-protocol` over the `COMPUTER_HOST` service binding,
 * decodes every answer at the seam, and translates a host failure into the
 * provider-neutral `ComputerError` the Computer interface declares. It holds
 * no Sprites SDK, no `SPRITES_TOKEN`, and no knowledge of what a script does:
 * "Secrets remain server-side and cross interfaces only as opaque references
 * when necessary", so what leaves the Durable Object is a `credentialRef` the
 * host resolves.
 *
 * It lives in this Package rather than in `computer-core` because the protocol
 * it speaks is not provider-neutral: `ComputerHostOpenResultV1` answers with a
 * `spriteName`, and the host it addresses is the Fly Sprites host. "Electron,
 * Cloudflare, provider SDK, and Computer implementation types remain inside
 * their adapters" — this is that adapter, and `computer-core` stays free of
 * both the wire protocol and the binding.
 *
 * Two behaviours are load-bearing and are the reason this is a class rather
 * than a function:
 *
 * - **Framing.** Streamed open and exec answer NDJSON, and a transport chunk
 *   boundary means nothing: a frame may be split across two chunks or three
 *   frames may arrive in one. Their frame readers find the newline; this
 *   client never reads a chunk as a frame.
 * - **Cancellation.** "Connections to the Computer are expected to drop on
 *   every pause." A caller's abort aborts the fetch *and* posts a `cancel` for
 *   the same `effectId`, because a dropped connection alone leaves the process
 *   running on the Computer.
 */

import { ComputerError, type ComputerErrorCode } from "@frockbot/computer-core";
import {
  COMPUTER_HOST_LIMITS,
  COMPUTER_HOST_PROTOCOL_VERSION,
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  ComputerHostExecFrameReaderV1,
  ComputerHostOpenFrameReaderV1,
  decodeComputerHostCancelResultV1,
  decodeComputerHostControlResultV1,
  decodeComputerHostExecResultV1,
  decodeComputerHostFileDeleteResultV1,
  decodeComputerHostFileListResultV1,
  decodeComputerHostFileReadResultV1,
  decodeComputerHostFileStatResultV1,
  decodeComputerHostFileWriteResultV1,
  decodeComputerHostOpenResultV1,
  decodeComputerHostProblemV1,
  decodeComputerHostServiceResultV1,
  decodeComputerHostViewerResultV1,
  encodeComputerHostRequestV1,
  type ComputerHostCancelResultV1,
  type ComputerHostControlActionV1,
  type ComputerHostControlScopeV1,
  type ComputerHostControlResultV1,
  type ComputerHostErrorCodeV1,
  type ComputerHostFileDeleteResultV1,
  type ComputerHostFileListResultV1,
  type ComputerHostFileReadResultV1,
  type ComputerHostFileStatResultV1,
  type ComputerHostFileWriteResultV1,
  type ComputerHostOpenResultV1,
  type ComputerHostOperationKindV1,
  type ComputerHostOperationV1,
  type ComputerHostProvisioningV1,
  type ComputerHostServiceResultV1,
  type ComputerHostViewerResultV1,
} from "@frockbot/computer-host-protocol";

/**
 * The origin every request is addressed to. A service binding routes by
 * binding and ignores the host, so this names the seam rather than a network
 * location: the Computer host has no public route (`apps/computer-host`
 * declares none) and is unreachable except through the binding.
 */
export const COMPUTER_HOST_ORIGIN = "http://computer-host.internal";

/** How long past a caller's own timeout the client waits before giving up. */
export const COMPUTER_HOST_TIMEOUT_GRACE_MS = 5_000;

/** The deadline for a call that declares none of its own. */
export const COMPUTER_HOST_DEFAULT_TIMEOUT_MS = 120_000;

/** The deadline for a best-effort cancel, which must never outlive its caller. */
const CANCEL_TIMEOUT_MS = 5_000;

/**
 * The `COMPUTER_HOST` service binding, narrowed to the one method used.
 * A Worker `Fetcher` satisfies it; so does a test double, which is the point.
 */
export interface ComputerHostFetcherV1 {
  fetch(request: Request): Promise<Response>;
}

export interface ComputerHostClientOptions {
  fetcher: ComputerHostFetcherV1;
  /**
   * The shared secret between this Worker, the host Worker, and the container.
   * The service binding is already unroutable; this is the second lock, so a
   * container reached by any other path still refuses.
   */
  hostToken: string;
  /** Whose Computer this is. One Computer per User (ADR 0012). */
  identity: { userId: string };
  /** The Bot making the call, a tenant on that Computer. */
  tenant: { botId: string };
  /**
   * The opaque reference the host resolves to a credential. It carries no
   * credential material and is `sprites:user:<userId>` unless a caller names
   * another; shipping it from day one is what lets the ADR 0004 credential
   * broker land without a protocol version bump.
   */
  credentialRef?: string;
  origin?: string;
  timeoutGraceMs?: number;
  /**
   * Mints the effect identifier for a call that supplies none. The Durable
   * Object supplies one for every effect it has recorded; this covers the
   * calls that have no recorded intent, so a cancel can still name what it is
   * cancelling.
   */
  newEffectId?: () => string;
}

export interface ComputerHostCallOptions {
  signal?: AbortSignal;
  effectId?: string;
  /** Overrides the deadline this call is given, in milliseconds. */
  timeoutMs?: number;
}

export interface ComputerHostOpenOptionsV1 extends ComputerHostCallOptions {
  /**
   * Receives each provisioning phase while `open` remains in flight. Its
   * presence selects the NDJSON response; without it `open` stays buffered.
   */
  onProgress?(progress: ComputerHostProvisioningV1): void | Promise<void>;
}

export interface ComputerHostExecCommandV1 {
  /** Shell source delivered on the command's stdin. Never on its argv. */
  script: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Extra stdin appended after the script. */
  stdin?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * NDJSON frames rather than one buffered answer. On by default: a streamed
   * exec bounds its output as it arrives and its cancel reaches a process that
   * is still running.
   */
  stream?: boolean;
}

export interface ComputerHostExecOutcomeV1 {
  effectId: string;
  exitCode: number | null;
  signal?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** True when the host truncated, or when this client stopped accumulating. */
  outputTruncated: boolean;
}

const EMPTY = new Uint8Array(0);

/**
 * The host's failure vocabulary mapped onto the Computer interface's.
 *
 * `timeout` becomes `provider-unavailable` rather than a code of its own: to
 * the Bot, a Computer that did not answer in time is a Computer that is not
 * available right now, and the retry decision is the same one.
 */
const ERROR_CODES: Record<ComputerHostErrorCodeV1, ComputerErrorCode> = {
  "invalid-request": "invalid-request",
  // The token is wrong or missing. That is a deployment fault, not a Computer
  // fault, and retrying it changes nothing.
  "not-authorized": "provider-failure",
  "not-found": "provider-failure",
  conflict: "conflict",
  "limit-exceeded": "limit-exceeded",
  "human-control-active": "human-control-active",
  "computer-updating": "updating",
  aborted: "aborted",
  timeout: "provider-unavailable",
  "provider-unavailable": "provider-unavailable",
  "provider-failure": "provider-failure",
};

function toBytes(base64: string): Uint8Array {
  if (!base64) return EMPTY;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0] ?? EMPTY;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** Accumulates one output stream up to a declared ceiling, and no further. */
class BoundedOutput {
  private readonly parts: Uint8Array[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Uint8Array): void {
    if (!chunk.byteLength) return;
    const room = this.limit - this.length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength > room) {
      this.parts.push(chunk.subarray(0, room));
      this.length += room;
      this.truncated = true;
      return;
    }
    this.parts.push(chunk);
    this.length += chunk.byteLength;
  }

  bytes(): Uint8Array {
    return this.parts.length ? concat(this.parts, this.length) : EMPTY;
  }
}

function defaultEffectId(): string {
  return crypto.randomUUID();
}

/**
 * A call in flight: its deadline, the caller's abort, and which of the two
 * fired.
 *
 * They are one object because the answer to "why did this stop" decides the
 * `ComputerError` the caller sees, and reading it off a bare `AbortSignal`
 * cannot tell a caller's cancellation from an expired deadline.
 */
class CallLease {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detach: (() => void) | undefined;
  timedOut = false;

  constructor(
    deadlineMs: number,
    private readonly caller: AbortSignal | undefined,
  ) {
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, deadlineMs);
    if (caller) {
      if (caller.aborted) {
        this.controller.abort();
      } else {
        const onAbort = () => this.controller.abort();
        caller.addEventListener("abort", onAbort, { once: true });
        this.detach = () => caller.removeEventListener("abort", onAbort);
      }
    }
  }

  get callerAborted(): boolean {
    return this.caller?.aborted === true;
  }

  release(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.detach?.();
    this.detach = undefined;
  }
}

export class ComputerHostClient {
  private readonly fetcher: ComputerHostFetcherV1;
  private readonly hostToken: string;
  private readonly origin: string;
  private readonly grace: number;
  private readonly newEffectId: () => string;
  readonly identity: { userId: string };
  readonly tenant: { botId: string };
  readonly credentialRef: string;

  constructor(options: ComputerHostClientOptions) {
    this.fetcher = options.fetcher;
    this.hostToken = options.hostToken;
    this.identity = { userId: options.identity.userId };
    this.tenant = { botId: options.tenant.botId };
    this.credentialRef =
      options.credentialRef ?? `sprites:user:${options.identity.userId}`;
    this.origin = options.origin ?? COMPUTER_HOST_ORIGIN;
    this.grace = options.timeoutGraceMs ?? COMPUTER_HOST_TIMEOUT_GRACE_MS;
    this.newEffectId = options.newEffectId ?? defaultEffectId;
  }

  /** A client for another Bot on the same User's Computer. */
  forTenant(botId: string): ComputerHostClient {
    return new ComputerHostClient({
      fetcher: this.fetcher,
      hostToken: this.hostToken,
      identity: this.identity,
      tenant: { botId },
      credentialRef: this.credentialRef,
      origin: this.origin,
      timeoutGraceMs: this.grace,
      newEffectId: this.newEffectId,
    });
  }

  async open(
    options?: ComputerHostOpenOptionsV1,
  ): Promise<ComputerHostOpenResultV1> {
    if (!options?.onProgress) {
      return this.json(
        { kind: "open" },
        decodeComputerHostOpenResultV1,
        options,
      );
    }
    const effectId = this.effectIdFor(options);
    const lease = this.lease(COMPUTER_HOST_DEFAULT_TIMEOUT_MS, options);
    try {
      const response = await this.send(
        { kind: "open", stream: true },
        effectId,
        lease,
      );
      return await this.readOpenStream(
        response,
        lease,
        effectId,
        options.onProgress,
      );
    } catch (error) {
      // A host that predates streamed `open` rejects the request while
      // decoding it — "unknown field: stream" — and the decode is the first
      // thing it does, before it touches a Sprite. So this exact refusal is
      // the one failure here that provably started no work, and asking again
      // without progress is a second first attempt rather than a retry of an
      // admitted effect.
      //
      // The skew is real and expected: `apps/cloudflare/wrangler.jsonc` binds
      // staging to the *production* Computer host, so every merge to main
      // meets a host that a version tag has not yet moved. Losing the progress
      // report is the correct price; failing every Computer open until the tag
      // lands is not.
      if (
        !(error instanceof ComputerError) ||
        error.code !== ERROR_CODES["invalid-request"]
      ) {
        throw error;
      }
      return await this.json(
        { kind: "open" },
        decodeComputerHostOpenResultV1,
        options,
      );
    } finally {
      lease.release();
    }
  }

  /**
   * Runs one bash document on the Computer.
   *
   * The script travels in the request body and reaches the command on its
   * stdin. It is never argv: the Sprites SDK appends every argv element to the
   * request URL, and a provisioning script answered HTTP 431 — the measurement
   * recorded in ADR 0004 and the reason this seam exists.
   */
  async exec(
    command: ComputerHostExecCommandV1,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostExecOutcomeV1> {
    const timeoutMs = Math.max(
      1,
      Math.min(
        command.timeoutMs ?? COMPUTER_HOST_DEFAULT_TIMEOUT_MS,
        COMPUTER_HOST_LIMITS.execTimeoutMs,
      ),
    );
    const maxOutputBytes = Math.max(
      1,
      Math.min(
        command.maxOutputBytes ?? COMPUTER_HOST_LIMITS.maxOutputBytes,
        COMPUTER_HOST_LIMITS.maxOutputBytes,
      ),
    );
    const stream = command.stream ?? true;
    const operation: ComputerHostOperationV1 = {
      kind: "exec",
      script: command.script,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      ...(command.env === undefined ? {} : { env: command.env }),
      ...(command.stdin === undefined
        ? {}
        : { stdinBase64: fromBytes(command.stdin) }),
      timeoutMs,
      maxOutputBytes,
      stream,
    };
    const effectId = this.effectIdFor(options);
    const lease = this.lease(timeoutMs, options);
    let response: Response;
    try {
      response = await this.send(operation, effectId, lease);
    } catch (error) {
      lease.release();
      throw error;
    }
    if (!stream) {
      try {
        const result = decodeComputerHostExecResultV1(
          await this.body(response, lease, effectId),
        );
        return {
          effectId,
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          stdout: toBytes(result.stdoutBase64),
          stderr: toBytes(result.stderrBase64),
          outputTruncated: result.outputTruncated,
        };
      } finally {
        lease.release();
      }
    }
    try {
      return await this.drain(response, lease, effectId, maxOutputBytes);
    } finally {
      lease.release();
    }
  }

  fileRead(
    path: string,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostFileReadResultV1> {
    return this.json(
      { kind: "file/read", path },
      decodeComputerHostFileReadResultV1,
      options,
    );
  }

  fileWrite(
    path: string,
    bytes: Uint8Array,
    options?: ComputerHostCallOptions & { mode?: number },
  ): Promise<ComputerHostFileWriteResultV1> {
    return this.json(
      {
        kind: "file/write",
        path,
        bytesBase64: fromBytes(bytes),
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
      },
      decodeComputerHostFileWriteResultV1,
      options,
    );
  }

  fileList(
    path: string,
    options?: ComputerHostCallOptions & { recursive?: boolean },
  ): Promise<ComputerHostFileListResultV1> {
    return this.json(
      { kind: "file/list", path, recursive: options?.recursive ?? false },
      decodeComputerHostFileListResultV1,
      options,
    );
  }

  fileStat(
    path: string,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostFileStatResultV1> {
    return this.json(
      { kind: "file/stat", path },
      decodeComputerHostFileStatResultV1,
      options,
    );
  }

  fileDelete(
    path: string,
    options?: ComputerHostCallOptions & { recursive?: boolean },
  ): Promise<ComputerHostFileDeleteResultV1> {
    return this.json(
      { kind: "file/delete", path, recursive: options?.recursive ?? false },
      decodeComputerHostFileDeleteResultV1,
      options,
    );
  }

  control(
    action: ComputerHostControlActionV1,
    ownerId: string,
    maxAgeSeconds: number,
    options?: ComputerHostCallOptions & {
      scope?: ComputerHostControlScopeV1;
    },
  ): Promise<ComputerHostControlResultV1> {
    return this.json(
      {
        kind: "control",
        action,
        ownerId,
        maxAgeSeconds,
        // Absent ⇒ legacy `bot`. Human sessions and `computerUse` explicitly
        // name the User-wide `desktop-gui` screen lease.
        ...(options?.scope === undefined ? {} : { scope: options.scope }),
      },
      decodeComputerHostControlResultV1,
      options,
    );
  }

  viewer(
    action: "open" | "renew" | "revoke",
    options?: ComputerHostCallOptions & { sessionId?: string },
  ): Promise<ComputerHostViewerResultV1> {
    return this.json(
      {
        kind: "viewer",
        action,
        ...(options?.sessionId === undefined
          ? {}
          : { sessionId: options.sessionId }),
      },
      decodeComputerHostViewerResultV1,
      options,
    );
  }

  service(
    name: string,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostServiceResultV1> {
    return this.json(
      { kind: "service", name },
      decodeComputerHostServiceResultV1,
      options,
    );
  }

  /**
   * Cancels the effect this identifier names.
   *
   * There is no second identifier in the DTO: the envelope's `effectId` *is*
   * what is being cancelled, so a cancel cannot disagree with itself.
   */
  cancel(
    effectId: string,
    options?: ComputerHostCallOptions,
  ): Promise<ComputerHostCancelResultV1> {
    return this.json({ kind: "cancel" }, decodeComputerHostCancelResultV1, {
      ...options,
      effectId,
      timeoutMs: options?.timeoutMs ?? CANCEL_TIMEOUT_MS,
    });
  }

  // --- internals -----------------------------------------------------------

  private effectIdFor(options: ComputerHostCallOptions | undefined): string {
    return options?.effectId?.trim() || this.newEffectId();
  }

  /**
   * The client's own deadline: the host's, plus a grace.
   *
   * The grace is what lets the host's per-phase timeout answer first. Without
   * it the two deadlines race, and a command that the host killed cleanly at
   * 120 s would reach the caller as an unexplained transport failure instead
   * of the `timeout` problem the host wrote.
   */
  private lease(
    timeoutMs: number,
    options: ComputerHostCallOptions | undefined,
  ): CallLease {
    return new CallLease(
      (options?.timeoutMs ?? timeoutMs) + this.grace,
      options?.signal,
    );
  }

  private async json<T>(
    operation: ComputerHostOperationV1,
    decode: (input: unknown) => T,
    options: ComputerHostCallOptions | undefined,
  ): Promise<T> {
    const effectId = this.effectIdFor(options);
    const lease = this.lease(COMPUTER_HOST_DEFAULT_TIMEOUT_MS, options);
    try {
      const response = await this.send(operation, effectId, lease);
      return decode(await this.body(response, lease, effectId));
    } finally {
      lease.release();
    }
  }

  private async send(
    operation: ComputerHostOperationV1,
    effectId: string,
    lease: CallLease,
  ): Promise<Response> {
    const kind: ComputerHostOperationKindV1 = operation.kind;
    const body = JSON.stringify(
      encodeComputerHostRequestV1({
        version: COMPUTER_HOST_PROTOCOL_VERSION,
        effectId,
        identity: this.identity,
        tenant: this.tenant,
        credentialRef: this.credentialRef,
        operation,
      }),
    );
    let response: Response;
    try {
      response = await this.fetcher.fetch(
        new Request(`${this.origin}${COMPUTER_HOST_ROUTES[kind]}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [COMPUTER_HOST_TOKEN_HEADER]: this.hostToken,
          },
          body,
          signal: lease.controller.signal,
        }),
      );
    } catch (error) {
      throw this.refuse(error, lease, effectId, kind !== "cancel");
    }
    if (response.ok) return response;
    throw await this.problem(response, lease, effectId);
  }

  /** Reads one JSON answer, translating a mid-read abort like any other. */
  private async body(
    response: Response,
    lease: CallLease,
    effectId: string,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw this.refuse(error, lease, effectId, false);
    }
  }

  /**
   * Reads an NDJSON open stream to its terminal result.
   *
   * The body is drained even after a progress callback fails, because the
   * result is what makes the already-admitted open's outcome known. An EOF
   * without that result is the shape of a container restart and is therefore
   * retryable unavailability, exactly as it is for streamed exec.
   */
  private async readOpenStream(
    response: Response,
    lease: CallLease,
    effectId: string,
    onProgress: (progress: ComputerHostProvisioningV1) => void | Promise<void>,
  ): Promise<ComputerHostOpenResultV1> {
    if (!response.body) {
      throw new ComputerError(
        "provider-failure",
        "The Computer host answered an open stream with no body",
      );
    }
    const reader = response.body.getReader();
    const frames = new ComputerHostOpenFrameReaderV1();
    let result: ComputerHostOpenResultV1 | undefined;
    let failure: ComputerError | undefined;
    let callbackFailed = false;
    let callbackFailure: unknown;

    const consume = async (
      batch: ReturnType<ComputerHostOpenFrameReaderV1["push"]>,
    ): Promise<void> => {
      for (const frame of batch) {
        if (frame.type === "progress") {
          if (!callbackFailed) {
            try {
              await onProgress(frame.progress);
            } catch (error) {
              callbackFailed = true;
              callbackFailure = error;
            }
          }
        } else if (frame.type === "result") {
          result = frame.result;
        } else {
          failure ??= new ComputerError(
            ERROR_CODES[frame.code],
            frame.message,
            frame.retryable,
          );
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) await consume(frames.push(value));
      }
      await consume(frames.end());
    } catch (error) {
      throw this.refuse(error, lease, effectId, true);
    } finally {
      reader.releaseLock();
    }

    if (callbackFailed) throw callbackFailure;
    if (failure) throw failure;
    if (!result) {
      throw new ComputerError(
        "provider-unavailable",
        "The Computer host open stream ended before the Computer opened",
        true,
      );
    }
    return result;
  }

  /**
   * Reads an NDJSON exec stream to its end.
   *
   * Output past `maxOutputBytes` is dropped rather than accumulated, and the
   * stream is still read to completion: the exit frame is what says whether
   * the command succeeded, and abandoning the read to save bytes would trade a
   * known outcome for an unknown one.
   */
  private async drain(
    response: Response,
    lease: CallLease,
    effectId: string,
    maxOutputBytes: number,
  ): Promise<ComputerHostExecOutcomeV1> {
    if (!response.body) {
      throw new ComputerError(
        "provider-failure",
        "The Computer host answered an exec stream with no body",
      );
    }
    const reader = response.body.getReader();
    const frames = new ComputerHostExecFrameReaderV1();
    const stdout = new BoundedOutput(maxOutputBytes);
    const stderr = new BoundedOutput(maxOutputBytes);
    let exit: { exitCode: number | null; signal?: string } | undefined;
    let hostTruncated = false;
    let failure: ComputerError | undefined;

    const consume = (
      batch: ReturnType<ComputerHostExecFrameReaderV1["push"]>,
    ) => {
      for (const frame of batch) {
        if (frame.type === "stdout") {
          stdout.push(toBytes(frame.dataBase64));
        } else if (frame.type === "stderr") {
          stderr.push(toBytes(frame.dataBase64));
        } else if (frame.type === "exit") {
          exit = {
            exitCode: frame.exitCode,
            ...(frame.signal ? { signal: frame.signal } : {}),
          };
          hostTruncated = frame.outputTruncated;
        } else {
          failure ??= new ComputerError(
            ERROR_CODES[frame.code],
            frame.message,
            frame.retryable,
          );
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) consume(frames.push(value));
      }
      consume(frames.end());
    } catch (error) {
      throw this.refuse(error, lease, effectId, true);
    } finally {
      reader.releaseLock();
    }

    if (failure) throw failure;
    if (!exit) {
      // The stream ended without an outcome. That is the shape of a container
      // that restarted mid-exec: "In-flight exec dies; the DO sees a stream
      // error", and the effect's outcome is unknown rather than failed.
      throw new ComputerError(
        "provider-unavailable",
        "The Computer host exec stream ended before the command exited",
        true,
      );
    }
    return {
      effectId,
      exitCode: exit.exitCode,
      ...(exit.signal ? { signal: exit.signal } : {}),
      stdout: stdout.bytes(),
      stderr: stderr.bytes(),
      outputTruncated: hostTruncated || stdout.truncated || stderr.truncated,
    };
  }

  /** Turns a non-2xx answer into the `ComputerError` its problem body declares. */
  private async problem(
    response: Response,
    lease: CallLease,
    effectId: string,
  ): Promise<ComputerError> {
    let decoded: ReturnType<typeof decodeComputerHostProblemV1> | undefined;
    try {
      decoded = decodeComputerHostProblemV1(await response.json());
    } catch {
      decoded = undefined;
    }
    if (!decoded) {
      // A body this client cannot decode is still a refusal, and the status is
      // the only thing left that means anything. 429 is the load shed the
      // container declares; everything else is the host misbehaving.
      return response.status === 429
        ? new ComputerError(
            "limit-exceeded",
            "The Computer host is shedding load",
            true,
          )
        : new ComputerError(
            "provider-failure",
            `The Computer host answered ${response.status} with an undecodable body`,
            response.status >= 500,
          );
    }
    if (decoded.code === "aborted" && lease.callerAborted) {
      this.cancelQuietly(effectId);
    }
    return new ComputerError(
      ERROR_CODES[decoded.code],
      decoded.message,
      decoded.retryable,
    );
  }

  /**
   * Classifies a thrown transport failure.
   *
   * Three things look alike at the `fetch` seam and mean different things: the
   * caller cancelled, the deadline expired, or the host never answered. Only
   * the first is the caller's own doing, and only it posts a cancel — the
   * other two leave the host to its own timeout.
   */
  private refuse(
    error: unknown,
    lease: CallLease,
    effectId: string,
    cancellable: boolean,
  ): ComputerError {
    if (lease.callerAborted) {
      if (cancellable) this.cancelQuietly(effectId);
      return new ComputerError(
        "aborted",
        "The Computer effect was cancelled",
        false,
        { cause: error },
      );
    }
    if (lease.timedOut) {
      return new ComputerError(
        "provider-unavailable",
        "The Computer host did not answer within the effect's deadline",
        true,
        { cause: error },
      );
    }
    return new ComputerError(
      "provider-unavailable",
      `The Computer host is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      true,
      { cause: error },
    );
  }

  /**
   * Tells the host to kill a process this client has stopped listening to.
   *
   * Best-effort by construction: the caller has already given up, so a failed
   * cancel must not become the error it sees. The host's own per-phase timeout
   * is the backstop when this never arrives.
   */
  private cancelQuietly(effectId: string): void {
    void this.cancel(effectId).catch(() => undefined);
  }
}
