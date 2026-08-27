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

// Cordis context services exposed to desktop contribution plugins.
declare module "cordis" {
  interface Context {
    desktopCommands: DesktopCommandRegistry;
    desktopNotifications: DesktopNotificationCapability;
    desktopDirectoryPicker: DesktopDirectoryPickerCapability;
  }
}
