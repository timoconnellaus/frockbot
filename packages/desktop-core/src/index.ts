import { type Context, Service } from "cordis";

export interface DesktopCommandContext {
  signal: AbortSignal;
}

export type DesktopCommandPayload = object | string | number | boolean | null;
export type DesktopCommandResult = DesktopCommandPayload | void;

export interface DesktopCommand<
  Input extends DesktopCommandPayload,
  Output extends DesktopCommandResult,
> {
  id: string;
  decode(input: unknown): Input;
  execute(input: Input, context: DesktopCommandContext): Promise<Output>;
}

interface RegisteredDesktopCommand {
  source: object;
  decode(input: unknown): DesktopCommandPayload;
  execute(
    input: DesktopCommandPayload,
    context: DesktopCommandContext,
  ): Promise<DesktopCommandResult>;
}

export interface DesktopCommandSummary {
  id: string;
}

export class DesktopCommandRegistry extends Service {
  private commands = new Map<string, RegisteredDesktopCommand>();

  constructor(ctx: Context) {
    super(ctx, "desktopCommands");
  }

  register<
    Input extends DesktopCommandPayload,
    Output extends DesktopCommandResult,
  >(command: DesktopCommand<Input, Output>): () => void {
    const id = command.id.trim();
    if (!id) throw new Error("desktop command id must not be empty");
    if (this.commands.has(id)) {
      throw new Error(`desktop command "${id}" is already registered`);
    }
    const registered: RegisteredDesktopCommand = {
      source: command,
      decode: command.decode,
      execute: (input, context) => command.execute(input as Input, context),
    };
    this.commands.set(id, registered);
    return () => {
      if (this.commands.get(id)?.source === command) this.commands.delete(id);
    };
  }

  list(): DesktopCommandSummary[] {
    return [...this.commands.keys()].sort().map((id) => ({ id }));
  }

  async invoke<Output extends DesktopCommandResult = DesktopCommandResult>(
    commandId: string,
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Output> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error(`desktop command "${commandId}" is unavailable`);
    }
    signal.throwIfAborted();
    const decoded = command.decode(input);
    signal.throwIfAborted();
    return (await command.execute(decoded, { signal })) as Output;
  }
}

export type NotificationUrgency = "normal" | "critical";

export interface DesktopNotificationRequest {
  title: string;
  body?: string;
  urgency: NotificationUrgency;
}

export abstract class DesktopNotificationCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopNotifications");
  }

  abstract show(
    request: DesktopNotificationRequest,
    signal: AbortSignal,
  ): Promise<void>;
}

export type DirectoryPickerMode = "file" | "directory";

export interface DesktopDirectoryPickerRequest {
  mode: DirectoryPickerMode;
  title?: string;
  multiple: boolean;
}

export interface DesktopDirectoryPickerResult {
  paths: string[];
  cancelled: boolean;
}

export abstract class DesktopDirectoryPickerCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopDirectoryPicker");
  }

  abstract pick(
    request: DesktopDirectoryPickerRequest,
    signal: AbortSignal,
  ): Promise<DesktopDirectoryPickerResult>;
}

/**
 * What one shell command on the machine asks for, and what came back.
 *
 * These live here rather than in `@frockbot/machine-protocol` because they are
 * the *host's* vocabulary, not the wire's: the protocol says what a Bot asked
 * the machine to do, and this says what the Electron main process was asked to
 * run. Keeping them apart is what lets the agent loop be tested with no host
 * at all, and the host be implemented with no protocol knowledge.
 */
export interface DesktopMachineExecRequest {
  command: string;
  cwd?: string;
  timeoutMs: number;
  /** Each stream is cut at this many bytes; `truncated` says whether it was. */
  maxOutputBytes: number;
}

export interface DesktopMachineExecResult {
  /** Absent when the process was killed rather than exiting. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** The command outlived `timeoutMs` and was killed. */
  timedOut: boolean;
}

export interface DesktopMachineFileRequest {
  path: string;
  maxBytes: number;
}

export interface DesktopMachineFileResult {
  bytesBase64: string;
  truncated: boolean;
}

export interface DesktopMachineIdentity {
  /** The machine's own name for itself. A hostname. */
  label: string;
  platform: "macos" | "windows" | "linux";
}

/**
 * The only authority a registered machine's agent has over the laptop.
 *
 * Deliberately two verbs and one fact. Everything the agent *decides* — which
 * command to claim, what a timeout means, when to back off, when to forget its
 * token — lives in `@frockbot/plugin-user-machine`, where it runs in CI. This
 * seam holds the parts that can only run inside Electron's main process.
 */
export abstract class DesktopMachineHostCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopMachineHost");
  }

  abstract identity(): DesktopMachineIdentity;

  abstract exec(
    request: DesktopMachineExecRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineExecResult>;

  abstract readFile(
    request: DesktopMachineFileRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineFileResult>;
}

/**
 * The OS secure store — the login keychain on macOS, DPAPI on Windows, the
 * platform's secret service on Linux — behind three verbs.
 *
 * A machine token is the one long-lived secret the desktop app holds, and the
 * constitution's "no secrets client-side" has exactly one exemption: a secret
 * the OS itself protects at rest. `read` answering `undefined` is a normal
 * state (nothing stored yet, or a store this platform cannot encrypt to), not
 * an error — the caller pairs again rather than crashing.
 */
export abstract class DesktopSecretStoreCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopSecretStore");
  }

  abstract read(key: string): Promise<string | undefined>;

  abstract write(key: string, value: string): Promise<void>;

  abstract clear(key: string): Promise<void>;
}

/**
 * What macOS has granted the Messages handlers, right now (register row 57g).
 *
 * Both flags are TCC's and the User's: Full Disk Access to read
 * `~/Library/Messages/chat.db`, and Automation over Messages.app to send. The
 * capability can only ever *report* them — nothing in FrockBot can grant
 * either, and a build that pretended otherwise would be lying to a person
 * about their own machine.
 */
export interface DesktopMessagesPermissions {
  fullDiskAccess: boolean;
  automation: boolean;
  /** Whatever macOS said, when it said anything. */
  detail?: string;
}

export interface DesktopMessagesQueryRequest {
  /** A `SELECT`. The statement is composed in a Package, under test. */
  sql: string;
  parameters: Array<string | number>;
  maxRows: number;
}

export interface DesktopMessagesSendRequest {
  recipient: string;
  text: string;
}

/**
 * The only authority the Messages tools have over the Mac.
 *
 * Deliberately four verbs and one fact, and not one of them takes a decision.
 * Which statement to run, what a row means, what a denied permission answers
 * and what may be sent all live in `@frockbot/plugin-machine-messages`, where
 * they run in CI. This seam holds only the parts that cannot run anywhere but
 * a Mac with a real login session: SQLite, `osascript`, and the disk.
 */
export abstract class DesktopMessagesCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopMessages");
  }

  abstract checkPermissions(
    signal: AbortSignal,
  ): Promise<DesktopMessagesPermissions>;

  abstract query(
    request: DesktopMessagesQueryRequest,
    signal: AbortSignal,
  ): Promise<Array<Record<string, string | number | null>>>;

  abstract send(
    request: DesktopMessagesSendRequest,
    signal: AbortSignal,
  ): Promise<void>;

  abstract readFile(
    request: DesktopMachineFileRequest,
    signal: AbortSignal,
  ): Promise<DesktopMachineFileResult>;

  /** The account's home directory, so a `~`-relative attachment resolves. */
  abstract home(): string;
}

export abstract class DesktopClipboardCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "desktopClipboard");
  }

  abstract readText(signal: AbortSignal): Promise<string>;

  abstract writeText(text: string, signal: AbortSignal): Promise<void>;
}

// Cordis context services exposed to desktop contribution plugins.
declare module "cordis" {
  interface Context {
    desktopCommands: DesktopCommandRegistry;
    desktopNotifications: DesktopNotificationCapability;
    desktopDirectoryPicker: DesktopDirectoryPickerCapability;
    desktopClipboard: DesktopClipboardCapability;
    desktopMachineHost: DesktopMachineHostCapability;
    desktopMessages: DesktopMessagesCapability;
    desktopSecretStore: DesktopSecretStoreCapability;
  }
}
