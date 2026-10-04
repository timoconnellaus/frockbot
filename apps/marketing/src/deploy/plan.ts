/**
 * What the deploy flow decides, apart from what it does.
 *
 * Names, addresses, the account checks and their fixes, the Worker's upload
 * metadata and which migrations are due: functions over values, so the tests
 * can check every judgement without a Cloudflare account.
 */
import type { JevProbeV1 } from "./jev-probe";

/**
 * Short enough that `<name>-<role>` fits every resource's name limit (R2's 63
 * is the tightest), and a DNS label besides.
 */
export const INSTALL_NAME_MAX_V1 = 40;
const INSTALL_NAME_PATTERN = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

export function installNameProblemV1(name: string): string | undefined {
  if (name.length === 0) return "Give it a name.";
  if (name.length > INSTALL_NAME_MAX_V1) {
    return `Keep it to ${INSTALL_NAME_MAX_V1} characters.`;
  }
  if (!INSTALL_NAME_PATTERN.test(name) || name.includes("--")) {
    return "Use lowercase letters, numbers and single dashes, starting with a letter.";
  }
  return undefined;
}

/** A name from what someone typed: lowercased, dashed, trimmed to fit. */
export function normalizeInstallNameV1(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, INSTALL_NAME_MAX_V1)
    .replace(/-+$/, "");
}

/** `tims-frockbot` for tim@example.com. */
export function suggestedInstallNameV1(email: string): string {
  const local = normalizeInstallNameV1(email.split("@")[0] ?? "");
  const base = local
    ? `${local.slice(0, INSTALL_NAME_MAX_V1 - 10)}-frockbot`
    : "frockbot";
  return normalizeInstallNameV1(base) || "frockbot";
}

/** A `workers.dev` subdomain for an account that has none yet. */
export function suggestedWorkersSubdomainV1(
  accountName: string,
  accountId: string,
): string {
  const base = normalizeInstallNameV1(accountName).slice(0, 40) || "frockbot";
  return `${base}-${accountId.slice(0, 6)}`;
}

export function installHostnameV1(
  name: string,
  workersSubdomain: string,
): string {
  return `${name}.${workersSubdomain}.workers.dev`;
}

export function installOriginV1(
  name: string,
  workersSubdomain: string,
): string {
  return `https://${installHostnameV1(name, workersSubdomain)}`;
}

/** A Zero Trust team name for an account that has never had one. */
export function suggestedTeamNameV1(
  accountName: string,
  accountId: string,
): string {
  const base = normalizeInstallNameV1(accountName).slice(0, 30) || "frockbot";
  return `${base}-${accountId.slice(0, 6)}`;
}

// --- Account checks ---------------------------------------------------------

export type CheckIdV1 = "workers-paid" | "r2" | "workers-ai" | "zero-trust";
export type CheckStateV1 = "ok" | "fix" | "unknown";

export interface AccountCheckV1 {
  readonly id: CheckIdV1;
  readonly title: string;
  readonly state: CheckStateV1;
  readonly detail: string;
  /** Where the fix is, when there is one to make. */
  readonly fixUrl?: string;
  readonly fixLabel?: string;
}

export function dashboardUrlV1(accountId: string, path: string): string {
  return `https://dash.cloudflare.com/${accountId}/${path}`;
}

export function workersPaidCheckV1(
  accountId: string,
  paid: boolean | undefined,
): AccountCheckV1 {
  if (paid === true) {
    return {
      id: "workers-paid",
      title: "Workers Paid plan",
      state: "ok",
      detail:
        "Found. FrockBot runs on Workers, Durable Objects and storage it includes.",
    };
  }
  return {
    id: "workers-paid",
    title: "Workers Paid plan",
    state: paid === false ? "fix" : "unknown",
    detail:
      paid === false
        ? "This account is on the free Workers plan. FrockBot needs Workers Paid, which Cloudflare bills at $5 a month."
        : "We couldn’t read this account’s plan. If it’s already on Workers Paid, check again.",
    fixUrl: dashboardUrlV1(accountId, "workers/plans"),
    fixLabel: "Choose Workers Paid",
  };
}

export function r2CheckV1(
  accountId: string,
  enabled: boolean | undefined,
): AccountCheckV1 {
  if (enabled === true) {
    return {
      id: "r2",
      title: "R2 storage",
      state: "ok",
      detail: "On. Your bots’ files and memory are kept here.",
    };
  }
  return {
    id: "r2",
    title: "R2 storage",
    state: enabled === false ? "fix" : "unknown",
    detail:
      enabled === false
        ? "This account hasn’t turned on R2 yet. Turn it on once in Cloudflare; the free allowance covers a personal install."
        : "We couldn’t check R2 on this account. Check again in a moment.",
    fixUrl: dashboardUrlV1(accountId, "r2/overview"),
    fixLabel: "Turn on R2",
  };
}

export function workersAiCheckV1(
  accountId: string,
  jev: JevProbeV1,
): AccountCheckV1 {
  if (jev.state === "ok") {
    return {
      id: "workers-ai",
      title: "Workers AI",
      state: "ok",
      detail:
        "Available. Jev, chat, dictation and images can use it, billed by Cloudflare.",
    };
  }
  return {
    id: "workers-ai",
    title: "Workers AI",
    state: jev.state === "refused" ? "fix" : "unknown",
    detail:
      jev.state === "refused"
        ? `Workers AI won’t run Jev for this account, and every Turn is supervised by it. Cloudflare said: ${jev.reason}`
        : "We couldn’t ask Workers AI for Jev on this account yet. Check again in a moment.",
    fixUrl: dashboardUrlV1(accountId, "ai/workers-ai"),
    fixLabel: "Open Workers AI",
  };
}

export function zeroTrustCheckV1(
  accountId: string,
  enabled: boolean | undefined,
): AccountCheckV1 {
  if (enabled === true) {
    return {
      id: "zero-trust",
      title: "Zero Trust team",
      state: "ok",
      detail: "Found. Cloudflare Access will let only you sign in.",
    };
  }
  return {
    id: "zero-trust",
    title: "Zero Trust team",
    state: enabled === false ? "fix" : "unknown",
    detail:
      enabled === false
        ? "This account hasn’t turned on Zero Trust yet. It’s what lets only you sign in. Turn it on once in Cloudflare and choose the Free plan; Cloudflare asks for a payment method but doesn’t charge for it. We set up the rest."
        : "We couldn’t check Zero Trust on this account. Check again in a moment.",
    fixUrl: `https://one.dash.cloudflare.com/${accountId}/`,
    fixLabel: "Turn on Zero Trust",
  };
}

export function checksPassV1(checks: readonly AccountCheckV1[]): boolean {
  return checks.length > 0 && checks.every((check) => check.state === "ok");
}

// --- The deploy's steps ----------------------------------------------------

export type DeployStepIdV1 =
  "storage" | "release" | "sign-in" | "workers-ai" | "first-check";
export type StepStateV1 = "waiting" | "running" | "done" | "failed";

export interface DeployStepV1 {
  readonly id: DeployStepIdV1;
  readonly state: StepStateV1;
  readonly detail?: string;
}

/**
 * Sign-in comes before the release: the Worker is uploaded with the audience
 * Access issued, and nothing is reachable before Access stands in front of it.
 */
export const DEPLOY_STEPS_V1: readonly DeployStepIdV1[] = [
  "storage",
  "sign-in",
  "release",
  "workers-ai",
  "first-check",
];

export function stepTitleV1(id: DeployStepIdV1, version: string): string {
  switch (id) {
    case "storage":
      return "Storage";
    case "release":
      return `FrockBot release ${version}`;
    case "sign-in":
      return "Sign-in";
    case "workers-ai":
      return "Jev and Workers AI";
    case "first-check":
      return "First check";
  }
}

export function stepWaitingTextV1(id: DeployStepIdV1, email: string): string {
  switch (id) {
    case "storage":
      return "Fetching the release, and creating file storage and the search index.";
    case "release":
      return "Deploying the app, its web client and the Plugin build service.";
    case "sign-in":
      return `Creating the Cloudflare Access application for ${email}.`;
    case "workers-ai":
      return "Connecting Jev to your account’s Workers AI.";
    case "first-check":
      return "Opening your install and checking it answers.";
  }
}

export function stepDoneTextV1(id: DeployStepIdV1, email: string): string {
  switch (id) {
    case "storage":
      return "Fetched the release, and created file storage and the search index.";
    case "release":
      return "Deployed the app, its web client and the Plugin build service.";
    case "sign-in":
      return `Only ${email} can sign in.`;
    case "workers-ai":
      return "Jev runs on your account’s Workers AI.";
    case "first-check":
      return "Your install answered, behind Cloudflare Access.";
  }
}

export function initialStepsV1(): DeployStepV1[] {
  return DEPLOY_STEPS_V1.map((id) => ({ id, state: "waiting" }));
}

/** Percent done, for the bar: finished steps, plus half of a running one. */
export function progressPercentV1(steps: readonly DeployStepV1[]): number {
  if (steps.length === 0) return 0;
  const units = steps.reduce(
    (sum, step) =>
      sum + (step.state === "done" ? 1 : step.state === "running" ? 0.5 : 0),
    0,
  );
  return Math.round((units / steps.length) * 100);
}

// --- Releases and secrets ---------------------------------------------------

/** `a` is newer than `b`, by semantic version. */
export function isNewerVersionV1(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export function randomHexV1(
  bytes = crypto.getRandomValues(new Uint8Array(32)),
): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A credential keyring in the shape the app Worker parses. */
export function credentialKeyringV1(
  now: Date,
  bytes = crypto.getRandomValues(new Uint8Array(32)),
): string {
  const keyId = now.toISOString().slice(0, 7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: keyId,
    keys: { [keyId]: key },
  });
}
