import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import { APPLETS_PACKAGE_ARTIFACT_V1 } from "@frockbot/application-foundation/generated/applets-artifact";
import appletsManifest from "@frockbot/plugin-applets/manifest";

/**
 * `AGENTS.md`, Package composition:
 *
 * > Every Contribution kind is resolved from the manifest and an artifact,
 * > never from a switch over Package identity. A first-party Package that
 * > declares only Bot-authorable Contribution kinds ships as an artifact-backed
 * > member and loads through the same path as a Bot-authored one.
 *
 * ADR 0022 decision 8 makes the Applets Package the standing proof of that
 * sentence, and `docs/plans/applets.md` D6 makes it a hard requirement: "The
 * Applets Package itself must be buildable inside a Bot with identical
 * functionality. It therefore uses only Bot-authorable Contribution kinds."
 *
 * These checks are the cheap half — the manifest's shape and the application's
 * declaration. The expensive half, authoring the same Package through
 * `package_author` and mounting it, is
 * `apps/cloudflare/test/applets-package.workerd.ts`, because it needs a real
 * Worker Loader.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const APPLETS_SPECIFIER = "@frockbot/plugin-applets";

const manifest = decodeFrockBotManifest(appletsManifest);

describe("the Applets Package declares only what a Bot could declare", () => {
  test("its manifest is v5 and its runtime is a Bot isolate", () => {
    expect(manifest.schemaVersion).toBe(5);
    expect(manifest.contributions.runtime).toEqual({
      entry: "./package",
      host: "bot-isolate",
    });
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "applet_list",
      "applet_create",
      "applet_publish",
      "applet_revert",
      "applet_delete",
      "applet_focus",
      "applet_generations",
    ]);
  });

  test("it contributes no backend and no client module", () => {
    // A `backend` Contribution runs in the kernel's own Worker and a module
    // `client` Contribution is compiled into the hosted bundle. Neither is
    // something a Bot can author, so either one would make this the Package a
    // Bot could not have written.
    expect(manifest.contributions.backend).toBeUndefined();
    expect(manifest.contributions.desktop).toBeUndefined();
    expect(manifest.contributions.mobile).toBeUndefined();
    const client = manifest.contributions.client;
    expect(client).toBeDefined();
    expect(client && "kind" in client && client.kind).toBe("iframe");
    expect(client && "entry" in client).toBe(false);
  });

  test("its pages and entry are declarative, on Bot-authorable slots", () => {
    const client = manifest.contributions.client;
    if (!client || !("pages" in client)) throw new Error("no iframe client");
    expect(
      client.pages.map((page) => [page.id, page.mounts.map((m) => m.slot)]),
    ).toEqual([
      ["list", ["frockbot.surface:list"]],
      ["canvas", ["frockbot.right-panel"]],
    ]);
    for (const page of client.pages) {
      expect(page.artifact.mediaType).toBe("text/html");
      expect(page.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(page.artifact.size).toBeGreaterThan(0);
    }
    expect(client.entries).toEqual([
      {
        id: "open",
        slot: "frockbot.sidebar-actions",
        order: 5,
        label: "Applets",
        icon: "applets",
        opens: { kind: "surface", page: "list" },
      },
    ]);
  });

  test("it declares its own durable source root, User-scoped", () => {
    expect(manifest.roots).toEqual([{ id: "source", scope: "user" }]);
  });

  test("the package ships no in-process entry point", () => {
    const packageJson = JSON.parse(
      readFileSync(
        join(repoRoot, "packages/plugin-applets/package.json"),
        "utf8",
      ),
    ) as { exports: Record<string, string> };
    // `./root` is the durable-root addressing the kernel needs to reach the
    // Applet's source, and `./manifest` is the manifest itself. Neither is a
    // Contribution: an `./agent`, `./backend`, or `./client` export would be.
    expect(Object.keys(packageJson.exports).toSorted()).toEqual([
      "./manifest",
      "./package.json",
      "./root",
    ]);
  });
});

describe("the foundation member is artifact-backed", () => {
  test("the application declares an artifact for it, and the plan carries it", async () => {
    const application = JSON.parse(
      readFileSync(
        join(repoRoot, "applications/foundation/frockbot.application.json"),
        "utf8",
      ),
    ) as { packages: Array<{ specifier: string; artifact?: unknown }> };
    const declared = application.packages.find(
      (entry) => entry.specifier === APPLETS_SPECIFIER,
    );
    expect(declared).toBeDefined();
    expect(declared!.artifact).toEqual(APPLETS_PACKAGE_ARTIFACT_V1);

    const plan = await compileFoundationApplication();
    const member = plan.packages.find(
      (pkg) => pkg.specifier === APPLETS_SPECIFIER,
    );
    expect(member?.artifact).toEqual(APPLETS_PACKAGE_ARTIFACT_V1);
    expect(member?.artifact?.mediaType).toBe("application/javascript");
    expect(member?.artifact?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("it is the only artifact-backed member, and it is not in either Contribution table", async () => {
    const plan = await compileFoundationApplication();
    const artifactBacked = plan.packages.filter(
      (pkg) => pkg.artifact !== undefined,
    );
    expect(artifactBacked.map((pkg) => pkg.id)).toEqual(["applets"]);

    // The tables are keyed by contribution specifier, and an artifact-backed
    // member has none: it loads through the isolate host instead. If one ever
    // appeared in a table, the member would mount twice.
    const tables = [
      readFileSync(
        join(repoRoot, "applications/foundation/src/contributions.ts"),
        "utf8",
      ),
      readFileSync(
        join(repoRoot, "applications/foundation/src/client-contributions.ts"),
        "utf8",
      ),
    ];
    for (const table of tables) {
      expect(table).not.toContain(APPLETS_SPECIFIER);
    }
  });
});
