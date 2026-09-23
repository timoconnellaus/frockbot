import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CLIENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_MAX,
  SUPPORTED_PROTOCOL_MIN,
} from "../core/protocol-schemas/compatibility.generated.js";

export interface NativeBuildMetadata {
  schemaVersion: 1;
  /**
   * The version tag `release.yml` builds, without its `v`, from
   * `FROCKBOT_RELEASE`; null for any other build. It is the app's one version:
   * the Profile page shows it and the client's hello names it.
   */
  release: string | null;
  /**
   * What Flutter stamps into the native build: the release's
   * `major.minor.patch`, or `pubspec.yaml`'s placeholder outside a release.
   */
  app: {
    versionName: string;
    buildNumber: number;
    version: string;
  };
  hostedOrigin: string;
  clientProtocol: number;
  compatibility: {
    protocolMin: number;
    protocolMax: number;
  };
}

interface CompatibilitySource {
  clientProtocol: unknown;
  protocolMin: unknown;
  protocolMax: unknown;
}

const defaultCompatibility: CompatibilitySource = {
  clientProtocol: CLIENT_PROTOCOL_VERSION,
  protocolMin: SUPPORTED_PROTOCOL_MIN,
  protocolMax: SUPPORTED_PROTOCOL_MAX,
};

function positiveProtocol(value: unknown, label: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65_535
  ) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return value as number;
}

function compatibilityMetadata(source: CompatibilitySource) {
  const protocolMin = positiveProtocol(source.protocolMin, "protocolMin");
  const protocolMax = positiveProtocol(source.protocolMax, "protocolMax");
  const clientProtocol = positiveProtocol(
    source.clientProtocol,
    "clientProtocol",
  );
  if (protocolMin > protocolMax) {
    throw new Error("protocolMin must not exceed protocolMax.");
  }
  if (clientProtocol < protocolMin || clientProtocol > protocolMax) {
    throw new Error(
      `Client protocol ${clientProtocol} is outside the supported ${protocolMin}..${protocolMax} range.`,
    );
  }
  return { clientProtocol, protocolMin, protocolMax };
}

/** The pattern `ClientHello.nativeVersion` accepts, so a release can always say its name. */
const RELEASE =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]{1,20})?$/u;

function releaseVersion(value: string | undefined) {
  if (value === undefined || value === "") return null;
  const match = RELEASE.exec(value);
  if (!match || value.length > 32) {
    throw new Error(
      `FROCKBOT_RELEASE must be a version tag without its \`v\`, such as 0.7.163 or 0.8.0-rc.1, not ${JSON.stringify(value)}.`,
    );
  }
  return { release: value, versionName: `${match[1]}.${match[2]}.${match[3]}` };
}

function appIdentity(document: unknown) {
  if (!document || typeof document !== "object") {
    throw new Error("apps/native/pubspec.yaml must contain a YAML mapping.");
  }
  const version = (document as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("apps/native/pubspec.yaml must define a string version.");
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+([1-9]\d*)$/u.exec(
    version,
  );
  if (!match) {
    throw new Error(
      "apps/native/pubspec.yaml version must be `<major>.<minor>.<patch>+<positive build>`.",
    );
  }
  const versionName = `${match[1]}.${match[2]}.${match[3]}`;
  const buildNumber = Number(match[4]);
  if (!Number.isSafeInteger(buildNumber)) {
    throw new Error("apps/native/pubspec.yaml build number is too large.");
  }
  return { versionName, buildNumber, version };
}

function hostedOrigin(document: unknown): string {
  const hostnames = (
    document as {
      workers?: { app?: { hostnames?: unknown } };
    } | null
  )?.workers?.app?.hostnames;
  if (
    !Array.isArray(hostnames) ||
    typeof hostnames[0] !== "string" ||
    hostnames[0].length === 0
  ) {
    throw new Error(
      "deployments/hosted.json must name a first application hostname.",
    );
  }
  const origin = new URL(`https://${hostnames[0]}`);
  if (
    origin.hostname !== hostnames[0] ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/"
  ) {
    throw new Error("deployments/hosted.json application hostname is invalid.");
  }
  return origin.origin;
}

export async function readNativeMetadata(
  repositoryRoot = resolve(import.meta.dirname, ".."),
  compatibilitySource: CompatibilitySource = defaultCompatibility,
  releaseSource = process.env.FROCKBOT_RELEASE,
): Promise<NativeBuildMetadata> {
  const [pubspecSource, hostedSource] = await Promise.all([
    readFile(resolve(repositoryRoot, "apps/native/pubspec.yaml"), "utf8"),
    readFile(resolve(repositoryRoot, "deployments/hosted.json"), "utf8"),
  ]);
  const placeholder = appIdentity(Bun.YAML.parse(pubspecSource));
  const compatibility = compatibilityMetadata(compatibilitySource);
  const tagged = releaseVersion(releaseSource);
  const versionName = tagged?.versionName ?? placeholder.versionName;
  return {
    schemaVersion: 1,
    release: tagged?.release ?? null,
    app: {
      versionName,
      buildNumber: placeholder.buildNumber,
      version: `${versionName}+${placeholder.buildNumber}`,
    },
    hostedOrigin: hostedOrigin(JSON.parse(hostedSource) as unknown),
    clientProtocol: compatibility.clientProtocol,
    compatibility: {
      protocolMin: compatibility.protocolMin,
      protocolMax: compatibility.protocolMax,
    },
  };
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  if (rootIndex >= 0 && !process.argv[rootIndex + 1]) {
    throw new Error("--root requires a repository path.");
  }
  const repositoryRoot =
    rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]!) : undefined;
  process.stdout.write(
    `${JSON.stringify(await readNativeMetadata(repositoryRoot), null, 2)}\n`,
  );
}
