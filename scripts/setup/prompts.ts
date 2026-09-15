/**
 * How the installer asks, and how `--yes` answers for it.
 *
 * `--yes` is the only thing that answers for a person: it takes each default and
 * says what it took. A dry run still asks, because a dry run whose answers were
 * not the deployer's own would print a plan for somebody else's deployment. A
 * question with no default under `--yes` is a failure naming the flag, never a
 * silent empty string.
 */
export interface AskerV1 {
  /** A visible answer. */
  ask(prompt: string, options?: { default?: string }): Promise<string>;
  /** A hidden answer; the same contract otherwise. */
  askSecret(prompt: string, options?: { default?: string }): Promise<string>;
  confirm(prompt: string, fallback: boolean): Promise<boolean>;
}

export class MissingAnswerV1 extends Error {}

/**
 * The asker a person drives.
 *
 * One line iterator over stdin for the whole run: `Bun.stdin.text()` consumes
 * the stream, so a second question asked that way would read nothing.
 */
export function createTerminalAskerV1(
  say: (line: string) => void = console.log,
): AskerV1 {
  const lines: AsyncIterator<string> = (
    console as unknown as AsyncIterable<string>
  )[Symbol.asyncIterator]();
  const nextLine = async (): Promise<string> => {
    const next = await lines.next();
    return next.done ? "" : next.value.trim();
  };
  const read = async (
    prompt: string,
    fallback: string | undefined,
    hidden: boolean,
  ) => {
    const suffix = fallback === undefined ? "" : ` [${fallback}]`;
    process.stdout.write(`  ${prompt}${suffix} `);
    const answer = hidden ? await withEchoOffV1(nextLine) : await nextLine();
    if (answer) return answer;
    if (fallback !== undefined) return fallback;
    say("");
    throw new MissingAnswerV1(`${prompt} needs an answer.`);
  };
  return {
    ask: (prompt, options) => read(prompt, options?.default, false),
    askSecret: (prompt, options) => read(prompt, options?.default, true),
    confirm: async (prompt, fallback) => {
      process.stdout.write(`  ${prompt} [${fallback ? "Y/n" : "y/N"}] `);
      const answer = await nextLine();
      return answer ? /^y/i.test(answer) : fallback;
    },
  };
}

/**
 * The asker `--yes` uses: every default, taken, and printed so the run is still
 * readable afterwards.
 */
export function createDefaultingAskerV1(
  say: (line: string) => void,
  flag: string,
): AskerV1 {
  const take = (prompt: string, fallback: string | undefined) => {
    if (fallback === undefined) {
      throw new MissingAnswerV1(
        `${prompt} has no default, so ${flag} cannot answer it. Supply it on the command line or drop ${flag}.`,
      );
    }
    say(`  ${prompt} ${fallback} (${flag})`);
    return Promise.resolve(fallback);
  };
  return {
    ask: (prompt, options) => take(prompt, options?.default),
    askSecret: (prompt, options) => take(prompt, options?.default),
    confirm: (prompt, fallback) => {
      say(`  ${prompt} ${fallback ? "yes" : "no"} (${flag})`);
      return Promise.resolve(fallback);
    },
  };
}

/**
 * Read one answer with the terminal's echo off.
 *
 * Bun offers no raw mode on stdin, so the tty itself is switched with `stty`,
 * which is what the shell wizard beside this installer does. A stdin that is not
 * a tty — a pipe in CI — has no echo to turn off and needs none.
 */
async function withEchoOffV1(read: () => Promise<string>): Promise<string> {
  const off = Bun.spawnSync({ cmd: ["stty", "-echo"], stdin: "inherit" });
  try {
    return await read();
  } finally {
    if (off.exitCode === 0) {
      Bun.spawnSync({ cmd: ["stty", "echo"], stdin: "inherit" });
      process.stdout.write("\n");
    }
  }
}
