import { type Context, Service } from "cordis";

export interface MobileCommandContext {
  signal: AbortSignal;
}

export type MobileCommandPayload = object | string | number | boolean | null;
export type MobileCommandResult = MobileCommandPayload | void;

export interface MobileCommand<
  Input extends MobileCommandPayload,
  Output extends MobileCommandResult,
> {
  id: string;
  decode(input: unknown): Input;
  execute(input: Input, context: MobileCommandContext): Promise<Output>;
}

interface RegisteredMobileCommand {
  source: object;
  decode(input: unknown): MobileCommandPayload;
  execute(
    input: MobileCommandPayload,
    context: MobileCommandContext,
  ): Promise<MobileCommandResult>;
}

export interface MobileCommandSummary {
  id: string;
}

export class MobileCommandRegistry extends Service {
  private commands = new Map<string, RegisteredMobileCommand>();

  constructor(ctx: Context) {
    super(ctx, "mobileCommands");
  }

  register<
    Input extends MobileCommandPayload,
    Output extends MobileCommandResult,
  >(command: MobileCommand<Input, Output>): () => void {
    const id = command.id.trim();
    if (!id) throw new Error("mobile command id must not be empty");
    if (this.commands.has(id)) {
      throw new Error(`mobile command "${id}" is already registered`);
    }
    const registered: RegisteredMobileCommand = {
      source: command,
      decode: command.decode,
      execute: (input, context) => command.execute(input as Input, context),
    };
    this.commands.set(id, registered);
    return () => {
      if (this.commands.get(id)?.source === command) this.commands.delete(id);
    };
  }

  list(): MobileCommandSummary[] {
    return [...this.commands.keys()].sort().map((id) => ({ id }));
  }

  async invoke<Output extends MobileCommandResult = MobileCommandResult>(
    commandId: string,
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Output> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error(`mobile command "${commandId}" is unavailable`);
    }
    signal.throwIfAborted();
    const decoded = command.decode(input);
    signal.throwIfAborted();
    return (await command.execute(decoded, { signal })) as Output;
  }
}

export type MobileNotificationUrgency = "normal" | "critical";

export interface MobileNotificationRequest {
  title: string;
  body?: string;
  urgency: MobileNotificationUrgency;
}

export abstract class MobileNotificationCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "mobileNotifications");
  }

  abstract show(
    request: MobileNotificationRequest,
    signal: AbortSignal,
  ): Promise<void>;
}

export abstract class MobileClipboardCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "mobileClipboard");
  }

  abstract readText(signal: AbortSignal): Promise<string>;

  abstract writeText(text: string, signal: AbortSignal): Promise<void>;
}

export interface MobileShareRequest {
  title?: string;
  text?: string;
  url?: string;
}

function optionalShareField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

export function decodeMobileShareRequest(input: unknown): MobileShareRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("share request must be an object");
  }
  const record = input as Record<string, unknown>;
  const title = optionalShareField(record, "title");
  const text = optionalShareField(record, "text");
  const url = optionalShareField(record, "url");
  if (!text && !url) {
    throw new Error("share request must include text or url");
  }
  return { title, text, url };
}

export abstract class MobileShareCapability extends Service {
  constructor(ctx: Context) {
    super(ctx, "mobileShare");
  }

  abstract share(
    request: MobileShareRequest,
    signal: AbortSignal,
  ): Promise<void>;
}

// Cordis context services exposed to mobile contribution plugins.
declare module "cordis" {
  interface Context {
    mobileCommands: MobileCommandRegistry;
    mobileNotifications: MobileNotificationCapability;
    mobileClipboard: MobileClipboardCapability;
    mobileShare: MobileShareCapability;
  }
}
