/**
 * A fake `SpritesClient` for the container's tests.
 *
 * It models the two things the host actually depends on and nothing else: a
 * command whose output arrives in whatever chunks the test chooses, and a
 * filesystem that holds bytes. In particular it lets a test split one logical
 * write across several `data` events, because the transport under the real
 * thing gives no guarantee about chunk boundaries — the lesson ADR 0004
 * records.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  SpriteCommandHandle,
  SpriteDirentHandle,
  SpriteFilesystemHandle,
  SpriteHandle,
  SpriteServiceStreamHandle,
  SpriteStatsHandle,
  SpritesClientHandle,
} from "./computer.ts";

export class FakeApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "FakeApiError";
    this.statusCode = statusCode;
  }
}

export interface ScriptedCommand {
  /** Chunks written to stdout, in order, exactly as delivered. */
  stdout?: (string | Buffer)[];
  stderr?: (string | Buffer)[];
  exitCode?: number;
  /** Never settles until killed. Used for cancellation and timeout tests. */
  hang?: boolean;
  /** The exit code a killed command reports. */
  killedExitCode?: number;
  /** Fail the spawn itself. */
  error?: string;
}

export interface RecordedCommand {
  command: string;
  args: string[];
  stdin: string;
  signals: string[];
}

class FakeCommand extends EventEmitter implements SpriteCommandHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exitResolve!: (code: number) => void;
  private readonly exited = new Promise<number>((resolve) => {
    this.exitResolve = resolve;
  });
  private settled = false;

  constructor(
    private readonly script: ScriptedCommand,
    private readonly record: RecordedCommand,
  ) {
    super();
    const chunks: Buffer[] = [];
    this.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    this.stdin.on("finish", () => {
      this.record.stdin = Buffer.concat(chunks).toString("utf8");
      queueMicrotask(() => this.run());
    });
    queueMicrotask(() => {
      if (script.error) this.emit("error", new Error(script.error));
      else this.emit("spawn");
    });
  }

  private run(): void {
    if (this.script.error) return;
    for (const chunk of this.script.stdout ?? []) this.stdout.write(chunk);
    for (const chunk of this.script.stderr ?? []) this.stderr.write(chunk);
    if (this.script.hang) return;
    this.finish(this.script.exitCode ?? 0);
  }

  private finish(code: number): void {
    if (this.settled) return;
    this.settled = true;
    this.stdout.end();
    this.stderr.end();
    this.exitResolve(code);
    this.emit("exit", code);
  }

  wait(): Promise<number> {
    return this.exited;
  }

  kill(signal = "SIGTERM"): void {
    this.record.signals.push(signal);
    this.finish(this.script.killedExitCode ?? 143);
  }
}

interface FakeFile {
  bytes: Buffer;
  mode: number;
  mtime: Date;
}

export class FakeSprite implements SpriteHandle {
  readonly files = new Map<string, FakeFile>();
  readonly directories = new Set<string>(["/"]);
  readonly services = new Map<string, "running" | "failed">();
  readonly commands: RecordedCommand[] = [];
  url?: string = "https://fake-sprite.invalid";
  urlSettings?: { auth: string };
  /** Queue of scripted commands; the last one repeats once exhausted. */
  scripts: ScriptedCommand[] = [{ exitCode: 0 }];

  constructor(readonly name: string) {}

  spawn(command: string, args: string[] = []): SpriteCommandHandle {
    const script =
      this.scripts.length > 1 ? this.scripts.shift()! : (this.scripts[0] ?? {});
    const record: RecordedCommand = {
      command,
      args,
      stdin: "",
      signals: [],
    };
    this.commands.push(record);
    return new FakeCommand(script, record);
  }

  filesystem(): SpriteFilesystemHandle {
    const sprite = this;
    return {
      async readFile(path: string): Promise<Buffer> {
        const file = sprite.files.get(path);
        if (!file) throw new FakeApiError(404, `no such file: ${path}`);
        return file.bytes;
      },
      async writeFile(path, data, options) {
        sprite.files.set(path, {
          bytes: Buffer.isBuffer(data) ? data : Buffer.from(data),
          mode: options?.mode ?? 0o644,
          mtime: new Date("2026-08-31T00:00:00.000Z"),
        });
      },
      async readdir(path): Promise<SpriteDirentHandle[]> {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const entries: SpriteDirentHandle[] = [];
        for (const key of sprite.files.keys()) {
          if (!key.startsWith(prefix)) continue;
          entries.push({
            name: key.slice(prefix.length),
            parentPath: path,
            isDirectory: () => false,
            isFile: () => true,
          });
        }
        return entries;
      },
      async mkdir(path) {
        sprite.directories.add(path);
      },
      async rm(path) {
        if (!sprite.files.delete(path)) {
          throw new FakeApiError(404, `no such file: ${path}`);
        }
      },
      async stat(path): Promise<SpriteStatsHandle> {
        const file = sprite.files.get(path);
        if (file) {
          return {
            size: file.bytes.byteLength,
            mode: file.mode,
            mtime: file.mtime,
            isDirectory: () => false,
            isFile: () => true,
          };
        }
        if (sprite.directories.has(path)) {
          return {
            size: 0,
            mode: 0o755,
            mtime: new Date("2026-08-31T00:00:00.000Z"),
            isDirectory: () => true,
            isFile: () => false,
          };
        }
        throw new FakeApiError(404, `no such path: ${path}`);
      },
    };
  }

  async createService(name: string): Promise<SpriteServiceStreamHandle> {
    this.services.set(name, "running");
    return serviceStream([{ type: "exit", exitCode: 0 }]);
  }

  async startService(name: string): Promise<SpriteServiceStreamHandle> {
    if (!this.services.has(name)) {
      throw new FakeApiError(404, `no such service: ${name}`);
    }
    return serviceStream([{ type: "exit", exitCode: 0 }]);
  }

  async updateURLSettings(settings: { auth: string }): Promise<void> {
    this.urlSettings = settings;
  }
}

function serviceStream(events: unknown[]): SpriteServiceStreamHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

export class FakeSpritesClient implements SpritesClientHandle {
  readonly sprites = new Map<string, FakeSprite>();
  readonly created: string[] = [];
  readonly deleted: string[] = [];

  constructor(existing: string[] = []) {
    for (const name of existing) this.sprites.set(name, new FakeSprite(name));
  }

  async getSprite(name: string): Promise<SpriteHandle> {
    const sprite = this.sprites.get(name);
    if (!sprite) throw new FakeApiError(404, `no such sprite: ${name}`);
    return sprite;
  }

  async createSprite(name: string): Promise<SpriteHandle> {
    this.created.push(name);
    const sprite = new FakeSprite(name);
    this.sprites.set(name, sprite);
    return sprite;
  }

  async deleteSprite(name: string): Promise<void> {
    this.deleted.push(name);
    this.sprites.delete(name);
  }

  async listAllSprites(prefix?: string): Promise<{ name: string }[]> {
    return [...this.sprites.values()]
      .filter((sprite) => !prefix || sprite.name.startsWith(prefix))
      .map((sprite) => ({ name: sprite.name }));
  }

  /** The one Sprite a test provisioned, for assertions about its contents. */
  only(): FakeSprite {
    const [sprite] = [...this.sprites.values()];
    if (!sprite) throw new Error("no Sprite was created");
    return sprite;
  }
}
