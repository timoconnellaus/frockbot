/**
 * The one seam between the installer and the outside world.
 *
 * Every wrangler call, every HTTP request and every file the installer writes
 * goes through here, so `--dry-run` is one implementation rather than a flag
 * threaded through every step — and so the tests drive the whole installer
 * without a Cloudflare account, a network or a temporary directory.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SetupCommandV1 {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  /** Written to the command's stdin; never echoed, because it may be a secret. */
  readonly stdin?: string;
  /** What the operator sees instead of `stdin`, when there is a secret in it. */
  readonly redactedStdin?: string;
}

export interface CommandResultV1 {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HttpRequestV1 {
  readonly method: string;
  readonly url: string;
  readonly token: string;
  readonly body?: unknown;
}

export interface HttpResultV1 {
  readonly status: number;
  readonly body: unknown;
}

/** What a step is allowed to do, and what a dry run does instead. */
export interface SetupRunnerV1 {
  readonly dryRun: boolean;
  /**
   * Run a command. In a dry run it is printed and `whenDry` is answered instead;
   * the default answer is a non-zero exit, which every probe here reads as
   * "absent" — so a dry run prints the whole of a first install.
   */
  run(
    command: SetupCommandV1,
    whenDry?: CommandResultV1,
  ): Promise<CommandResultV1>;
  /** Call the Cloudflare API. In a dry run it is printed and `whenDry` answered. */
  request(
    request: HttpRequestV1,
    whenDry?: HttpResultV1,
  ): Promise<HttpResultV1>;
  /** Read a file, or nothing when it is not there. */
  readFile(path: string): string | undefined;
  /** Write a file. In a dry run the path and the value are printed instead. */
  writeFile(path: string, contents: string, mode?: number): void;
  /** Delete a file if it is there. A dry run says so and deletes nothing. */
  removeFile(path: string): void;
  /**
   * A file's sha256, as lowercase hex. In process rather than through `shasum`
   * or `sha256sum`, because which of the two exists is a question about the
   * deployer's machine that this has no reason to ask.
   */
  sha256(path: string): Promise<string>;
  /** What the operator is told, one line at a time. */
  say(line: string): void;
}

const ABSENT: CommandResultV1 = {
  exitCode: 1,
  stdout: "",
  stderr: "not run: this is a dry run",
};

const ABSENT_HTTP: HttpResultV1 = { status: 404, body: null };

/** Printable form of a command, with any secret on its stdin left out. */
export function commandLineV1(command: SetupCommandV1): string {
  const parts = command.cmd.map((part) =>
    /[\s"'$]/.test(part) ? JSON.stringify(part) : part,
  );
  const redirect =
    command.redactedStdin ?? (command.stdin === undefined ? undefined : "-");
  return [
    ...(command.cwd ? [`(in ${command.cwd})`] : []),
    ...parts,
    ...(redirect ? [`< ${redirect}`] : []),
  ].join(" ");
}

export function createDryRunRunnerV1(
  say: (line: string) => void = console.log,
): SetupRunnerV1 & { readonly recorded: string[] } {
  const recorded: string[] = [];
  return {
    dryRun: true,
    recorded,
    run: (command, whenDry) => {
      recorded.push(commandLineV1(command));
      say(`  would run  ${commandLineV1(command)}`);
      return Promise.resolve(whenDry ?? ABSENT);
    },
    request: (request, whenDry) => {
      const line = `${request.method} ${request.url}`;
      recorded.push(line);
      say(`  would call  ${line}`);
      return Promise.resolve(whenDry ?? ABSENT_HTTP);
    },
    // A dry run still reads: what is already on disk is what decides whether a
    // step has anything to do, and reading changes nothing.
    readFile: (path) => readFileIfPresentV1(path),
    writeFile: (path, contents) => {
      recorded.push(`write ${path}`);
      say(`  would write  ${path}`);
      for (const line of contents.trimEnd().split("\n"))
        say(`             ${line}`);
    },
    removeFile: (path) => {
      recorded.push(`remove ${path}`);
      say(`  would remove  ${path}`);
    },
    // Nothing was downloaded, so there is nothing to hash: the placeholder is
    // what the printed R2 key and `DEFAULT_APPLICATION_HASH` carry.
    sha256: (path) => {
      recorded.push(`sha256 ${path}`);
      say(`  would hash  ${path}`);
      return Promise.resolve(DRY_RUN_SHA256_V1);
    },
    say,
  };
}

/** The digest a dry run reports, so its printed R2 key has the right shape. */
export const DRY_RUN_SHA256_V1 = "0".repeat(64);

export function createLiveRunnerV1(
  say: (line: string) => void = console.log,
): SetupRunnerV1 {
  return {
    dryRun: false,
    run: async (command) => {
      const spawned = Bun.spawn({
        cmd: [...command.cmd],
        ...(command.cwd ? { cwd: command.cwd } : {}),
        stdin:
          command.stdin === undefined ? "ignore" : new Response(command.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
        spawned.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    request: async (request) => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${request.token}`,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // An empty or non-JSON answer is a status and nothing else.
      }
      return { status: response.status, body };
    },
    readFile: (path) => readFileIfPresentV1(path),
    writeFile: (path, contents, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, mode === undefined ? {} : { mode });
    },
    removeFile: (path) => {
      rmSync(path, { force: true });
    },
    sha256: async (path) =>
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path).arrayBuffer())
        .digest("hex"),
    say,
  };
}

function readFileIfPresentV1(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
