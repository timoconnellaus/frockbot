import {
  ComputerError,
  type ComputerAssignment,
  type ComputerBrowserAction,
  type ComputerBrowserState,
  type ComputerDirectory,
  type ComputerFileInfo,
  type ComputerHandle,
  type ComputerOperationOptions,
  type ComputerProvider,
  type ComputerTarget,
  type ComputerWorkspace,
  normalizeComputerPath,
} from "@frockbot/computer-core";
import type { Plugin } from "cordis";
import {
  type BrowserAction,
  FlySpriteComputer,
  type FlySpriteAgentComputer,
  flySpriteNameForBot,
} from "./computer.js";

const encoder = new TextEncoder();
const MAX_FILE_BYTES = 50_000;

function browserAction(action: ComputerBrowserAction): BrowserAction {
  switch (action.type) {
    case "snapshot":
      return { action: "snapshot" };
    case "navigate":
      return { action: "navigate", url: action.url };
    case "click":
      return {
        action: "click",
        role: action.role,
        name: action.name,
        exact: action.exact,
      };
    case "fill":
      return {
        action: "fill",
        label: action.label,
        text: action.text,
        exact: action.exact,
      };
    case "press":
      return { action: "press", key: action.key };
    case "wait":
      return { action: "wait", milliseconds: action.milliseconds };
  }
}

function browserState(output: string): ComputerBrowserState {
  try {
    const parsed: unknown = JSON.parse(output);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "snapshot" in parsed &&
      typeof parsed.snapshot === "string"
    ) {
      const value = parsed as {
        url?: unknown;
        title?: unknown;
        snapshot: string;
      };
      return {
        url: typeof value.url === "string" ? value.url : undefined,
        title: typeof value.title === "string" ? value.title : undefined,
        accessibilitySnapshot: value.snapshot,
      };
    }
  } catch {
    // Preserve provider output as a diagnostic snapshot.
  }
  return { accessibilitySnapshot: output };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandFor(
  executable: string,
  args: readonly string[] | undefined,
): string {
  if (
    (executable === "/bin/bash" || executable === "bash") &&
    args?.[0] === "-lc" &&
    typeof args[1] === "string"
  ) {
    return args[1];
  }
  return [executable, ...(args ?? [])].map(shellQuote).join(" ");
}

class FlyComputerDirectory implements ComputerDirectory {
  constructor(
    private readonly computer: FlySpriteAgentComputer,
    private readonly root: string,
  ) {}

  private target(path: string): string {
    return `${this.root}/${normalizeComputerPath(path)}`;
  }

  private async runStorage(
    command: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const output = await this.computer.runStorage(
      command,
      signal ?? new AbortController().signal,
    );
    return output.trim();
  }

  async readFile(path: string, options: ComputerOperationOptions = {}) {
    const normalized = normalizeComputerPath(path);
    const target = this.target(normalized);
    const output = await this.runStorage(
      [
        `TARGET=${shellQuote(target)}`,
        'if [ ! -f "$TARGET" ]; then echo __MISSING__; exit 0; fi',
        'SIZE=$(stat -c %s "$TARGET")',
        `if [ "$SIZE" -gt ${MAX_FILE_BYTES} ]; then echo __TOO_LARGE__; exit 0; fi`,
        'sha256sum "$TARGET" | cut -d" " -f1',
        'stat -c %s "$TARGET"',
        'stat -c %Y "$TARGET"',
        'base64 -w0 "$TARGET"',
      ].join("\n"),
      options.signal,
    );
    if (output === "__MISSING__") return null;
    if (output === "__TOO_LARGE__") {
      throw new ComputerError(
        "limit-exceeded",
        `Computer file exceeds ${MAX_FILE_BYTES} bytes`,
      );
    }
    const [version, sizeText, modifiedText, encoded = ""] = output.split("\n");
    if (!version || !sizeText || !modifiedText) {
      throw new ComputerError("provider-failure", "Invalid Fly file response");
    }
    return {
      path: normalized,
      version,
      size: Number(sizeText),
      modifiedAt: new Date(Number(modifiedText) * 1000).toISOString(),
      bytes: Uint8Array.from(Buffer.from(encoded, "base64")),
    };
  }

  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: ComputerOperationOptions & {
      ifVersion?: string | null;
      mediaType?: string;
    } = {},
  ) {
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new ComputerError(
        "limit-exceeded",
        `Computer file exceeds ${MAX_FILE_BYTES} bytes`,
      );
    }
    const normalized = normalizeComputerPath(path);
    const target = this.target(normalized);
    const expected = options.ifVersion;
    const guard =
      expected === null
        ? 'if [ -e "$TARGET" ]; then echo __CONFLICT__; exit 0; fi'
        : typeof expected === "string"
          ? `if [ ! -f "$TARGET" ] || [ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != ${shellQuote(expected)} ]; then echo __CONFLICT__; exit 0; fi`
          : "";
    const output = await this.runStorage(
      [
        "set -eu",
        `ROOT=${shellQuote(this.root)}`,
        `TARGET=${shellQuote(target)}`,
        'mkdir -p "$(dirname "$TARGET")" "$ROOT/.frockbot-locks"',
        'LOCK=$(printf %s "$TARGET" | sha256sum | cut -d" " -f1)',
        'exec 9>"$ROOT/.frockbot-locks/$LOCK"',
        "flock -x 9",
        guard,
        'TMP=$(mktemp "${TARGET}.XXXXXX")',
        `printf %s ${shellQuote(Buffer.from(bytes).toString("base64"))} | base64 -d > "$TMP"`,
        'chmod 600 "$TMP"',
        'mv "$TMP" "$TARGET"',
        'sha256sum "$TARGET" | cut -d" " -f1',
        'stat -c %s "$TARGET"',
        'stat -c %Y "$TARGET"',
      ]
        .filter(Boolean)
        .join("\n"),
      options.signal,
    );
    if (output === "__CONFLICT__") {
      throw new ComputerError(
        "conflict",
        `Computer file changed: ${normalized}`,
      );
    }
    const [version, sizeText, modifiedText] = output.split("\n");
    if (!version || !sizeText || !modifiedText) {
      throw new ComputerError("provider-failure", "Invalid Fly write response");
    }
    return {
      path: normalized,
      version,
      size: Number(sizeText),
      modifiedAt: new Date(Number(modifiedText) * 1000).toISOString(),
      mediaType: options.mediaType,
    };
  }

  async deleteFile(
    path: string,
    options: ComputerOperationOptions & { ifVersion?: string } = {},
  ): Promise<boolean> {
    const normalized = normalizeComputerPath(path);
    const target = this.target(normalized);
    const expected = options.ifVersion;
    const output = await this.runStorage(
      [
        "set -eu",
        `ROOT=${shellQuote(this.root)}`,
        `TARGET=${shellQuote(target)}`,
        'mkdir -p "$ROOT/.frockbot-locks"',
        'LOCK=$(printf %s "$TARGET" | sha256sum | cut -d" " -f1)',
        'exec 9>"$ROOT/.frockbot-locks/$LOCK"',
        "flock -x 9",
        'if [ ! -e "$TARGET" ]; then echo __MISSING__; exit 0; fi',
        typeof expected === "string"
          ? `if [ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != ${shellQuote(expected)} ]; then echo __CONFLICT__; exit 0; fi`
          : "",
        'rm -f "$TARGET"',
        "echo __DELETED__",
      ]
        .filter(Boolean)
        .join("\n"),
      options.signal,
    );
    if (output === "__CONFLICT__") {
      throw new ComputerError(
        "conflict",
        `Computer file changed: ${normalized}`,
      );
    }
    return output === "__DELETED__";
  }

  async listFiles(
    options: ComputerOperationOptions & {
      prefix?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    const prefix = options.prefix ? normalizeComputerPath(options.prefix) : "";
    const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ComputerError(
        "invalid-request",
        "Invalid Computer file cursor",
      );
    }
    const output = await this.runStorage(
      [
        `ROOT=${shellQuote(this.root)}`,
        `PREFIX=${shellQuote(prefix)}`,
        `OFFSET=${offset}`,
        `LIMIT=${limit}`,
        'mkdir -p "$ROOT"',
        "INDEX=0",
        "EMITTED=0",
        'find "$ROOT" -type f ! -path "$ROOT/.frockbot-locks/*" -print0 | sort -z | while IFS= read -r -d "" FILE; do',
        '  REL=${FILE#"$ROOT"/}',
        '  if [ -n "$PREFIX" ]; then case "$REL" in "$PREFIX"|"$PREFIX"/*) ;; *) continue ;; esac; fi',
        '  if [ "$INDEX" -lt "$OFFSET" ]; then INDEX=$((INDEX + 1)); continue; fi',
        '  HASH=$(sha256sum "$FILE" | cut -d" " -f1)',
        '  printf "%s\\t%s\\t%s\\t%s\\n" "$(printf %s "$REL" | base64 -w0)" "$HASH" "$(stat -c %s "$FILE")" "$(stat -c %Y "$FILE")"',
        "  EMITTED=$((EMITTED + 1))",
        '  if [ "$EMITTED" -gt "$LIMIT" ]; then break; fi',
        "done",
      ].join("\n"),
      options.signal,
    );
    const files: ComputerFileInfo[] = output
      ? output.split("\n").map((line) => {
          const [encodedPath, version, sizeText, modifiedText] =
            line.split("\t");
          const path = encodedPath
            ? Buffer.from(encodedPath, "base64").toString("utf8")
            : "";
          const size = Number(sizeText);
          const modifiedSeconds = Number(modifiedText);
          if (
            !path ||
            !version ||
            !Number.isFinite(size) ||
            !Number.isFinite(modifiedSeconds)
          ) {
            throw new ComputerError(
              "provider-failure",
              "Invalid Fly file listing response",
            );
          }
          return {
            path,
            version,
            size,
            modifiedAt: new Date(modifiedSeconds * 1000).toISOString(),
          };
        })
      : [];
    const hasMore = files.length > limit;
    return {
      files: files.slice(0, limit),
      cursor: hasMore ? String(offset + limit) : undefined,
    };
  }
}

class FlyComputerWorkspace implements ComputerWorkspace {
  constructor(
    private readonly botComputer: FlySpriteAgentComputer,
    private readonly userComputer: FlySpriteAgentComputer,
  ) {}

  openDirectory(request: {
    namespace: string;
    scope: "bot" | "user";
    durability: "durable";
  }): Promise<ComputerDirectory> {
    const namespace = normalizeComputerPath(request.namespace);
    const computer =
      request.scope === "bot" ? this.botComputer : this.userComputer;
    const base =
      request.scope === "bot"
        ? `/home/box/agent-data/agents/${computer.botKey}/packages`
        : "/home/box/agent-data/user-packages";
    return Promise.resolve(
      new FlyComputerDirectory(computer, `${base}/${namespace}`),
    );
  }
}

function handle(
  botComputer: FlySpriteAgentComputer,
  userComputer: FlySpriteAgentComputer,
  assignment: ComputerAssignment,
): ComputerHandle {
  return {
    assignment,
    workspace: new FlyComputerWorkspace(botComputer, userComputer),
    exec: {
      execute: async (request, options) => {
        if (
          request.cwd !== undefined ||
          request.env !== undefined ||
          request.stdin !== undefined
        ) {
          throw new ComputerError(
            "invalid-request",
            "The Fly Computer provider does not support cwd, env, or stdin",
          );
        }
        const result = await botComputer.exec(
          commandFor(request.executable, request.args),
          options?.signal ?? new AbortController().signal,
          {
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes,
          },
        );
        return {
          exitCode: result.exitCode,
          stdout: encoder.encode(result.stdout),
          stderr: encoder.encode(result.stderr),
          outputTruncated: result.outputTruncated,
        };
      },
    },
    browser: {
      perform: async (action, options) =>
        browserState(
          await botComputer.browser(
            browserAction(action),
            options?.signal ?? new AbortController().signal,
          ),
        ),
    },
    close: () => Promise.resolve(),
  };
}

interface FlyComputerPair {
  bot: FlySpriteComputer;
  user: FlySpriteComputer;
}

export function flySpriteNameForTarget(target: ComputerTarget): string {
  return flySpriteNameForBot(
    JSON.stringify(["bot", target.userId, target.botId]),
  );
}

export function flySpriteNameForUserStorage(userId: string): string {
  return flySpriteNameForBot(JSON.stringify(["user", userId]));
}

/** Provider adapter that keeps Fly-specific lifecycle behind Computer core. */
export class FlySpriteComputerProvider implements ComputerProvider {
  readonly id = "fly-sprite";
  private readonly computers = new Map<string, FlyComputerPair>();
  private readonly userComputers = new Map<string, FlySpriteComputer>();

  constructor(
    private readonly fixedComputer?: FlySpriteComputer,
    private readonly token?: string,
  ) {}

  private pair(target: ComputerTarget): FlyComputerPair {
    const key = `${target.userId}\0${target.botId}`;
    let pair = this.computers.get(key);
    if (!pair) {
      if (this.fixedComputer) {
        pair = { bot: this.fixedComputer, user: this.fixedComputer };
      } else {
        let user = this.userComputers.get(target.userId);
        if (!user) {
          user = new FlySpriteComputer({
            token: this.token,
            respectHumanControl: false,
            spriteName: flySpriteNameForUserStorage(target.userId),
          });
          this.userComputers.set(target.userId, user);
        }
        pair = {
          bot: new FlySpriteComputer({
            token: this.token,
            respectHumanControl: true,
            spriteName: flySpriteNameForTarget(target),
          }),
          user,
        };
      }
      this.computers.set(key, pair);
    }
    return pair;
  }

  open(
    target: ComputerTarget,
    assignment: ComputerAssignment,
  ): Promise<ComputerHandle> {
    const pair = this.pair(target);
    return Promise.resolve(
      handle(
        pair.bot.bot(target.botId),
        pair.user.bot(JSON.stringify(["user", target.userId])),
        assignment,
      ),
    );
  }
}

export function createFlySpriteProviderPlugin(
  computer?: FlySpriteComputer,
  options?: { token?: string },
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.computers.register(
      new FlySpriteComputerProvider(computer, options?.token),
    );
  plugin.inject = ["computers"];
  return plugin;
}

export const flySpriteProviderPlugin = createFlySpriteProviderPlugin();
export default flySpriteProviderPlugin;
