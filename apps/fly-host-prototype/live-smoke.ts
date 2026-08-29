import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dirname;
const localVariablesPath = resolve(root, ".dev.vars");
const cloudflareVariablesPath = resolve(root, "../cloudflare/.dev.vars");

async function hasSpritesToken(path: string): Promise<boolean> {
  try {
    const source = await readFile(path, "utf8");
    return /^\s*SPRITES_TOKEN\s*=\s*.+$/m.test(source);
  } catch {
    return false;
  }
}

async function waitForWorker(url: string): Promise<void> {
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

const hadLocalVariables = await hasSpritesToken(localVariablesPath);
if (!hadLocalVariables) {
  if (!(await hasSpritesToken(cloudflareVariablesPath))) {
    throw new Error(
      "Add SPRITES_TOKEN to apps/cloudflare/.dev.vars before running the live prototype",
    );
  }
  await writeFile(
    localVariablesPath,
    await readFile(cloudflareVariablesPath, "utf8"),
    { mode: 0o600 },
  );
  await chmod(localVariablesPath, 0o600);
}

const worker = Bun.spawn(
  ["bunx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", "8790"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);

try {
  await waitForWorker("http://127.0.0.1:8790/");
  const effectId = `effect-${crypto.randomUUID()}`;
  const probe = `container-${crypto.randomUUID()}`;
  const response = await fetch("http://127.0.0.1:8790/v1/computer/smoke", {
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
    evidence?.stream !== probe ||
    evidence.file !== probe
  ) {
    throw new Error("Container host returned invalid capability evidence");
  }
  process.stdout.write("Shared Container Fly compatibility smoke passed\n");
} finally {
  worker.kill("SIGTERM");
  await worker.exited;
  if (!hadLocalVariables) {
    await rm(localVariablesPath, { force: true });
  }
}
