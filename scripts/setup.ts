#!/usr/bin/env bun
/**
 * `bun run setup` — install FrockBot into your own Cloudflare account.
 *
 * The simple deployment of ADR 0028: Cloudflare Access sign-in, no billing, the
 * Computer, and nothing to customise. It creates the resources,
 * mints the secrets, asks for the two or three keys only you have, sets up the
 * Access application and deploys the three Workers, pulling the container images
 * and the web client from the release for the tag you checked out.
 *
 * Idempotent: a second run converges and says "nothing to do" per step, which is
 * also how an upgrade works — check out the next tag and run it again.
 *
 *   bun run setup
 *   bun run setup --dry-run          ask, then print what it would do; run nothing
 *   bun run setup --yes              take every default, skip every optional key
 *   bun run setup --profile <path>   reuse a profile file instead of answering
 *   bun run setup --account <id>     when the token can reach several accounts
 *
 * `scripts/setup-production.sh` is the hosted deployment's wizard and is not
 * this: it sets GitHub environment secrets for `release.yml` and touches no
 * Cloudflare resource.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT_V1 } from "./deployment-config/profile.ts";
import {
  MissingAnswerV1,
  createDefaultingAskerV1,
  createTerminalAskerV1,
} from "./setup/prompts.ts";
import { createDryRunRunnerV1, createLiveRunnerV1 } from "./setup/runner.ts";
import {
  askHumanSecretsV1,
  chooseAccountV1,
  configureAccessV1,
  createResourcesV1,
  deployV1,
  fetchReleaseV1,
  mintInternalSecretsV1,
  nextStepsV1,
  writeProfileV1,
  type SetupContextV1,
  type SetupOptionsV1,
} from "./setup/steps.ts";

function usage(): never {
  console.error(
    "usage: bun run setup [--dry-run] [--yes] [--profile <path>] [--account <id>] [--allow-hosted-account]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let dryRun = false;
let yes = false;
let allowHostedAccount = false;
let profile: string | undefined;
let account: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  switch (args[index]) {
    case "--dry-run":
      dryRun = true;
      break;
    case "--yes":
      yes = true;
      break;
    case "--allow-hosted-account":
      allowHostedAccount = true;
      break;
    case "--profile":
      profile = args[(index += 1)];
      if (!profile) usage();
      break;
    case "--account":
      account = args[(index += 1)];
      if (!account) usage();
      break;
    default:
      usage();
  }
}

const say = (line: string) => console.log(line);
const runner = dryRun ? createDryRunRunnerV1(say) : createLiveRunnerV1(say);
const options: SetupOptionsV1 = {
  yes,
  allowHostedAccount,
  ...(profile === undefined ? {} : { profile }),
  ...(account === undefined ? {} : { account }),
};
const context: SetupContextV1 = {
  runner,
  // `--yes` is the only thing that answers for a person: a dry run still asks,
  // so a deployer can see what their own answers would do. A question with no
  // default under `--yes` fails naming the flag rather than passing an empty
  // string on.
  asker: yes
    ? createDefaultingAskerV1(say, "--yes")
    : createTerminalAskerV1(say),
  options,
  env: process.env,
  repoRoot: REPO_ROOT_V1,
};

/** The account `deployments/hosted.json` names, which the installer refuses. */
function hostedAccountIdV1(): string {
  const hosted = JSON.parse(
    readFileSync(join(REPO_ROOT_V1, "deployments", "hosted.json"), "utf8"),
  ) as { accountId: string };
  return hosted.accountId;
}

say("FrockBot — the simple deployment");
say(
  dryRun
    ? "A dry run: every command and every value it would write is printed, and nothing is run."
    : "One Cloudflare account on Workers Paid with a domain on it, a Fly token for the Computer, and a Zero Trust team.",
);

try {
  const chosen = await chooseAccountV1(context, hostedAccountIdV1());
  let written = await writeProfileV1(context, chosen);
  await createResourcesV1(context, written);
  const minted = await mintInternalSecretsV1(context);
  const human = await askHumanSecretsV1(context, written);
  const secrets = { ...minted, ...human.values };
  const access = await configureAccessV1(context, written);
  written = access.profile;
  written = await fetchReleaseV1(context, written);
  const outcome = await deployV1(context, written, secrets);

  say("");
  say(dryRun ? "That is the whole of it. Nothing was run." : "Installed.");
  for (const line of nextStepsV1(
    { ...outcome, byHand: [...outcome.byHand, ...access.byHand] },
    human.skipped,
  )) {
    say(`  • ${line}`);
  }
} catch (error) {
  say("");
  console.error(
    error instanceof MissingAnswerV1
      ? `Stopped: ${error.message}`
      : `Stopped: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error(
    "Nothing already created was undone. Fix the cause and run `bun run setup` again: it converges.",
  );
  process.exit(1);
}
