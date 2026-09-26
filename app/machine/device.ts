// The device agent's loop, with nothing native in it.
//
// This is the real agent — the one the Electron shell runs — and it is written
// here rather than in `src/desktop.ts` for one reason: everything that decides
// *what happens* must run in CI. So the loop holds no `child_process`, no
// `node:fs`, no `electron` and no ambient clock. It is handed five seams:
//
//   fetch      how a request leaves the laptop
//   webSocket  how the one socket to the backend is opened
//   secrets    where the machine token rests between runs (the OS keychain)
//   runner     what actually executes an op (the only untested surface)
//   clock      `now` and `sleep`, so backoff is asserted rather than waited on
//
// Commands arrive down one WebSocket the User Durable Object holds while it
// hibernates; claims and results go back as ordinary POSTs.
//
// `MachineAgentDriverV1` in `./testing.ts` is the *stub* agent: it speaks the
// same wire but scripts its answers. This is the shipped one. They are checked
// against each other in `apps/cloudflare/test/machines-desktop.workerd.ts`,
// which is what "byte-identical behaviour to the stub" means in the plan.
//
// Two behaviours are worth naming because they are policy, not plumbing:
//
//  1. **A 401 un-enrols.** Revocation bumps `keyVersion`, so a revoked token
//     fails every route forever, and a revoked machine's socket is closed with
//     `4001`. An agent that kept retrying would knock on a door that will never
//     open again and would keep a dead secret on disk. The stored token is
//     cleared and the loop stops.
//  2. **A command is claimed before it is run and answered after.** A claim
//     that loses the race answers `already-claimed` and the agent does not
//     run it: first claim wins is the protocol's guarantee against a duplicate
//     delivery running twice, and the agent is the half that honours it.

import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineIdV1,
  decodeMachineResultReceiptV1,
  decodeMachineSocketFrameV1,
  MACHINE_SOCKET_REVOKED_CODE_V1,
  machineRoutePathV1,
  type MachineCapabilityV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineModuleCallFrameV1,
  type MachineModuleV1,
  type MachinePlatformV1,
} from "@frockbot/core/machine-protocol";

// ---------------------------------------------------------------------------
// What the agent remembers between runs
// ---------------------------------------------------------------------------

/**
 * The whole of the agent's durable state: which machine it is and the token
 * that proves it. It is written to the OS secure store and nowhere else — not
 * to a log, not to a preference file, and never back over the wire.
 */
export interface MachineEnrollmentStateV1 {
  schemaVersion: 1;
  machineId: string;
  token: string;
  /** The origin this token was minted by. A token is not portable. */
  origin: string;
  label: string;
  enrolledAt: string;
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MachineDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new MachineDecodeError(
      `${label} exceeds ${max} characters`,
      "limit-exceeded",
    );
  }
  return value;
}

function origin(value: unknown, label: string): string {
  const raw = text(value, 2_048, label);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MachineDecodeError(`${label} must be a URL`);
  }
  if (
    url.origin !== raw ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  ) {
    throw new MachineDecodeError(`${label} must be an http(s) origin`);
  }
  return url.origin;
}

export function decodeMachineEnrollmentStateV1(
  input: unknown,
  label = "machine enrollment state",
): MachineEnrollmentStateV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "machineId",
    "token",
    "origin",
    "label",
    "enrolledAt",
  ];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new MachineDecodeError(`${label} has an unexpected key`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new MachineDecodeError(`${label} schemaVersion must be 1`);
  }
  const enrolledAt = text(value.enrolledAt, 64, `${label} enrolledAt`);
  if (Number.isNaN(Date.parse(enrolledAt))) {
    throw new MachineDecodeError(`${label} enrolledAt must be a timestamp`);
  }
  return {
    schemaVersion: 1,
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    token: text(value.token, 2_048, `${label} token`),
    origin: origin(value.origin, `${label} origin`),
    label: text(value.label, MACHINE_LIMITS_V1.label, `${label} label`),
    enrolledAt,
  };
}

/**
 * The OS secure store, as one string.
 *
 * A seam and not `safeStorage` directly, because the loop above must run in
 * CI and because a keychain that is unavailable (a headless Linux session, a
 * locked login keychain) is a *state the agent has to survive*, not a crash.
 */
export interface MachineSecretStoreV1 {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** A secret store that forgets on exit. Used by tests and by nothing else. */
export function createMemoryMachineSecretStoreV1(
  initial?: string,
): MachineSecretStoreV1 {
  let held = initial;
  return {
    read: () => Promise.resolve(held),
    write: (value) => {
      held = value;
      return Promise.resolve();
    },
    clear: () => {
      held = undefined;
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// What runs an op
// ---------------------------------------------------------------------------

/** A result as the machine reports it: the wire DTO minus what the caller adds. */
export type MachineCommandReportV1 = Omit<
  MachineCommandResultV1,
  "schemaVersion" | "commandId"
>;

/**
 * The one seam that touches the laptop. `src/desktop.ts` implements it with
 * `child_process` and `node:fs`; `src/device-runner.ts` holds every decision
 * either of them would otherwise make.
 */
export interface MachineCommandRunnerV1 {
  run(
    command: MachineCommandV1,
    signal: AbortSignal,
  ): Promise<MachineCommandReportV1>;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** The first retry delay, and the ceiling every later one is clamped to. */
export const MACHINE_AGENT_BACKOFF_V1 = {
  baseMs: 1_000,
  maxMs: 60_000,
  /** ± this fraction of the delay, so a fleet does not retry in lockstep. */
  jitter: 0.2,
} as const;

/**
 * How long the loop rests when this laptop is not paired.
 *
 * Not a backoff — nothing failed. An unpaired agent has no request to make, so
 * without this the loop would spin on an early return; with it, pairing is
 * picked up within a few seconds without the shell having to restart anything.
 */
export const MACHINE_AGENT_IDLE_MS_V1 = 5_000;

/**
 * How long to wait before reconnecting after `failures` consecutive failures.
 *
 * Pure, and jittered from an injected `random`, so a test asserts the exact
 * number rather than a range, and so a deploy that closes every socket at once
 * is not answered by every desktop at once. A socket that opened and later
 * closed counts as one failure.
 */
export function machineReconnectBackoffV1(
  failures: number,
  random: () => number = Math.random,
  bounds: {
    baseMs: number;
    maxMs: number;
    jitter: number;
  } = MACHINE_AGENT_BACKOFF_V1,
): number {
  if (failures <= 0) return 0;
  const exponential = bounds.baseMs * 2 ** Math.min(failures - 1, 16);
  const clamped = Math.min(exponential, bounds.maxMs);
  const spread = clamped * bounds.jitter;
  // random() in [0,1) maps to [-spread, +spread).
  return Math.max(0, Math.round(clamped + (random() * 2 - 1) * spread));
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

export interface MachineDeviceAgentStatusV1 {
  schemaVersion: 1;
  enrolled: boolean;
  running: boolean;
  machineId?: string;
  label?: string;
  origin?: string;
  /** When the socket last opened. */
  lastConnectedAt?: string;
  /** Why the last cycle failed, if it did. Never carries a token. */
  lastError?: string;
  /** Consecutive failures, which is what the backoff is a function of. */
  failures: number;
}

/**
 * The status as it crosses the IPC seam into the renderer.
 *
 * The settings section reads this from the Electron preload bridge, which is a
 * different runtime, so it is decoded like every other cross-runtime value.
 * Note what is *not* on it: no token, no machine token digest, no origin
 * secret — a status a renderer can read is a status that carries nothing that
 * proves anything.
 */
export function decodeMachineDeviceAgentStatusV1(
  input: unknown,
  label = "machine agent status",
): MachineDeviceAgentStatusV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "enrolled",
    "running",
    "machineId",
    "label",
    "origin",
    "lastConnectedAt",
    "lastError",
    "failures",
  ];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new MachineDecodeError(`${label} has an unexpected key`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new MachineDecodeError(`${label} schemaVersion must be 1`);
  }
  if (
    typeof value.enrolled !== "boolean" ||
    typeof value.running !== "boolean"
  ) {
    throw new MachineDecodeError(
      `${label} enrolled and running must be booleans`,
    );
  }
  if (
    !Number.isSafeInteger(value.failures) ||
    (value.failures as number) < 0 ||
    (value.failures as number) > 1_000_000
  ) {
    throw new MachineDecodeError(`${label} failures must be a counter`);
  }
  const optional = (
    key: "machineId" | "label" | "origin" | "lastConnectedAt" | "lastError",
  ): Record<string, string> | Record<string, never> =>
    value[key] === undefined
      ? {}
      : { [key]: text(value[key], 2_048, `${label} ${key}`) };
  return {
    schemaVersion: 1,
    enrolled: value.enrolled,
    running: value.running,
    ...optional("machineId"),
    ...optional("label"),
    ...optional("origin"),
    ...optional("lastConnectedAt"),
    ...optional("lastError"),
    failures: value.failures as number,
  };
}

/**
 * The one socket, as the agent reads it: frames pulled in order, so a command
 * that takes a minute to run holds the next frame rather than racing it.
 */
export interface MachineSocketV1 {
  /** The next event. After a `close`, every later call answers it again. */
  receive(): Promise<MachineSocketEventV1>;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export type MachineSocketEventV1 =
  | { type: "message"; data: string }
  | { type: "close"; code: number; reason: string };

/** What a platform WebSocket offers, whichever runtime built it. */
export interface MachineWebSocketLikeV1 {
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: {
      data?: unknown;
      code?: number;
      reason?: string;
    }) => void,
  ): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** A platform WebSocket, already open, as a `MachineSocketV1`. */
export function machineSocketFromWebSocketV1(
  socket: MachineWebSocketLikeV1,
): MachineSocketV1 {
  const queued: MachineSocketEventV1[] = [];
  const waiting: ((event: MachineSocketEventV1) => void)[] = [];
  let closed: MachineSocketEventV1 | undefined;
  const deliver = (event: MachineSocketEventV1): void => {
    if (closed) return;
    if (event.type === "close") closed = event;
    const waiter = waiting.shift();
    if (waiter) waiter(event);
    else queued.push(event);
    if (closed) for (const next of waiting.splice(0)) next(closed);
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      deliver({ type: "message", data: event.data });
    }
  });
  socket.addEventListener("close", (event) => {
    deliver({
      type: "close",
      code: event.code ?? 1006,
      reason: event.reason ?? "",
    });
  });
  socket.addEventListener("error", () => {
    deliver({ type: "close", code: 1006, reason: "socket error" });
  });
  return {
    receive: () => {
      const next = queued.shift() ?? closed;
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => waiting.push(resolve));
    },
    send: (text) => socket.send(text),
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * The `webSocket` seam over a `fetch` that can upgrade, as workerd's does: the
 * handshake is an ordinary request, so the token rides in the same header as
 * every other machine route and a refusal arrives with its status.
 */
export function fetchUpgradeMachineWebSocketV1(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): (url: string, token: string) => Promise<MachineSocketV1> {
  return async (url, token) => {
    const target = new URL(url);
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(target.toString(), {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    const socket = (
      response as Response & {
        webSocket?: MachineWebSocketLikeV1 & { accept(): void };
      }
    ).webSocket;
    if (response.status !== 101 || !socket) {
      const body = await response.text();
      throw new MachineDeviceAgentError(
        response.status,
        `machine socket was refused with ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    socket.accept();
    return machineSocketFromWebSocketV1(socket);
  };
}

/** How often the agent sends the keep-alive the backend answers unwoken. */
export const MACHINE_AGENT_PING_MS_V1 = 30_000;

export interface MachineDeviceAgentOptionsV1 {
  /** The deployment the machine dials. */
  origin: string;
  /** Injected: the platform's `fetch`. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /**
   * Open the socket at `url` (`wss:` for an `https:` origin) and resolve once
   * it is open. The token is presented as `Authorization: Bearer <token>`,
   * exactly as on every other machine route: the agent is never a browser,
   * and every runtime it runs in (workerd's fetch upgrade, Bun, Deno, Node,
   * Dart) can set a header on a WebSocket handshake. A refused upgrade
   * rejects, with a `MachineDeviceAgentError` carrying the status when the
   * runtime can see it.
   */
  webSocket(url: string, token: string): Promise<MachineSocketV1>;
  secrets: MachineSecretStoreV1;
  runner: MachineCommandRunnerV1;
  /** The machine's own name for itself — a hostname. */
  label: string;
  platform: MachinePlatformV1;
  agentVersion: string;
  capabilities: MachineCapabilityV1[];
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
  /** Called whenever the status changes, so a UI can render it. */
  onStatus?(status: MachineDeviceAgentStatusV1): void;
  /**
   * Called with the whole list of device modules this machine should run
   * (ADR 0037), on every connect and whenever the account's active
   * generation changes. Each list replaces the last; the agent keeps none.
   */
  onModules?(modules: MachineModuleV1[]): void;
  /**
   * Called with each call a Plugin makes to one of this machine's device
   * modules. Handed over and not awaited, so a slow module never holds the
   * frames behind it; the embedder claims, runs and answers it.
   */
  onCall?(call: MachineModuleCallFrameV1): void;
}

export class MachineDeviceAgentError extends Error {
  override readonly name = "MachineDeviceAgentError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One connection's outcome, for tests and for the status. */
export interface MachineDeviceAgentCycleV1 {
  /** False when there is no stored enrollment: nothing was attempted. */
  paired: boolean;
  /** Frames the backend sent while this connection was open. */
  frames: number;
  delivered: number;
  claimed: number;
  alreadyClaimed: number;
  reported: number;
  /** Set when the cycle failed; the loop backs off on it. */
  error?: string;
  /** True when a 401 un-enrolled this agent. */
  unenrolled?: boolean;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class MachineDeviceAgentV1 {
  private state: MachineEnrollmentStateV1 | undefined;
  private loaded = false;
  private running = false;
  private failures = 0;
  private lastConnectedAt: string | undefined;
  private lastError: string | undefined;
  private loop: Promise<void> | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly options: MachineDeviceAgentOptionsV1) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): number {
    return this.options.random?.() ?? Math.random();
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms, signal);
    return new Promise<void>((resolve) => {
      if (ms <= 0 || signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * The stored enrollment, read once and then held.
   *
   * A store that throws — a locked keychain — is not fatal: the agent reports
   * it as an error and stays un-enrolled, because pretending to be enrolled
   * with no token would just 401 in a loop.
   */
  private async enrollment(): Promise<MachineEnrollmentStateV1 | undefined> {
    if (this.loaded) return this.state;
    this.loaded = true;
    let raw: string | undefined;
    try {
      raw = await this.options.secrets.read();
    } catch (error) {
      this.lastError = `could not read the machine token: ${message(error)}`;
      return undefined;
    }
    if (raw === undefined) return undefined;
    try {
      const decoded = decodeMachineEnrollmentStateV1(JSON.parse(raw));
      // A token minted by another deployment is not this one's; forget it
      // rather than presenting it somewhere it can only fail.
      if (decoded.origin !== this.options.origin) {
        await this.forget();
        return undefined;
      }
      this.state = decoded;
    } catch (error) {
      this.lastError = `stored machine enrollment is unreadable: ${message(error)}`;
      await this.forget();
    }
    return this.state;
  }

  private async forget(): Promise<void> {
    this.state = undefined;
    try {
      await this.options.secrets.clear();
    } catch {
      // A store that cannot be cleared is still forgotten in memory; the next
      // load discards what it finds because it will not verify either.
    }
  }

  /** Whether a token is on this laptop. Reads the store on first call. */
  async paired(): Promise<boolean> {
    return (await this.enrollment()) !== undefined;
  }

  status(): MachineDeviceAgentStatusV1 {
    return {
      schemaVersion: 1,
      enrolled: this.state !== undefined,
      running: this.running,
      ...(this.state === undefined
        ? {}
        : {
            machineId: this.state.machineId,
            label: this.state.label,
            origin: this.state.origin,
          }),
      ...(this.lastConnectedAt === undefined
        ? {}
        : { lastConnectedAt: this.lastConnectedAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      failures: this.failures,
    };
  }

  private announce(): void {
    this.options.onStatus?.(this.status());
  }

  private async call(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await this.options.fetch(`${this.options.origin}${path}`, {
      ...init,
      headers,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new MachineDeviceAgentError(
        response.status,
        `machine request failed with ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    return body.length === 0 ? undefined : (JSON.parse(body) as unknown);
  }

  /**
   * Present a pairing code and become a registered machine.
   *
   * The code is the only secret that crosses from the browser to the laptop,
   * it is one-time, and it is never stored: what is stored is the token the
   * enrollment answered with.
   */
  async pair(code: string): Promise<MachineDeviceAgentStatusV1> {
    const presented = text(
      code.trim(),
      MACHINE_LIMITS_V1.pairingCode,
      "pairing code",
    );
    const receipt = decodeMachineEnrollmentReceiptV1(
      await this.call(machineRoutePathV1("enroll"), {
        method: "POST",
        token: presented,
        body: JSON.stringify({
          schemaVersion: 1,
          code: presented,
          label: this.options.label,
          platform: this.options.platform,
          agentVersion: this.options.agentVersion,
          capabilities: this.options.capabilities,
        }),
      }),
    );
    const state: MachineEnrollmentStateV1 = {
      schemaVersion: 1,
      machineId: receipt.machineId,
      token: receipt.token,
      origin: this.options.origin,
      label: this.options.label,
      enrolledAt: new Date(this.now()).toISOString(),
    };
    await this.options.secrets.write(JSON.stringify(state));
    this.state = state;
    this.loaded = true;
    this.failures = 0;
    this.lastError = undefined;
    this.announce();
    return this.status();
  }

  /** Forget the token on this laptop. The registry row is the browser's to revoke. */
  async unpair(): Promise<MachineDeviceAgentStatusV1> {
    await this.stop();
    await this.forget();
    this.loaded = true;
    this.failures = 0;
    this.lastError = undefined;
    this.announce();
    return this.status();
  }

  /** The socket's URL: this origin, as `wss:` for `https:`. */
  private socketUrl(machineId: string): string {
    const url = new URL(
      machineRoutePathV1("socket", { machineId }),
      this.options.origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  /**
   * Open the socket, or say why not.
   *
   * A runtime's WebSocket often cannot report the status of a refused upgrade.
   * The gateway checks the token before the upgrade, so a plain GET of the same
   * route answers `426` for a live token and `401` for a dead one — which is
   * the one distinction the agent must not miss.
   */
  private async open(
    state: MachineEnrollmentStateV1,
  ): Promise<MachineSocketV1> {
    try {
      return await this.options.webSocket(
        this.socketUrl(state.machineId),
        state.token,
      );
    } catch (error) {
      if (!(error instanceof MachineDeviceAgentError)) {
        try {
          await this.call(
            machineRoutePathV1("socket", { machineId: state.machineId }),
            { token: state.token },
          );
        } catch (probed) {
          if (
            probed instanceof MachineDeviceAgentError &&
            (probed.status === 401 || probed.status === 403)
          ) {
            throw probed;
          }
        }
      }
      throw error;
    }
  }

  /**
   * One connection: open the socket, then claim, run and answer every command
   * it delivers, until it closes, `signal` aborts, or `frames` frames have
   * been handled.
   *
   * Never throws. Every failure is a value, because the loop's job is to keep
   * reconnecting and a thrown error in a background loop is a silently dead
   * agent.
   */
  async connectOnce(
    options: { signal?: AbortSignal; frames?: number } = {},
  ): Promise<MachineDeviceAgentCycleV1> {
    const signal = options.signal ?? new AbortController().signal;
    const cycle: MachineDeviceAgentCycleV1 = {
      paired: true,
      frames: 0,
      delivered: 0,
      claimed: 0,
      alreadyClaimed: 0,
      reported: 0,
    };
    const state = await this.enrollment();
    if (!state) {
      cycle.paired = false;
      cycle.error = this.lastError ?? "this machine is not paired";
      return cycle;
    }
    let socket: MachineSocketV1 | undefined;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let stopped = (): void => {};
    const aborted = new Promise<MachineSocketEventV1>((resolve) => {
      stopped = () => resolve({ type: "close", code: 1000, reason: "stopped" });
      if (signal.aborted) stopped();
      else signal.addEventListener("abort", stopped, { once: true });
    });
    try {
      socket = await this.open(state);
      const open = socket;
      this.lastConnectedAt = new Date(this.now()).toISOString();
      this.failures = 0;
      this.lastError = undefined;
      this.announce();
      pinger = setInterval(() => {
        try {
          open.send("ping");
        } catch {
          // A socket that cannot take a ping is closing, and says so.
        }
      }, MACHINE_AGENT_PING_MS_V1);
      while (options.frames === undefined || cycle.frames < options.frames) {
        const event = await Promise.race([open.receive(), aborted]);
        if (event.type === "close") {
          if (signal.aborted) break;
          if (event.code === MACHINE_SOCKET_REVOKED_CODE_V1) {
            throw new MachineDeviceAgentError(401, "this machine was revoked");
          }
          throw new MachineDeviceAgentError(
            0,
            `the socket closed (${event.code})`,
          );
        }
        if (event.data === "pong") continue;
        const frame = decodeMachineSocketFrameV1(JSON.parse(event.data));
        cycle.frames += 1;
        if (frame.type === "modules") {
          this.options.onModules?.(frame.modules);
          continue;
        }
        if (frame.type === "call") {
          this.options.onCall?.(frame);
          continue;
        }
        cycle.delivered += frame.commands.length;
        for (const command of frame.commands) {
          if (signal.aborted) break;
          await this.handle(state, command, signal, cycle);
        }
      }
    } catch (error) {
      cycle.error = message(error);
      this.lastError = cycle.error;
      this.failures += 1;
      if (
        error instanceof MachineDeviceAgentError &&
        (error.status === 401 || error.status === 403)
      ) {
        // Revoked, or signed with a rotated secret. The token is dead for
        // good, so it is cleared rather than retried forever.
        await this.forget();
        this.running = false;
        cycle.unenrolled = true;
        this.lastError = "this machine was revoked; pair it again to reconnect";
      }
    } finally {
      signal.removeEventListener("abort", stopped);
      if (pinger !== undefined) clearInterval(pinger);
      try {
        socket?.close(1000, "done");
      } catch {
        // Already closed.
      }
    }
    this.announce();
    return cycle;
  }

  /** Claim one delivered command, run it if the claim won, and answer it. */
  private async handle(
    state: MachineEnrollmentStateV1,
    command: MachineCommandV1,
    signal: AbortSignal,
    cycle: MachineDeviceAgentCycleV1,
  ): Promise<void> {
    const receipt = decodeMachineClaimReceiptV1(
      await this.call(
        machineRoutePathV1("claim", {
          machineId: state.machineId,
          commandId: command.commandId,
        }),
        { method: "POST", token: state.token, body: JSON.stringify({}) },
      ),
    );
    if (receipt.status !== "claimed") {
      // Somebody else holds the lease. Running it anyway is the one thing
      // "recovery never silently duplicates" forbids.
      cycle.alreadyClaimed += 1;
      return;
    }
    cycle.claimed += 1;
    const report = await this.execute(command, signal);
    decodeMachineResultReceiptV1(
      await this.call(
        machineRoutePathV1("result", {
          machineId: state.machineId,
          commandId: command.commandId,
        }),
        {
          method: "POST",
          token: state.token,
          body: JSON.stringify({
            schemaVersion: 1,
            commandId: command.commandId,
            ...report,
          }),
        },
      ),
    );
    cycle.reported += 1;
  }

  /**
   * The runner, wrapped so a thrown handler is still an answer.
   *
   * A command that was claimed and never answered leaves the backend guessing
   * until the lease lapses. An `error` outcome the Bot can read is strictly
   * better than silence, so nothing the runner does escapes this method.
   */
  private async execute(
    command: MachineCommandV1,
    signal: AbortSignal,
  ): Promise<MachineCommandReportV1> {
    try {
      return await this.options.runner.run(command, signal);
    } catch (error) {
      return {
        finishedAt: new Date(this.now()).toISOString(),
        outcome: "error",
        truncated: false,
        message: message(error),
      };
    }
  }

  /** Start the loop. Idempotent: a second call is not a second loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.pump(controller.signal).finally(() => {
      this.running = false;
      this.controller = undefined;
      this.loop = undefined;
    });
    this.announce();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.running = false;
    const loop = this.loop;
    if (loop) await loop;
    this.announce();
  }

  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycle = await this.connectOnce({ signal });
      if (cycle.unenrolled) return;
      if (signal.aborted) return;
      const delay = cycle.paired
        ? machineReconnectBackoffV1(this.failures, () => this.random())
        : MACHINE_AGENT_IDLE_MS_V1;
      if (delay > 0) await this.sleep(delay, signal);
    }
  }
}
