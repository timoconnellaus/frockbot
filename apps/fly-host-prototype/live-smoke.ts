import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dirname;
const localVariablesPath = resolve(root, ".dev.vars");
const cloudflareVariablesPath = resolve(root, "../cloudflare/.dev.vars");
const workerOrigin = URL.parse("http://127.0.0.1:8790");
if (!workerOrigin) {
  throw new Error("Invalid local Worker origin");
}

interface SavedFile {
  source: string;
  mode: number;
}

async function readOptionalFile(path: string): Promise<SavedFile | undefined> {
  try {
    const [source, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    return { source, mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function spritesTokenAssignment(source: string): string | undefined {
  const match = source.match(/^\s*SPRITES_TOKEN\s*=\s*(.+?)\s*$/m);
  return match?.[1] ? `SPRITES_TOKEN=${match[1]}\n` : undefined;
}

async function waitForWorker(url: URL): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("Timed out waiting for the Container host Worker");
}

const originalLocalVariables = await readOptionalFile(localVariablesPath);
const cloudflareVariables = await readOptionalFile(cloudflareVariablesPath);
const assignment =
  spritesTokenAssignment(originalLocalVariables?.source ?? "") ??
  spritesTokenAssignment(cloudflareVariables?.source ?? "");
if (!assignment) {
  throw new Error(
    "Add SPRITES_TOKEN to apps/cloudflare/.dev.vars before running the live prototype",
  );
}

let temporaryVariablesWritten = false;
let worker: ReturnType<typeof Bun.spawn> | undefined;
try {
  await writeFile(localVariablesPath, assignment, { mode: 0o600 });
  temporaryVariablesWritten = true;
  await chmod(localVariablesPath, 0o600);

  worker = Bun.spawn(
    ["bunx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", "8790"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  await waitForWorker(workerOrigin);
  const effectId = `effect-${crypto.randomUUID()}`;
  const probe = `container-${crypto.randomUUID()}`;
  const response = await fetch(new URL("/v1/computer/smoke", workerOrigin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      effectId,
      botId: "prototype-bot",
      credentialRef: "sprites:prototype",
      probe,
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const body = (await response.json()) as {
    version?: unknown;
    effectId?: unknown;
    capabilities?: {
      streaming?: unknown;
      files?: unknown;
      cancellation?: unknown;
      reconstruction?: unknown;
      cleanup?: unknown;
    };
    evidence?: {
      stream?: unknown;
      file?: unknown;
    };
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      `Container host smoke failed (${response.status}): ${String(body.error)}`,
    );
  }
  const capabilities = body.capabilities;
  const evidence = body.evidence;
  if (
    body.version !== 1 ||
    body.effectId !== effectId ||
    capabilities?.streaming !== true ||
    capabilities.files !== true ||
    capabilities.cancellation !== true ||
    capabilities.reconstruction !== true ||
    capabilities.cleanup !== true ||
    evidence?.stream !== probe ||
    evidence.file !== probe
  ) {
    throw new Error("Container host returned invalid capability evidence");
  }
  process.stdout.write("Shared Container Fly compatibility smoke passed\n");
} finally {
  if (worker) {
    worker.kill("SIGTERM");
    await worker.exited;
  }
  if (temporaryVariablesWritten) {
    if (originalLocalVariables) {
      await writeFile(localVariablesPath, originalLocalVariables.source, {
        mode: originalLocalVariables.mode,
      });
      await chmod(localVariablesPath, originalLocalVariables.mode);
    } else {
      await rm(localVariablesPath, { force: true });
    }
  }
}
