// Constitutional checks over who may declare the strongest execution hosts.
//
// Constitution — Package composition: "Every Package whose recorded provenance
// is not first-party executes in a Dynamic Worker isolate … First-party
// Packages may run in the kernel's isolate only when reviewed and shipped with
// FrockBot." `trusted-main` is the widest host FrockBot has — the Electron main
// process, outside every sandbox — so a manifest asking for it is asking for
// first-party trust. These are source-graph and synthesis facts, so each rule
// is one named test `docs/architecture-checks.md` can point at.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AUTHOR_PACKAGE_INPUT_SCHEMA_V1,
  authoredManifestV1,
  decodeAuthorPackageInputV1,
} from "@frockbot/plugin-authoring/shared";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

interface ScannedManifest {
  /** Repo-relative path of the `frockbot.json`. */
  path: string;
  manifest: Record<string, unknown>;
}

/** Every Package manifest this tree holds, wherever it sits. */
function scanManifests(): ScannedManifest[] {
  return [...new Bun.Glob("**/frockbot.json").scanSync({ cwd: repoRoot })]
    .filter((path) => !path.includes("node_modules/"))
    .filter((path) => !path.includes("/dist/"))
    .sort()
    .map((path) => ({
      path,
      manifest: JSON.parse(read(path)) as Record<string, unknown>,
    }));
}

function desktopContribution(
  manifest: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const contributions = manifest.contributions;
  if (!contributions || typeof contributions !== "object") return undefined;
  const desktop = (contributions as Record<string, unknown>).desktop;
  if (!desktop || typeof desktop !== "object") return undefined;
  return desktop as Record<string, unknown>;
}

/**
 * The rule, as a function of what was scanned, so the tests below can stage a
 * violation without writing one into this tree: a manifest declaring a
 * `trusted-main` Contribution is a first-party workspace Package under
 * `packages/`, published to the workspace under the `@frockbot/` scope.
 */
function trustedMainOffenders(
  manifests: readonly ScannedManifest[],
  packageName: (manifestPath: string) => string | undefined,
): string[] {
  const offenders: string[] = [];
  for (const { path, manifest } of manifests) {
    if (desktopContribution(manifest)?.execution !== "trusted-main") continue;
    if (!/^packages\/[^/]+\/frockbot\.json$/.test(path)) {
      offenders.push(`${path}: trusted-main outside packages/`);
      continue;
    }
    const name = packageName(path);
    if (!name?.startsWith("@frockbot/")) {
      offenders.push(`${path}: trusted-main in a package named ${name}`);
    }
  }
  return offenders;
}

function workspacePackageName(manifestPath: string): string | undefined {
  const declared = JSON.parse(
    read(join(dirname(manifestPath), "package.json")),
  );
  return typeof declared?.name === "string" ? declared.name : undefined;
}

/** `@frockbot/plugin-fly-sprite` + `./host` → `@frockbot/plugin-fly-sprite/host`. */
function contributionSpecifier(scanned: ScannedManifest): string {
  const entry = String(desktopContribution(scanned.manifest)?.entry ?? "");
  return `${workspacePackageName(scanned.path)}${entry.slice(1)}`;
}

describe("package authority boundaries", () => {
  // Constitution — Package composition: "First-party Packages may run in the
  // kernel's isolate only when reviewed and shipped with FrockBot."
  test("a trusted-main Contribution is declared only by a first-party workspace Package", () => {
    const manifests = scanManifests();
    // The scan really does reach manifests outside `packages/` — nothing here
    // narrows the search to the answer it wants.
    expect(manifests.length).toBeGreaterThan(0);
    expect(
      new Bun.Glob("**/frockbot.json").scanSync({ cwd: repoRoot }).next().done,
    ).toBe(false);
    expect(trustedMainOffenders(manifests, workspacePackageName)).toEqual([]);

    // …and the root workspace really does claim `packages/*`, so "under
    // packages/" means "a workspace member", not merely "in a directory".
    const workspaces = JSON.parse(read("package.json")).workspaces;
    expect(workspaces).toContain("packages/*");
  });

  test("the check refuses a trusted-main manifest that is not a first-party workspace Package", () => {
    const desktop = {
      contributions: {
        desktop: { entry: "./desktop", execution: "trusted-main" },
      },
    };
    const offenders = trustedMainOffenders(
      [
        { path: "apps/cloudflare/frockbot.json", manifest: desktop },
        { path: "vendor/downloaded/frockbot.json", manifest: desktop },
        { path: "packages/third-party/frockbot.json", manifest: desktop },
        {
          path: "packages/plugin-ok/frockbot.json",
          manifest: {
            contributions: {
              desktop: { entry: "./desktop", execution: "sandboxed-renderer" },
            },
          },
        },
      ],
      (path) =>
        path === "packages/third-party/frockbot.json"
          ? "@acme/third-party"
          : "@frockbot/plugin-ok",
    );
    expect(offenders).toEqual([
      "apps/cloudflare/frockbot.json: trusted-main outside packages/",
      "vendor/downloaded/frockbot.json: trusted-main outside packages/",
      "packages/third-party/frockbot.json: trusted-main in a package named @acme/third-party",
    ]);
  });

  // Constitution — Explicit seams: "any other host must be declared in the
  // manifest and remains non-authoritative". The manifest is a declaration, not
  // a grant: Electron main runs a `trusted-main` Contribution only from the map
  // of plugins the shipped application imported statically, so a Package that
  // arrives by any other path — installed, published, Bot-authored — has
  // nowhere to land however its manifest is written.
  test("Electron main loads a trusted-main Contribution only from its statically imported first-party map", () => {
    const source = read("applications/foundation/src/desktop.ts");
    const mapped = [...source.matchAll(/\["(@frockbot\/[^"]+)",\s*\w+\]/g)].map(
      (match) => match[1],
    );
    const imported = new Set(
      [...source.matchAll(/^import\s[^"]*"([^"]+)";$/gm)].map(
        (match) => match[1],
      ),
    );

    const declared = scanManifests()
      .filter(
        (scanned) =>
          desktopContribution(scanned.manifest)?.execution === "trusted-main",
      )
      .map(contributionSpecifier)
      .sort();

    expect(declared.length).toBeGreaterThan(0);
    expect(mapped.slice().sort()).toEqual(declared);
    for (const specifier of declared) {
      expect({ specifier, imported: imported.has(specifier) }).toEqual({
        specifier,
        imported: true,
      });
    }
    // The map is reached only after the plan declares the Package and its
    // manifest says `trusted-main`; an unknown specifier throws rather than
    // loading.
    expect(source).toContain('contribution.execution !== "trusted-main"');
    expect(source).toContain("unknown foundation desktop contribution");
  });

  // Constitution — Self-modification: "Self-modification never widens
  // authority." The manifest of a Bot-authored Package is synthesized, never
  // authored, so a Bot cannot declare a host the kernel did not offer it.
  test("a Bot-authored manifest declares only Bot isolate Contributions, never a desktop or trusted-main one", () => {
    const base = {
      packageId: "bot-tool",
      displayName: "Bot Tool",
      version: "0.0.1",
      tool: { name: "do_it", description: "does it", inputSchema: {} },
    };
    for (const manifest of [
      authoredManifestV1(base),
      authoredManifestV1({
        ...base,
        model: { providerId: "foundation", modelId: "small" },
      }),
    ]) {
      const contributions = manifest.contributions as Record<string, unknown>;
      expect(Object.keys(contributions).sort()).toEqual(
        expect.arrayContaining(["runtime"]),
      );
      for (const [kind, contribution] of Object.entries(contributions)) {
        expect({ kind, host: (contribution as { host: string }).host }).toEqual(
          {
            kind,
            host: "bot-isolate",
          },
        );
      }
      expect(
        Object.keys(contributions).every((kind) =>
          ["runtime", "model"].includes(kind),
        ),
      ).toBe(true);
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain("trusted-main");
      expect(serialized).not.toContain("desktop");
      expect(serialized).not.toContain("sandboxed-renderer");
      expect(manifest.permissions).toEqual([]);
    }
  });

  // …and the tool the model sees offers no field to smuggle one in: the input
  // is exact, so a Contribution, host, or permission key is refused at the seam.
  test("the package_author input carries no Contribution, host, or permission field", () => {
    expect(AUTHOR_PACKAGE_INPUT_SCHEMA_V1.additionalProperties).toBe(false);
    expect(
      Object.keys(AUTHOR_PACKAGE_INPUT_SCHEMA_V1.properties).sort(),
    ).toEqual(["displayName", "model", "packageId", "source", "tool"]);
    const valid = {
      packageId: "bot-tool",
      displayName: "Bot Tool",
      tool: { name: "do_it", description: "does it", inputSchema: {} },
      source: "export const tools = [];\n",
    };
    for (const smuggled of [
      {
        contributions: { desktop: { entry: "./d", execution: "trusted-main" } },
      },
      { host: "trusted-main" },
      { permissions: ["desktop:clipboard:read"] },
    ]) {
      expect(() =>
        decodeAuthorPackageInputV1({ ...valid, ...smuggled }),
      ).toThrow();
    }
  });

  // Constitution — Self-modification: "A Bot may author or change anything
  // above the kernel *for itself*." The behavioural half of this rule is
  // `packages/plugin-shell/src/backend-authoring.test.ts`; this is the
  // source-level pin that the guard exists and is a refusal, not a warning.
  test("the authoring backend refuses a packageId a non-Bot member already holds", () => {
    const source = read("packages/plugin-shell/src/backend-authoring.ts");
    expect(shadowGuardFindings(source)).toEqual([]);
  });

  test("the shadow-guard check refuses a backend that drops or softens the guard", () => {
    const guarded = read("packages/plugin-shell/src/backend-authoring.ts");
    expect(
      shadowGuardFindings(
        guarded.replaceAll('provenance.kind !== "bot"', "false"),
      ),
    ).toEqual([
      "no non-Bot provenance comparison over the Composition members",
    ]);
    expect(
      shadowGuardFindings(
        guarded.replaceAll("member.packageId === packageId &&", "false &&"),
      ),
    ).toEqual(["the comparison is not keyed by packageId"]);
  });
});

/**
 * The shadowing rule as a function of the backend's source: the Composition's
 * members are compared by `packageId`, and a member whose provenance is not the
 * Bot's own is refused.
 */
function shadowGuardFindings(source: string): string[] {
  const findings: string[] = [];
  if (!source.includes('provenance.kind !== "bot"')) {
    findings.push(
      "no non-Bot provenance comparison over the Composition members",
    );
  }
  if (!/member\.packageId === packageId/.test(source)) {
    findings.push("the comparison is not keyed by packageId");
  }
  return findings;
}
