/**
 * The live test's second half: Update, Reset and "Delete my Computer" on a
 * real Sprite, driven by the code that runs them in production.
 *
 * The Bot Durable Object's own commands (`computer/bot.ts`) run against the
 * Fly Computer (`computer/fly`), which calls the container this test started
 * over the same host protocol the app's service binding carries. What the app
 * keeps in Cloudflare is kept in memory instead: the Bot's records, the
 * durable roots' object storage, and the User's sealed sign-ins. Those three
 * are proved by their own suites; what only a real Sprite can prove is that
 * a file and a sign-in come through a machine being replaced and put back.
 *
 * The sign-in is real HTTP. A small site on the Computer answers `/login` with
 * a `Set-Cookie` and writes down which session cookie every later request
 * carried, so "still signed in" is what the site saw, not what the browser's
 * store claims.
 */

import { randomUUID } from "node:crypto";
import {
  createComputerBotBackendContribution,
  type ComputerBotStorage,
  type ComputerBotTransaction,
} from "@frockbot/computer/bot";
import type { ComputerHostSessionV1 } from "@frockbot/computer/core/host";
import { FlyHostTransportV1 } from "@frockbot/computer/fly/host-client";
import { FlyComputerHostV1 } from "@frockbot/computer/fly/provider";
import type { ComputerCommandV1 } from "@frockbot/computer/protocol";
import type {
  ComputerLoginsKeepOutcomeV1,
  ComputerLoginsKeptV1,
  ComputerLoginVaultV1,
} from "@frockbot/computer/upkeep";
import { createObjectWorkspaceFilesV1 } from "@frockbot/core/workspace-store";
import {
  createInMemoryObjectBucketV1,
  createInMemoryWorkspaceGenerationsV1,
} from "@frockbot/core/workspace-store/testing";

export interface LiveMachineOptions {
  origin: string;
  hostToken: string;
  userId: string;
  botId: string;
  check(condition: boolean, message: string): void;
  /** Whether the Sprite behind this User's Computer exists. */
  spriteExists(): Promise<boolean>;
}

/** The Bot Durable Object's storage, as a map. */
class MemoryStorage implements ComputerBotStorage {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
  }
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(key: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else for (const [k, v] of Object.entries(key)) this.values.set(k, v);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  transaction<T>(
    callback: (storage: ComputerBotTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

/**
 * The User's sealed sign-ins, as the User's Durable Object keeps them: one
 * capture, the debt an Update or a Reset leaves, and when the Computer was
 * last deleted.
 */
class MemoryLoginVault implements ComputerLoginVaultV1 {
  held?: ComputerLoginsKeptV1;
  owedSince?: string;
  deletedAt?: string;

  /** "Delete my Computer", as the User's object records it. */
  forget(at: string): void {
    this.held = undefined;
    this.owedSince = undefined;
    this.deletedAt = at;
  }
  deletedSince(at: string): Promise<boolean> {
    return Promise.resolve(
      this.deletedAt !== undefined && this.deletedAt >= at,
    );
  }
  owed(): Promise<string | undefined> {
    return Promise.resolve(this.owedSince);
  }
  kept(): Promise<ComputerLoginsKeptV1 | undefined> {
    return Promise.resolve(this.held);
  }
  keep(capture: ComputerLoginsKeptV1): Promise<ComputerLoginsKeepOutcomeV1> {
    const outcome: ComputerLoginsKeepOutcomeV1 = this.owedSince
      ? "owed"
      : (this.deletedAt !== undefined &&
            this.deletedAt >= capture.capturedAt) ||
          (this.held && this.held.capturedAt >= capture.capturedAt)
        ? "stale"
        : "kept";
    if (outcome === "kept") this.held = capture;
    return Promise.resolve(outcome);
  }
  owe(at: string): Promise<"owed" | "deleted"> {
    if (this.deletedAt !== undefined && this.deletedAt >= at) {
      return Promise.resolve("deleted");
    }
    this.owedSince ??= at;
    return Promise.resolve("owed");
  }
  settle(owedSince: string): Promise<void> {
    if (this.owedSince === owedSince) this.owedSince = undefined;
    return Promise.resolve();
  }
}

const SITE_PORT = 8765;
/** `*.localhost` is loopback to Chromium, and a name a cookie can belong to. */
const SITE = `http://frockbot-live.localhost:${SITE_PORT}`;
const SITE_DIR = "/tmp/frockbot-live-site";
const COOKIE = "frockbot_live";

const siteSource = `
const http = require("http");
const fs = require("fs");
http.createServer((request, response) => {
  const url = new URL(request.url, "http://site");
  if (url.pathname === "/login") {
    response.writeHead(200, {
      "set-cookie": "${COOKIE}=" + url.searchParams.get("as") + "; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax",
      "content-type": "text/html",
    });
    response.end("<title>Signed in</title>");
    return;
  }
  const match = /(?:^|; )${COOKIE}=([^;]+)/.exec(request.headers.cookie || "");
  fs.writeFileSync("${SITE_DIR}/seen", match ? match[1] : "signed-out");
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<title>" + (match ? "Signed in" : "Signed out") + "</title>");
}).listen(${SITE_PORT}, "127.0.0.1");
`;

export async function proveUpdateResetAndDelete(
  options: LiveMachineOptions,
): Promise<void> {
  const { check, userId, botId } = options;
  const bucket = createInMemoryObjectBucketV1();
  const generations = createInMemoryWorkspaceGenerationsV1();
  const store = createObjectWorkspaceFilesV1({
    bucket,
    generations,
    owner: { userId },
    surface: "sync",
  });
  const provider = new FlyComputerHostV1(
    undefined,
    (identity, tenant) =>
      new FlyHostTransportV1({
        fetcher: { fetch: (request) => fetch(request) },
        hostToken: options.hostToken,
        origin: options.origin,
        identity,
        tenant,
      }),
    { store, generations },
  );
  const open = (effectId = `live-${randomUUID()}`) =>
    provider.open(
      { userId },
      { botId },
      { providerId: provider.id, generation: 1 },
      { effectId },
    );
  const vault = new MemoryLoginVault();
  const contribution = createComputerBotBackendContribution({
    storage: new MemoryStorage(),
    providerLabel: "Computer",
    configured: true,
    loginVault: () => vault,
    openComputer: (_userId, _botId, effectId) => open(effectId),
  });
  let commands = 0;
  const command = async (type: ComputerCommandV1["type"]): Promise<void> => {
    const receipt = await contribution.execute(userId, botId, {
      version: 1,
      commandId: `live-${type}-${(commands += 1)}`,
      botId,
      type,
    });
    if (receipt.status === "rejected") {
      throw new Error(`${type} was refused: ${JSON.stringify(receipt)}`);
    }
    // Update and Reset run where a connect runs, on the Bot's alarm.
    await contribution.settleScheduledWork();
    const projected = await contribution.read(userId, botId);
    if (projected.phase === "error") {
      throw new Error(`${type} failed: ${projected.message}`);
    }
  };

  /** One Turn's use of the Computer: open, work, close. */
  async function turn<T>(
    work: (session: ComputerHostSessionV1) => Promise<T>,
  ): Promise<T> {
    const session = await open();
    try {
      return await work(session);
    } finally {
      await session.close();
    }
  }

  async function shell(
    session: ComputerHostSessionV1,
    script: string,
  ): Promise<string> {
    const result = await session.exec!.execute({
      executable: "bash",
      args: ["-c", script],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1_024,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    if (result.exitCode !== 0) {
      throw new Error(
        `exec exited ${result.exitCode}: ${stdout}${new TextDecoder().decode(result.stderr)}`,
      );
    }
    return stdout;
  }

  /** Starts the site on this machine, unless it is already answering. */
  async function startSite(session: ComputerHostSessionV1): Promise<void> {
    await shell(
      session,
      [
        `mkdir -p ${SITE_DIR}`,
        `if ! (exec 3<>/dev/tcp/127.0.0.1/${SITE_PORT}) 2>/dev/null; then`,
        `  cat > ${SITE_DIR}/site.js <<'__SITE__'`,
        siteSource.trim(),
        "__SITE__",
        `  setsid nohup node ${SITE_DIR}/site.js > ${SITE_DIR}/log 2>&1 &`,
        "  for _ in $(seq 1 50); do",
        `    (exec 3<>/dev/tcp/127.0.0.1/${SITE_PORT}) 2>/dev/null && break`,
        "    sleep 0.2",
        "  done",
        "fi",
      ].join("\n"),
    );
  }

  /** Who the site says the browser is signed in as. */
  async function signedInAs(session: ComputerHostSessionV1): Promise<string> {
    await startSite(session);
    await session.browser!.perform({ type: "navigate", url: `${SITE}/whoami` });
    return (await shell(session, `cat ${SITE_DIR}/seen`)).trim();
  }

  async function signIn(
    session: ComputerHostSessionV1,
    as: string,
  ): Promise<void> {
    await startSite(session);
    await session.browser!.perform({
      type: "navigate",
      url: `${SITE}/login?as=${as}`,
    });
  }

  // The tenant's directory is relative to the home the layout mounts
  // durable roots under; the Bot's own Skills root is inside it.
  const skillPath = (session: ComputerHostSessionV1) =>
    `/home/box/agent-data/agents/${session.tenant.directory?.split("/").at(-1)}/skills/live-check/SKILL.md`;
  const skill = `---\nname: live-check\ndescription: Written on a Computer before its Update (${randomUUID()}).\n---\n\nKept.\n`;
  const readSkill = (session: ComputerHostSessionV1) =>
    shell(session, `cat ${skillPath(session)} 2>/dev/null || true`);
  /** Something the machine holds and no durable root does. */
  const MACHINE_FILE = "/home/box/installed-since";
  const machineFile = (session: ComputerHostSessionV1) =>
    shell(session, `cat ${MACHINE_FILE} 2>/dev/null || echo absent`);

  process.stdout.write("Update, Reset and Delete my Computer\n");

  // --- signed in, with a file ---------------------------------------------
  const first = `first-${randomUUID().slice(0, 8)}`;
  await turn(async (session) => {
    await signIn(session, first);
    check(
      (await signedInAs(session)) === first,
      "the Computer's browser is signed in to a site",
    );
    await shell(
      session,
      [
        `mkdir -p "$(dirname ${skillPath(session)})"`,
        `cat > ${skillPath(session)} <<'__SKILL__'`,
        skill.trimEnd(),
        "__SKILL__",
        `echo before-update > ${MACHINE_FILE}`,
      ].join("\n"),
    );
    // The end of the Turn that wrote it, which is when a Bot's file leaves
    // the machine.
    const pushed = await session.sync!.reconcile("turn-end");
    check(
      pushed.status === "ok" && pushed.pushed >= 1,
      `a Skill written on the Computer reached object storage (${pushed.status}, ${pushed.pushed} pushed)`,
    );
  });

  await command("saveCheckpoint");
  check(
    (await contribution.read(userId, botId)).checkpoint !== undefined,
    "a checkpoint is saved and the Computer card shows it",
  );

  // --- Update --------------------------------------------------------------
  const updateStarted = Date.now();
  await command("updateComputer");
  check(
    true,
    `Update replaced the machine and brought it back in ${Math.round((Date.now() - updateStarted) / 1_000)}s`,
  );
  check(
    vault.held !== undefined && vault.owedSince === undefined,
    "the sign-ins were kept before the machine went, and are owed nothing now",
  );
  await turn(async (session) => {
    check(
      (await machineFile(session)).trim() === "absent",
      "the updated Computer is a fresh machine: what was installed is gone",
    );
    // The next Turn's first sync, which is what puts durable roots back.
    const pulled = await session.sync!.reconcile("open");
    check(
      pulled.status === "ok" && pulled.pulled + pulled.restored >= 1,
      `the next Turn's sync put the durable roots back (${pulled.pulled} pulled, ${pulled.restored} restored)`,
    );
    check(
      (await readSkill(session)) === skill,
      "the Skill written before the Update survived it",
    );
    check(
      (await signedInAs(session)) === first,
      "the site still sees the browser signed in after the Update",
    );
  });

  // --- Reset ---------------------------------------------------------------
  // A checkpoint of the updated machine, then changes after it: something
  // installed, which Reset takes away, and a newer sign-in, which Reset keeps.
  await command("saveCheckpoint");
  const second = `second-${randomUUID().slice(0, 8)}`;
  await turn(async (session) => {
    await shell(session, `echo after-checkpoint > ${MACHINE_FILE}`);
    await signIn(session, second);
    check(
      (await signedInAs(session)) === second,
      "a newer sign-in after the checkpoint",
    );
  });
  const resetStarted = Date.now();
  await command("resetComputer");
  check(
    true,
    `Reset put the machine back to its checkpoint in ${Math.round((Date.now() - resetStarted) / 1_000)}s`,
  );
  await turn(async (session) => {
    check(
      (await machineFile(session)).trim() === "absent",
      "what was installed after the checkpoint is gone after the Reset",
    );
    await session.sync!.reconcile("open");
    check((await readSkill(session)) === skill, "the Skill survived the Reset");
    check(
      (await signedInAs(session)) === second,
      "the site sees the newer sign-in after the Reset, not the checkpoint's",
    );
  });

  // --- Delete my Computer --------------------------------------------------
  // What the User's object does: forget the sign-ins on both sides of the
  // teardown, so no capture that raced it is kept.
  const deletedAt = new Date().toISOString();
  vault.forget(deletedAt);
  await provider.teardown({ userId });
  vault.forget(deletedAt);
  check(
    !(await options.spriteExists()),
    "Delete my Computer removed the machine",
  );
  check(
    (await vault.kept()) === undefined && (await vault.owed()) === undefined,
    "and the saved sign-ins are gone with it",
  );
  // The next Turn gets a new Computer. Nothing is owed to it, and nothing of
  // the old browser is in it.
  const deleteStarted = Date.now();
  await turn(async (session) => {
    check(
      (await signedInAs(session)) === "signed-out",
      `the Computer a Bot opens next (${Math.round((Date.now() - deleteStarted) / 1_000)}s) is signed in to nothing`,
    );
    const capture = await session.logins!.capture();
    const document = capture ? new TextDecoder().decode(capture.state) : "";
    check(
      !document.includes(COOKIE),
      "and its browser holds none of the deleted Computer's cookies",
    );
  });
}
