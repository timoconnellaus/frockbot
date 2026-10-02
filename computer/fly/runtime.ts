/**
 * The Computer runtime as it runs on a Fly Sprite: the Linux runtime
 * (`computer/linux-runtime`) with the Sprite's own parts filled in — the Tasks
 * API hold that keeps a Sprite awake under a detached provisioner, the
 * checks and notes that go with it, the build the Sprite image needs, and the
 * name a User's Sprite takes.
 *
 * Everything that is not the Sprite's is re-exported from the Linux runtime,
 * so the host app and this implementation read one layout from one place. The
 * bound documents are declared and described in `linuxRuntimeDocumentV1`.
 */
import {
  linuxRuntimeDocumentV1,
  PLAYWRIGHT_VERSION,
} from "../linux-runtime/runtime.js";

export * from "../linux-runtime/runtime.js";

/**
 * The Sprite's own management socket, and the task that holds it awake.
 *
 * A detached provisioner does not keep its Sprite running. Sprites define
 * activity as "a command running, a session producing output, an open TCP
 * connection to its URL, a service handling traffic" — a `setsid nohup`
 * background process is none of those, so the platform is free to pause the
 * VM while `apt-get` is mid-download and resume it when the host's next poll
 * arrives. Measured on 2026-09-01 against a disposable Sprite: with nothing
 * holding it up, the Sprite's own clock advanced ~4 minutes while ~25 minutes
 * of wall time passed, so provisioning ran at roughly a seventh of its speed
 * and no package list could have fitted inside the ten-minute bound.
 *
 * The documented hold is the Tasks API on `/.sprite/api.sock`: "Register a
 * task; the Sprite stays up. Delete it (or let it expire); the Sprite is free
 * to pause again." The task is registered with a short expiry and refreshed
 * from a child process, so a provisioner that dies without cleaning up stops
 * paying for the Sprite within the expiry rather than pinning it awake.
 *
 * @see https://docs.sprites.dev/keeping-sprites-running/
 */
export const SPRITE_API_SOCKET = "/.sprite/api.sock";
/** The name the provisioner's keepalive task holds. */
export const PROVISION_TASK = "frockbot-provision";
/** Short enough that a crashed provisioner releases the Sprite on its own. */
export const PROVISION_TASK_EXPIRY = "5m";
/** Four refreshes inside one expiry, the interval the Sprites docs recommend. */
export const PROVISION_TASK_REFRESH_SECONDS = 60;

/**
 * The Playwright build the Computer downloads, named for a release Playwright
 * knows rather than the one the Sprite actually runs.
 *
 * Playwright resolves a browser build from the host distribution and refuses
 * anything it has no build for: on the Sprite base image it answers "Playwright
 * does not support chromium on ubuntu26.04-x64" and installs nothing. This is
 * the newest release it does have a build for, and that build was verified
 * running headful under Xvfb on a real Sprite with CDP answering.
 */
export const PLAYWRIGHT_PLATFORM = "ubuntu24.04-x64";

export const {
  REFERENCE_DOCS,
  boxDoctorScript,
  COMPUTER_RUNTIME_FILES,
  INSTALL_MANIFEST_PATHS,
  PROVISION_PHASES,
  UPDATE_PHASES,
  provisionScript,
  RUNTIME_DOCUMENT_FILES,
  runtimeDocumentDigestV1,
  provisionLaunchScript,
  updateLaunchScript,
} = linuxRuntimeDocumentV1({
  dnsProbeName: "api.fly.io",
  provisionHold: `sprite_task() {
  curl -sS --max-time 10 --unix-socket ${SPRITE_API_SOCKET} "$@" >/dev/null 2>&1 || true
}
sprite_task -H 'Content-Type: application/json' -X POST http://sprite/v1/tasks -d '{"name":"${PROVISION_TASK}","expire":"${PROVISION_TASK_EXPIRY}"}'
while sleep ${PROVISION_TASK_REFRESH_SECONDS}; do
  curl -sS --max-time 10 --unix-socket ${SPRITE_API_SOCKET} -H 'Content-Type: application/json' -X PUT http://sprite/v1/tasks/${PROVISION_TASK} -d '{"expire":"${PROVISION_TASK_EXPIRY}"}' >/dev/null 2>&1 || exit 0
done &
KEEPALIVE=$!
release() {
  kill "$KEEPALIVE" 2>/dev/null || true
  sprite_task -X DELETE http://sprite/v1/tasks/${PROVISION_TASK}
}
trap release EXIT
`,
  doctorChecks: `# The provisioner holds this Sprite awake with a Tasks-API task, because the
# platform is otherwise free to pause a VM under a detached \`apt-get\`. The
# hold is released on the provisioner's EXIT; one still registered afterwards
# is a Sprite that cannot pause and is billed awake for nothing.
if [ ! -S ${SPRITE_API_SOCKET} ]; then
  record sprite-hold pass "this Computer exposes no Sprite task API, so it holds nothing awake"
elif curl -sS --max-time 5 --unix-socket ${SPRITE_API_SOCKET} http://sprite/v1/tasks 2>/dev/null | grep -q ${PROVISION_TASK}; then
  record sprite-hold fail "the ${PROVISION_TASK} hold is still registered; this Sprite cannot pause"
else
  record sprite-hold pass "no provisioning hold is registered; this Computer is free to pause"
fi
`,
  doctorFailureNotes: `- **sprite-hold** — a provisioning hold is still registered, so this Computer
  cannot pause and is being paid for while idle. Worth reporting.
`,
  aptRefreshNote: `  # The base image ships a populated /var/lib/apt/lists, but a stale one: on
  # 2026-09-01 installing straight from it failed with 404s on superseded
  # libheif .debs that security.ubuntu.com no longer carries. The refresh is
  # not the expense it looked like — measured at 6 s once the Sprite is held
  # awake, against the 262 s measured for the same command on a Sprite the
  # platform kept pausing underneath it.
`,
  playwrightPlatform: PLAYWRIGHT_PLATFORM,
  playwrightPlatformNote: `  # PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, because Playwright ${PLAYWRIGHT_VERSION} refuses
  # the Sprite base image outright: "Playwright does not support chromium on
  # ubuntu26.04-x64". It has no build named for that release and will not
  # guess. The build named for the newest release it does know runs on it —
  # proved on a real Sprite, headful under Xvfb with CDP answering — so this
  # names that build rather than leaving the phase to fail.
`,
});

/** The Sprite name pattern a Computer may take: 3-63 lowercase DNS characters. */
export const COMPUTER_SPRITE_NAME = /^[a-z][a-z0-9-]{2,62}$/;

/**
 * The Sprite backing one User's Computer.
 *
 * "One Computer per User, shared by all Bots", so the name is
 * derived from the User and from nothing else. The digest is taken over a
 * JSON-encoded `["user", userId]` rather than the bare id, so a future key
 * of another kind cannot collide with a User id that happens to spell the
 * same string.
 *
 * `digest` is supplied by the caller because the two runtimes that need this
 * name hash differently: Node has `node:crypto`, workerd has WebCrypto. The
 * derivation itself lives here once.
 */
export function computerSpriteNameV1(
  userId: string,
  digestHex: string,
  baseName: string,
): string {
  const base = baseName.trim();
  if (!COMPUTER_SPRITE_NAME.test(base)) {
    throw new Error(
      "Computer Sprite base name must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  const id = userId.trim();
  if (!id || id.length > 200)
    throw new Error("Computer Sprite userId must contain 1-200 characters");
  if (!/^[a-f0-9]{64}$/.test(digestHex))
    throw new Error("Computer Sprite name requires a SHA-256 hex digest");
  const prefix = base.slice(0, 49).replace(/-+$/g, "");
  return `${prefix}-${digestHex.slice(0, 12)}`;
}

/** What `computerSpriteNameV1` expects a digest of. */
export function computerSpriteNameSourceV1(userId: string): string {
  const id = userId.trim();
  if (!id || id.length > 200)
    throw new Error("Computer Sprite userId must contain 1-200 characters");
  return JSON.stringify(["user", id]);
}
