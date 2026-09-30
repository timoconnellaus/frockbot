#!/usr/bin/env bun
/**
 * Deploy a release's bundle into a Cloudflare account through the API alone —
 * no wrangler build, no Docker, no Flutter — which is what the deploy page does
 * in a browser. This is its proof ([docs/deploy-bundles.md](../docs/deploy-bundles.md)).
 *
 *   bun scripts/deploy-bundle.ts deploy  --bundle <version|manifest.json> --install <name> ...
 *   bun scripts/deploy-bundle.ts converse --url https://<host>
 *   bun scripts/deploy-bundle.ts prove   --from <version|manifest> --to <version|manifest> --install <name> ...
 *
 * `prove` is the whole claim: install one release into a scratch account, hold
 * a conversation, deploy the next release over it, read the first conversation
 * back — the data was kept — and hold another.
 *
 * Install flags:
 *   --account <id>            the scratch account (CLOUDFLARE_ACCOUNT_ID)
 *   --install <name>          what every Worker and resource is named from
 *   --hostname <host>         the app's custom domain, on a zone in the account
 *   --access-team <domain>    the Zero Trust team domain
 *   --access-aud <tag>        the Access application's audience tag
 *   --secrets <file.json>     the secrets by name; minted ones are added to it
 *   --no-computer-host        run without its own Computer host
 *   --location <hint>         an R2 location hint for a first install
 *
 * The token is CLOUDFLARE_API_TOKEN, or `wrangler login`'s. A conversation is a
 * person's: sign in at the hostname once, and pass that browser's
 * `CF_Authorization` cookie as FROCKBOT_ACCESS_TOKEN.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installWorkersV1,
  type InstallV1,
} from "../apps/cloudflare/deployment-config/bundle.ts";
import {
  createCloudflareApiV1,
  deployBundleV1,
} from "../apps/cloudflare/deployment-config/deploy.ts";
import { REPO_ROOT_V1 } from "./deployment-config/repository.ts";
import {
  cloudflareTokenV1,
  converseV1,
  loadBundleV1,
  readBackV1,
  type LocalBundleV1,
} from "./deploy-bundle/local.ts";
import { credentialKeyringV1, randomHexV1, vapidKeysV1 } from "./setup/plan.ts";

const say = (line: string) => console.log(line);

function flags(args: readonly string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected ${arg}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) switches.add(arg);
    else {
      values.set(arg, next);
      index += 1;
    }
  }
  const required = (flag: string, env?: string) => {
    const value = values.get(flag) ?? (env ? process.env[env] : undefined);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return { values, switches, required };
}

/**
 * The secrets file, with every secret the bundle mints added when absent. It is
 * the only record of them: minting a second value later would invalidate what
 * the first one encrypted and signed.
 */
async function secretsFor(
  bundle: LocalBundleV1,
  file: string,
  hostname: string,
): Promise<Record<string, string>> {
  const secrets = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
    : {};
  let minted = false;
  for (const worker of Object.values(bundle.manifest.workers)) {
    for (const secret of worker.secrets) {
      if (!secret.mint || secrets[secret.name]) continue;
      secrets[secret.name] =
        secret.mint === "keyring"
          ? credentialKeyringV1()
          : secret.mint === "vapid"
            ? await vapidKeysV1(hostname)
            : randomHexV1();
      minted = true;
      say(`  minted     ${secret.name}`);
    }
  }
  if (minted) {
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    say(`  recorded   ${file} (mode 0600) — the only copy of what was minted`);
  }
  return secrets;
}

async function deploy(
  args: ReturnType<typeof flags>,
  spec: string,
): Promise<{ url: string }> {
  const bundle = await loadBundleV1(
    spec,
    mkdtempSync(join(tmpdir(), "frockbot-bundle-")),
  );
  say(`▸ ${bundle.manifest.version}`);
  const hostname = args.required("--hostname");
  const install: InstallV1 = {
    accountId: args.required("--account", "CLOUDFLARE_ACCOUNT_ID"),
    name: args.required("--install"),
    hostnames: [hostname],
    computerHost: !args.switches.has("--no-computer-host"),
    vars: {
      ACCESS_TEAM_DOMAIN: args.required("--access-team"),
      ACCESS_AUD: args.required("--access-aud"),
      APP_ORIGIN: `https://${hostname}`,
    },
    secrets: await secretsFor(bundle, args.required("--secrets"), hostname),
    ...(args.values.get("--location")
      ? { location: args.values.get("--location")! }
      : {}),
  };
  say(`  workers    ${installWorkersV1(install).join(", ")}`);
  const api = createCloudflareApiV1({
    token: await cloudflareTokenV1(process.env, REPO_ROOT_V1),
  });
  const outcome = await deployBundleV1({
    api,
    manifest: bundle.manifest,
    files: bundle.files,
    install,
    say,
  });
  say(
    `  ${outcome.firstInstall ? "installed" : "updated"}  ${outcome.version} at ${outcome.url}`,
  );
  return { url: outcome.url! };
}

/** Wait for the hostname to answer the new version: DNS and the edge settle. */
async function waitForLiveV1(url: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/identity`, {
        redirect: "manual",
      });
      // 401 is the Worker refusing an anonymous caller: it is up.
      if (response.status === 401 || response.status === 200) return;
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(5_000);
  }
  throw new Error(`${url} never answered: ${last}`);
}

function accessTokenV1(): string {
  const token = process.env.FROCKBOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "FROCKBOT_ACCESS_TOKEN is unset: sign in at the install's hostname in a browser and pass its CF_Authorization cookie",
    );
  }
  return token;
}

async function converse(url: string, text: string) {
  await waitForLiveV1(url);
  const conversation = await converseV1({
    url,
    accessToken: accessTokenV1(),
    text,
  });
  say(`  conversed  ${conversation.botId} ${conversation.runId}`);
  say(`             “${conversation.reply.slice(0, 200)}”`);
  return conversation;
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = flags(rest);
  switch (command) {
    case "deploy": {
      await deploy(args, args.required("--bundle"));
      return;
    }
    case "converse": {
      await converse(
        args.required("--url"),
        args.values.get("--text") ?? "Say hello in one short sentence.",
      );
      return;
    }
    case "prove": {
      const first = await deploy(args, args.required("--from"));
      const before = await converse(
        first.url,
        "Remember the word marmalade, and say hello in one short sentence.",
      );
      const second = await deploy(args, args.required("--to"));
      await waitForLiveV1(second.url);
      await readBackV1({
        url: second.url,
        accessToken: accessTokenV1(),
        conversation: before,
      });
      say(`  kept       ${before.runId} reads back after the update`);
      await converse(second.url, "Which word did I ask you to remember?");
      say(
        "Proved: installed, conversed, updated in place, data kept, conversed again.",
      );
      return;
    }
    default:
      console.error(
        "usage: bun scripts/deploy-bundle.ts deploy|converse|prove [flags] (see the file's header)",
      );
      process.exit(2);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(
    `Stopped: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
