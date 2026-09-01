/**
 * The opt-in live check for the User-wide `desktop-gui` lease.
 *
 * ADR 0017 serializes `computerUse` subagents at the Computer host's own
 * `control` op: one screen on one Computer that serves all of a User's Bots, so
 * a second `computerUse` task is refused and told who holds the desktop. The
 * fake host in `apps/cloudflare/test/computer-host-fake.ts` runs that rule
 * faithfully, and `subagents-roles.workerd.ts` proves the Bot Durable Objects
 * against it — but the rule itself is `flock`-serialized bash on a Sprite, and
 * only a real Computer can say whether that bash does what it claims.
 *
 * This script is that check, and nothing else: it drives `/v1/computer/control`
 * against a Computer host that is already running (`bun run --filter
 * @frockbot/computer-host dev`, or a deployed one), for one throwaway User.
 *
 *     SPRITES_TOKEN=… COMPUTER_HOST_TOKEN=… \
 *       bun run --filter @frockbot/computer-host test:live:desktop
 *
 * Without `SPRITES_TOKEN` it skips and exits 0: an opt-in live check must never
 * be the reason a gate fails on a machine that was never going to have a
 * Computer. The token is a *gate* here and nothing more — it is never read from
 * a file, never sent anywhere, and never printed.
 */

import {
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  decodeComputerHostControlResultV1,
  decodeComputerHostProblemV1,
  type ComputerHostControlScopeV1,
} from "@frockbot/computer-host-protocol";

const SKIP_MESSAGE =
  "SPRITES_TOKEN is not set: skipping the live desktop-lease check.";

function required(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

if (!required("SPRITES_TOKEN")) {
  process.stdout.write(`${SKIP_MESSAGE}\n`);
  process.exit(0);
}

const hostToken = required("COMPUTER_HOST_TOKEN");
if (!hostToken) {
  process.stderr.write(
    "COMPUTER_HOST_TOKEN is required to reach a running Computer host.\n",
  );
  process.exit(1);
}

const origin = required("COMPUTER_HOST_URL") ?? "http://127.0.0.1:8790";
/** One throwaway User: its Computer is the box the lease is held against. */
const userId = `frockbot-lease-${crypto.randomUUID()}`;

interface ControlAnswer {
  status: number;
  ownerId?: string;
  expiresAt?: string;
  message?: string;
}

async function control(
  botId: string,
  action: "acquire" | "renew" | "release",
  ownerId: string,
  scope: ComputerHostControlScopeV1,
): Promise<ControlAnswer> {
  const response = await fetch(`${origin}${COMPUTER_HOST_ROUTES.control}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [COMPUTER_HOST_TOKEN_HEADER]: hostToken,
    },
    body: JSON.stringify({
      version: 1,
      effectId: `${action}-${ownerId}-${crypto.randomUUID()}`,
      identity: { userId },
      tenant: { botId },
      credentialRef: `sprites:user:${userId}`,
      operation: {
        kind: "control",
        action,
        ownerId,
        maxAgeSeconds: 600,
        scope,
      },
    }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    return {
      status: response.status,
      message: decodeComputerHostProblemV1(payload).message,
    };
  }
  const result = decodeComputerHostControlResultV1(payload);
  return {
    status: response.status,
    ownerId: result.ownerId,
    ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
  };
}

function assert(claim: boolean, what: string): void {
  if (claim) {
    process.stdout.write(`  ok  ${what}\n`);
    return;
  }
  process.stderr.write(`  FAIL  ${what}\n`);
  process.exitCode = 1;
}

const first = { botId: "lease-bot-a", owner: "task-lease-bot-a-tk-1" };
const second = { botId: "lease-bot-b", owner: "task-lease-bot-b-tk-2" };

process.stdout.write(`Live desktop-gui lease check on ${origin}\n`);
try {
  // One `computerUse` task takes the desktop.
  const held = await control(
    first.botId,
    "acquire",
    first.owner,
    "desktop-gui",
  );
  assert(
    held.status === 200,
    "the first computerUse task acquires the desktop",
  );
  assert(held.expiresAt !== undefined, "the host answers with an expiry");

  // A second one — in another Bot of the same User, which is the case a Bot
  // Durable Object cannot see — is refused, and told who holds it.
  const refused = await control(
    second.botId,
    "acquire",
    second.owner,
    "desktop-gui",
  );
  assert(refused.status === 409, "a second computerUse task is refused");
  assert(
    (refused.message ?? "").includes(first.owner),
    "the refusal names the holder",
  );

  // The per-tenant human-takeover lease is a different scope on the same op, so
  // holding the desktop does not stop a human taking their own Bot's screen.
  const takeover = await control(second.botId, "acquire", "human-1", "bot");
  assert(takeover.status === 200, "the per-Bot takeover lease is independent");
  await control(second.botId, "release", "human-1", "bot");

  // Releasing restores it, and only the holder's release counts.
  const strangerRelease = await control(
    second.botId,
    "release",
    second.owner,
    "desktop-gui",
  );
  assert(strangerRelease.status === 200, "a stranger's release is accepted");
  const stillHeld = await control(
    second.botId,
    "acquire",
    second.owner,
    "desktop-gui",
  );
  assert(
    stillHeld.status === 409,
    "…and changes nothing: the desktop is still held",
  );

  await control(first.botId, "release", first.owner, "desktop-gui");
  const taken = await control(
    second.botId,
    "acquire",
    second.owner,
    "desktop-gui",
  );
  assert(taken.status === 200, "the holder's release hands the desktop back");
  await control(second.botId, "release", second.owner, "desktop-gui");
} finally {
  process.stdout.write(
    process.exitCode
      ? "Live desktop-lease check FAILED\n"
      : "Live desktop-lease check passed\n",
  );
}
