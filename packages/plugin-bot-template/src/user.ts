// The User Contribution: staging a template, and owning its shares.
//
// AUTHORITY. "Publication beyond the authoring User is a User action." So the
// split here is exact: staging *builds and stores* a template, always at
// `visibility: "private"`, and choosing `link` or `public` is a separate
// command a User issues from their own surface. A Bot's tool reaches only the
// staging half (`src/agent.ts`), which is why a Bot can describe what it packed
// and can never publish it.
//
// STATE. The blob is content-addressed and immutable, so it lives in object
// storage beside the Catalog's generations and is written through the same
// collision-checking `putImmutable` the Package publisher uses. What cannot
// live there is visibility: an immutable object can never be un-published, and
// a share must be revocable, so the `TemplateShareRecordV1` lives in this
// object's durable storage (D3). `shareId` carries the owning User's public id
// as its first component, so an unauthenticated read routes to exactly one User
// Durable Object with no global index anywhere.
import type {
  BotSettingsViewV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import {
  canonicalBotTemplateDocumentV1,
  parseBotTemplateDocumentV1,
  decodeTemplateShareRecordV1,
  isTemplateShareReadableV1,
  parseTemplateShareIdV1,
  templateContentHashV1,
  templateObjectKeyV1,
  templateShareIdV1,
  TemplateDecodeError,
  type TemplateShareRecordV1,
  type TemplateSheepRecipeV1,
} from "@frockbot/template-core";
import type { Plugin } from "cordis";
import {
  buildBotTemplateV1,
  type TemplateRoutineCandidateV1,
  type TemplateSkillCandidateV1,
} from "./scrub.js";
import {
  importedBotIdV1,
  importedRoutineIdV1,
  planBotTemplateImportV1,
  type TemplateImportPlanV1,
} from "./import.js";
import {
  decodeTemplateCommandV1,
  decodeTemplateImportRecordV1,
  MAX_TEMPLATE_IMPORTS_V1,
  MAX_TEMPLATE_SHARES_V1,
  type TemplateImportListViewV1,
  type TemplateImportRecordV1,
  type TemplateImportStepReceiptV1,
  templateCommandFingerprintV1,
  type TemplateCommandV1,
  type TemplateExportSummaryV1,
  type TemplateShareListViewV1,
  type TemplateShareReceiptV1,
} from "./shared.js";

export const BOT_TEMPLATE_PACKAGE_ID = "bot-template";

const SHARE_PREFIX = "bot-template:share:";
const IMPORT_PREFIX = "bot-template:import:";
const IMPORT_INDEX_KEY = "bot-template:import-index";
const SHARE_INDEX_KEY = "bot-template:share-index";
const RECEIPT_PREFIX = "bot-template:receipt:";

/**
 * The immutable blob store, named structurally so this Package holds no
 * Cloudflare type. The adapter that owns the bucket implements it, and it is
 * the same collision-checked write `apps/cloudflare/src/package-publication.ts`
 * already performs: a key that exists with different bytes is a collision, and
 * one that exists with identical bytes is a no-op.
 */
export interface TemplateBlobStoreV1 {
  putImmutable(key: string, document: string): Promise<void>;
  read(key: string): Promise<string | undefined>;
}

/**
 * What the Bot Durable Object contributes to one export.
 *
 * Three reads, all read-only, all of state the Bot already surfaces to its own
 * User. Nothing here can widen what an export sees: a Bot that could not read
 * its own instruction root cannot export from it either.
 */
export interface TemplateBotReaderV1 {
  readSettings(userId: string, botId: string): Promise<BotSettingsViewV1>;
  /** This Bot's own generated sheep avatar (D1). */
  readSheep(userId: string, botId: string): Promise<TemplateSheepRecipeV1>;
  /** Own-root Skills, bodies included. Managed and plugin Skills never appear. */
  readSkills(
    userId: string,
    botId: string,
  ): Promise<readonly TemplateSkillCandidateV1[]>;
  readRoutines(
    userId: string,
    botId: string,
  ): Promise<readonly TemplateRoutineCandidateV1[]>;
}

/**
 * What an import writes through.
 *
 * Every method is a command the importing User's own surfaces already issue —
 * `bot/create` from the sidebar, `user/install-package` from the Plugins
 * surface, a Skill write and a `routine/create` from the Bot's own settings.
 * There is deliberately nothing here for a Connection or credential: an
 * import cannot create either, because this seam cannot express it.
 */
export interface TemplateImportWriterV1 {
  listBots(): Promise<{ revision: number; bots: { botId: string }[] }>;
  createBot(input: {
    userId: string;
    commandId: string;
    expectedRevision: number;
    botId: string;
    name: string;
    description?: string;
    sheep: TemplateSheepRecipeV1;
  }): Promise<{ status: "applied" | "rejected"; failure?: string }>;
  installPackage(input: {
    userId: string;
    commandId: string;
    packageId: string;
    version: string;
    catalogId: string;
    catalogGeneration: string;
  }): Promise<{ status: string; failure?: string }>;
  /** Written with `writer: { kind: "user" }`: the importing User authored it. */
  writeSkill(input: {
    userId: string;
    botId: string;
    slug: string;
    name: string;
    description: string;
    body: string;
  }): Promise<
    | { status: "written"; generationId: string }
    | { status: "refused"; reason: string }
  >;
  executeRoutineCommand(input: {
    userId: string;
    botId: string;
    command: unknown;
  }): Promise<{ status: string; routineId?: string }>;
}

export interface BotTemplateUserHostV1 {
  storage: UserSettingsStorage;
  settings: UserSettingsBackendContribution;
  bots: TemplateBotReaderV1;
  blobs: TemplateBlobStoreV1;
  /** Absent on a host that does not import; the import commands then refuse. */
  importer?: TemplateImportWriterV1;
  /**
   * One published share, of any User. The adapter routes by the share id's
   * owner half; this Package never learns another User's storage exists.
   */
  readPublishedShare?(
    shareId: string,
  ): Promise<{ hash: string; document: string } | undefined>;
  /** Every `catalogId` the given generation's index holds. */
  readCatalogIds?(generation: string): Promise<readonly string[]>;
  /**
   * The Catalog display name of one entry at an exact generation. Optional: a
   * deployment with no Catalog exports the `packageId` as the display name
   * rather than failing, which is the same thing the install surface does.
   */
  readCatalogDisplayName?(
    generation: string,
    catalogId: string,
  ): Promise<string | undefined>;
  now?(): number;
  /** 32 hex characters. Overridable so a test can pin a share id. */
  randomSecret?(): string;
}

interface StoredTemplateReceipt {
  fingerprint: string;
  receipt: TemplateShareReceiptV1;
}

export class TemplateShareNotFoundError extends Error {
  constructor(readonly shareId: string) {
    super(`template share "${shareId}" was not found`);
    this.name = "TemplateShareNotFoundError";
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultSecret(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Whether the importer will have to bring their own credential for this
 * Connection Type.
 *
 * Read off the Connection's declared authorization rather than off any
 * Package's Connection Type id, so this stays provider-neutral: a Connection
 * whose authorization is anything but `none` — or whose authorization is not
 * recorded at all — is a placeholder in the template.
 */
function isKeyedConnection(authorizationKind: string | undefined): boolean {
  return authorizationKind !== "none";
}

export class BotTemplateUserBackendContribution {
  readonly packageId = BOT_TEMPLATE_PACKAGE_ID;

  private readonly now: () => number;
  private readonly randomSecret: () => string;

  constructor(private readonly host: BotTemplateUserHostV1) {
    this.now = host.now ?? (() => Date.now());
    this.randomSecret = host.randomSecret ?? defaultSecret;
  }

  async listShares(userId: string): Promise<TemplateShareListViewV1> {
    await this.host.settings.read(userId);
    const shares: TemplateShareRecordV1[] = [];
    for (const shareId of await this.shareIndex(this.host.storage)) {
      const share = await this.readShare(this.host.storage, shareId);
      if (share) shares.push(share);
    }
    return { schemaVersion: 1, shares };
  }

  /**
   * One share, for the unauthenticated `GET /templates/v1/:shareId`.
   *
   * The caller has proved nothing, so this answers only what a `link` or
   * `public` share may say. A `private` or revoked share is `undefined` — the
   * same answer a share that never existed gives, so an unauthenticated caller
   * cannot probe for one.
   */
  async resolvePublicShare(
    shareId: string,
  ): Promise<{ share: TemplateShareRecordV1; document: string } | undefined> {
    const share = await this.readShare(this.host.storage, shareId);
    if (!share || !isTemplateShareReadableV1(share)) return undefined;
    const document = await this.host.blobs.read(
      templateObjectKeyV1(share.hash),
    );
    return document === undefined ? undefined : { share, document };
  }

  async execute(
    userId: string,
    input: unknown,
  ): Promise<TemplateShareReceiptV1> {
    const command = decodeTemplateCommandV1(input);
    const fingerprint = templateCommandFingerprintV1(command);
    const stored = await this.readReceipt(command.commandId);
    if (stored) {
      if (stored.fingerprint !== fingerprint) {
        throw new TemplateDecodeError(
          `template command "${command.commandId}" was reused for a different command`,
        );
      }
      // A replay after eviction is a read: the durable receipt is the answer,
      // so nothing is packed, stored, or published a second time.
      return stored.receipt;
    }
    if (
      command.type === "template/plan-import" ||
      command.type === "template/apply-import"
    ) {
      throw new TemplateDecodeError(
        "an import command is issued through executeImport, not execute",
      );
    }
    const receipt =
      command.type === "template/stage"
        ? await this.stage(userId, command)
        : await this.applyShareChange(userId, command);
    await this.host.storage.put(`${RECEIPT_PREFIX}${command.commandId}`, {
      fingerprint,
      receipt,
    } satisfies StoredTemplateReceipt);
    return receipt;
  }

  private async stage(
    userId: string,
    command: Extract<TemplateCommandV1, { type: "template/stage" }>,
  ): Promise<TemplateShareReceiptV1> {
    // `readConfiguration` rather than `read`: the pinned generation is
    // projected onto the view, and it is what the export records as its
    // provenance and what an importer diffs against.
    const user = await this.host.settings.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    const built = await this.build(userId, command.botId, user);
    const document = canonicalBotTemplateDocumentV1(built.template);
    const hash = await templateContentHashV1(document);
    // The blob is content-addressed, so an identical re-export lands on the
    // same key and the collision check makes the write a no-op.
    await this.host.blobs.putImmutable(templateObjectKeyV1(hash), document);

    const share: TemplateShareRecordV1 = decodeTemplateShareRecordV1({
      schemaVersion: 1,
      shareId: templateShareIdV1(userId, this.randomSecret()),
      hash,
      botId: command.botId,
      // A stage is never a publication. The User chooses `link` or `public`.
      visibility: "private",
      createdAt: new Date(this.now()).toISOString(),
    });
    await this.host.storage.transaction(async (transaction) => {
      const index = await this.shareIndex(transaction);
      if (index.length >= MAX_TEMPLATE_SHARES_V1) {
        throw new TemplateDecodeError(
          `this User already holds ${MAX_TEMPLATE_SHARES_V1} template shares`,
        );
      }
      await transaction.put({
        [`${SHARE_PREFIX}${share.shareId}`]: share,
        [SHARE_INDEX_KEY]: [...index, share.shareId],
      });
    });
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      share,
      summary: built.summary,
    };
  }

  private async applyShareChange(
    userId: string,
    command: Extract<
      TemplateCommandV1,
      { type: "template/set-visibility" } | { type: "template/revoke" }
    >,
  ): Promise<TemplateShareReceiptV1> {
    await this.host.settings.read(userId);
    // The share id names its owner, and only that owner's Durable Object holds
    // the record, so a share of another User is simply not here.
    if (parseTemplateShareIdV1(command.shareId).ownerId !== userId) {
      throw new TemplateShareNotFoundError(command.shareId);
    }
    const share = await this.host.storage.transaction(async (transaction) => {
      const current = await this.readShare(transaction, command.shareId);
      if (!current) throw new TemplateShareNotFoundError(command.shareId);
      const next: TemplateShareRecordV1 =
        command.type === "template/revoke"
          ? {
              ...current,
              // Revocation is idempotent: a share already revoked keeps the
              // moment it was revoked at, so a retry does not move it.
              revokedAt:
                current.revokedAt ?? new Date(this.now()).toISOString(),
            }
          : { ...current, visibility: command.visibility };
      await transaction.put(`${SHARE_PREFIX}${command.shareId}`, next);
      return next;
    });
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      share,
    };
  }

  /** Read what the Bot is, and hand it to the pure scrub. Reads only. */
  private async build(
    userId: string,
    botId: string,
    user: UserSettingsViewV1,
  ): Promise<{
    template: ReturnType<typeof buildBotTemplateV1>["template"];
    summary: TemplateExportSummaryV1;
  }> {
    const settings = await this.host.bots.readSettings(userId, botId);
    const [sheep, skills, routines] = await Promise.all([
      this.host.bots.readSheep(userId, botId),
      this.host.bots.readSkills(userId, botId),
      this.host.bots.readRoutines(userId, botId),
    ]);
    const packages = await Promise.all(
      user.packages.map(async (installation) => ({
        packageId: installation.packageId,
        version: installation.version,
        state: installation.state,
        ...(installation.catalogId === undefined
          ? {}
          : { catalogId: installation.catalogId }),
        ...(installation.catalogGeneration === undefined
          ? {}
          : { catalogGeneration: installation.catalogGeneration }),
        ...(installation.provenance === undefined
          ? {}
          : { provenance: installation.provenance }),
        ...(installation.values === undefined
          ? {}
          : { values: installation.values }),
        displayName: await this.displayName(installation),
      })),
    );
    return buildBotTemplateV1({
      botId,
      profile: {
        name: settings.profile.name,
        ...(settings.profile.title === undefined
          ? {}
          : { title: settings.profile.title }),
        ...(settings.profile.description === undefined
          ? {}
          : { description: settings.profile.description }),
      },
      sheep,
      skills,
      routines,
      packages,
      connections: user.connections.map((connection) => ({
        packageId: connection.packageId,
        connectionTypeId: connection.connectionTypeId,
        displayName: connection.displayName,
        state: connection.state,
        keyed: isKeyedConnection(connection.authorization?.kind),
        ...(connection.settings === undefined
          ? {}
          : {
              settings: {
                url: connection.settings.url,
                transport: connection.settings.transport,
              },
            }),
      })),
      ...(user.catalogGeneration === undefined
        ? {}
        : { sourceCatalogGeneration: user.catalogGeneration }),
    });
  }

  private async displayName(installation: {
    packageId: string;
    catalogId?: string;
    catalogGeneration?: string;
  }): Promise<string> {
    if (
      !this.host.readCatalogDisplayName ||
      !installation.catalogId ||
      !installation.catalogGeneration
    ) {
      return installation.packageId;
    }
    try {
      return (
        (await this.host.readCatalogDisplayName(
          installation.catalogGeneration,
          installation.catalogId,
        )) ?? installation.packageId
      );
    } catch {
      // A Catalog that cannot be read costs the export a prettier name and
      // nothing else; it never costs it the entry.
      return installation.packageId;
    }
  }

  // -------------------------------------------------------------------------
  // Import.
  //
  // Two commands and one durable record. `template/plan-import` reads — it
  // fetches the blob, decodes it strictly, diffs it against this User's own
  // pinned generation and writes a `planned` record; it applies nothing.
  // `template/apply-import` walks that record's steps, marking each one done as
  // it goes, so an eviction mid-apply resumes at the first step that is not.
  //
  // Every step is idempotent on its own terms rather than on this record alone:
  // the Bot id is derived so a replay collides with the Bot it already made,
  // each install carries a derived `commandId` the Settings Contribution
  // receipts, a Skill write is a content write to a derived path, and a Routine
  // carries a derived `routineId` its store refuses to create twice. The record
  // is the *cursor*, not the fence.
  // -------------------------------------------------------------------------

  async listImports(userId: string): Promise<TemplateImportListViewV1> {
    await this.host.settings.read(userId);
    const imports: TemplateImportRecordV1[] = [];
    for (const importId of await this.importIndex()) {
      const record = await this.readImport(importId);
      if (record) imports.push(record);
    }
    return { schemaVersion: 1, imports };
  }

  async executeImport(
    userId: string,
    input: unknown,
  ): Promise<TemplateImportRecordV1> {
    const command = decodeTemplateCommandV1(input);
    if (command.type === "template/plan-import") {
      return this.planImport(userId, command.commandId, command.shareId);
    }
    if (command.type === "template/apply-import") {
      return this.applyImport(userId, command.importId);
    }
    throw new TemplateDecodeError(
      "only an import command is issued through executeImport",
    );
  }

  /** Read-only. Nothing an import would do happens here. */
  private async planImport(
    userId: string,
    importId: string,
    shareId: string,
  ): Promise<TemplateImportRecordV1> {
    const existing = await this.readImport(importId);
    // A replanned import is a read: the plan is what the User reviewed, and
    // re-deriving it under a moved Catalog would change what they confirmed.
    if (existing) return existing;
    if (!this.host.readPublishedShare) {
      throw new TemplateDecodeError("this deployment cannot import templates");
    }
    const found = await this.host.readPublishedShare(shareId);
    if (!found) throw new TemplateShareNotFoundError(shareId);
    const template = parseBotTemplateDocumentV1(found.document);
    const user = await this.host.settings.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    const generation = user.catalogGeneration;
    const availableCatalogIds =
      generation && this.host.readCatalogIds
        ? await this.host.readCatalogIds(generation)
        : [];
    const plan = planBotTemplateImportV1({
      importId,
      shareId,
      hash: found.hash,
      botId: await importedBotIdV1(userId, importId, template.profile.name),
      template,
      installedPackages: user.packages.map((installation) => ({
        packageId: installation.packageId,
        state: installation.state,
        ...(installation.catalogId === undefined
          ? {}
          : { catalogId: installation.catalogId }),
      })),
      ...(generation === undefined ? {} : { catalogGeneration: generation }),
      availableCatalogIds,
    });
    const now = new Date(this.now()).toISOString();
    const record: TemplateImportRecordV1 = decodeTemplateImportRecordV1({
      schemaVersion: 1,
      importId,
      shareId,
      hash: found.hash,
      botId: plan.botId,
      status: "planned",
      botName: plan.profile.name,
      packages: plan.packages,
      connections: plan.connections,
      skills: plan.skills.map((skill) => skill.slug),
      routines: plan.routines.map((routine) => ({
        slug: routine.slug,
        disabled: routine.triggerKind === "webhook",
      })),
      steps: plan.steps.map((step) => ({
        key: step.key,
        kind: step.kind,
        status: "pending",
        ...(step.subject === undefined ? {} : { subject: step.subject }),
      })),
      createdAt: now,
      updatedAt: now,
      ...(plan.catalogGeneration === undefined
        ? {}
        : { catalogGeneration: plan.catalogGeneration }),
    });
    await this.putImport(record, plan);
    return record;
  }

  /**
   * Walk the plan. Resumable, and safe to call again after any failure.
   *
   * A failed step stops the walk and leaves a visible, repairable record: the
   * Bot exists with whatever applied, the card is re-openable, and re-issuing
   * the command retries from exactly that step.
   */
  async applyImport(
    userId: string,
    importId: string,
  ): Promise<TemplateImportRecordV1> {
    await this.host.settings.read(userId);
    const writer = this.host.importer;
    if (!writer) {
      throw new TemplateDecodeError("this deployment cannot import templates");
    }
    let record = await this.readImport(importId);
    if (!record) throw new TemplateShareNotFoundError(importId);
    if (record.status === "applied") return record;
    const plan = await this.readImportPlan(importId);
    if (!plan) throw new TemplateShareNotFoundError(importId);

    record = await this.patchImport(importId, (current) => ({
      ...current,
      status: "applying",
      ...(current.failure === undefined ? {} : { failure: undefined }),
    }));

    for (const step of record.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      let outcome: { detail?: string; skipped?: boolean };
      try {
        outcome = await this.runImportStep(userId, plan, step, writer);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        return this.patchImport(importId, (current) => ({
          ...current,
          status: "failed",
          failure: `${step.key}: ${failure}`,
          steps: current.steps.map((entry) =>
            entry.key === step.key
              ? { ...entry, status: "failed" as const, failure }
              : entry,
          ),
        }));
      }
      record = await this.patchImport(importId, (current) => ({
        ...current,
        steps: current.steps.map((entry) =>
          entry.key === step.key
            ? {
                ...entry,
                status: outcome.skipped
                  ? ("skipped" as const)
                  : ("done" as const),
                ...(outcome.detail === undefined
                  ? {}
                  : { detail: outcome.detail }),
              }
            : entry,
        ),
      }));
    }
    return this.patchImport(importId, (current) => ({
      ...current,
      status: "applied",
    }));
  }

  /** Every import left mid-apply, resumed. Called from the User DO's alarm. */
  async recoverImports(userId: string): Promise<void> {
    if (!this.host.importer) return;
    for (const importId of await this.importIndex()) {
      const record = await this.readImport(importId);
      if (record?.status !== "applying") continue;
      try {
        await this.applyImport(userId, importId);
      } catch {
        // The record already carries the failure; a recovery pass that cannot
        // finish must not stop the other owners of this alarm from running.
      }
    }
  }

  private async runImportStep(
    userId: string,
    plan: TemplateImportPlanV1,
    step: TemplateImportStepReceiptV1,
    writer: TemplateImportWriterV1,
  ): Promise<{ detail?: string; skipped?: boolean }> {
    switch (step.kind) {
      case "bot/create": {
        const directory = await writer.listBots();
        // The derived id is the fence. A replay finds the Bot it already made.
        if (directory.bots.some((bot) => bot.botId === plan.botId)) {
          return { detail: plan.botId };
        }
        const receipt = await writer.createBot({
          userId,
          commandId: `import-bot-${plan.importId}`,
          expectedRevision: directory.revision,
          botId: plan.botId,
          name: plan.profile.name,
          ...(plan.profile.description === undefined
            ? {}
            : { description: plan.profile.description }),
          sheep: plan.sheep,
        });
        if (receipt.status === "rejected") {
          throw new Error(receipt.failure ?? "the Flock refused bot/create");
        }
        return { detail: plan.botId };
      }
      case "user/install-package": {
        const entry = plan.packages.find(
          (candidate) => candidate.catalogId === step.subject,
        );
        if (!entry || entry.status !== "will-install") return { skipped: true };
        if (!plan.catalogGeneration) return { skipped: true };
        const receipt = await writer.installPackage({
          userId,
          // Derived, so the Settings Contribution's own receipt makes a replay
          // a read rather than a second install.
          commandId: `import-install-${plan.importId}-${entry.catalogId}`,
          packageId: entry.packageId,
          version: entry.version,
          catalogId: entry.catalogId,
          catalogGeneration: plan.catalogGeneration,
        });
        if (receipt.status === "rejected") {
          throw new Error(receipt.failure ?? "the install was rejected");
        }
        return { detail: entry.catalogId };
      }
      case "skill/write": {
        const skill = plan.skills.find(
          (candidate) => candidate.slug === step.subject,
        );
        if (!skill) return { skipped: true };
        const outcome = await writer.writeSkill({
          userId,
          botId: plan.botId,
          slug: skill.slug,
          name: skill.name,
          description: skill.description ?? skill.name,
          body: skill.body,
        });
        if (outcome.status === "refused") throw new Error(outcome.reason);
        return { detail: outcome.generationId };
      }
      case "routine/create": {
        const routine = plan.routines.find(
          (candidate) => candidate.slug === step.subject,
        );
        if (!routine) return { skipped: true };
        const routineId = importedRoutineIdV1(plan.importId, routine.slug);
        const receipt = await writer.executeRoutineCommand({
          userId,
          botId: plan.botId,
          command: {
            schemaVersion: 1,
            type: "routine/create",
            commandId: `import-routine-${routineId}`,
            botId: plan.botId,
            routineId,
            name: routine.name,
            prompt: routine.prompt,
            ...(routine.schedule === undefined
              ? {}
              : { schedule: routine.schedule }),
            ...(routine.triggerKind === "webhook"
              ? { trigger: { kind: "webhook" } }
              : {}),
            timezone: routine.timezone,
          },
        });
        return { detail: receipt.routineId ?? routineId };
      }
      case "routine/disable": {
        const routineId = importedRoutineIdV1(
          plan.importId,
          step.subject ?? "",
        );
        // An imported webhook Routine has no key in this deployment, and a
        // stranger's trigger firing unannounced would be a surprise rather
        // than a feature. It arrives paused, for its User to turn on.
        await writer.executeRoutineCommand({
          userId,
          botId: plan.botId,
          command: {
            schemaVersion: 1,
            type: "routine/pause",
            commandId: `import-routine-pause-${routineId}`,
            botId: plan.botId,
            routineId,
          },
        });
        return { detail: routineId };
      }
    }
  }

  private async putImport(
    record: TemplateImportRecordV1,
    plan: TemplateImportPlanV1,
  ): Promise<void> {
    await this.host.storage.transaction(async (transaction) => {
      const index = await this.importIndex(transaction);
      if (index.length >= MAX_TEMPLATE_IMPORTS_V1) {
        throw new TemplateDecodeError(
          `this User already holds ${MAX_TEMPLATE_IMPORTS_V1} template imports`,
        );
      }
      await transaction.put({
        [`${IMPORT_PREFIX}${record.importId}`]: record,
        [`${IMPORT_PREFIX}plan:${record.importId}`]: plan,
        [IMPORT_INDEX_KEY]: [...index, record.importId],
      });
    });
  }

  private async patchImport(
    importId: string,
    patch: (current: TemplateImportRecordV1) => TemplateImportRecordV1,
  ): Promise<TemplateImportRecordV1> {
    return this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(
        `${IMPORT_PREFIX}${importId}`,
      );
      if (stored === undefined) throw new TemplateShareNotFoundError(importId);
      const next = decodeTemplateImportRecordV1({
        ...patch(decodeTemplateImportRecordV1(stored)),
        updatedAt: new Date(this.now()).toISOString(),
      });
      await transaction.put(`${IMPORT_PREFIX}${importId}`, next);
      return next;
    });
  }

  private async readImport(
    importId: string,
  ): Promise<TemplateImportRecordV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${IMPORT_PREFIX}${importId}`,
    );
    return stored === undefined
      ? undefined
      : decodeTemplateImportRecordV1(stored);
  }

  private async readImportPlan(
    importId: string,
  ): Promise<TemplateImportPlanV1 | undefined> {
    return this.host.storage.get<TemplateImportPlanV1>(
      `${IMPORT_PREFIX}plan:${importId}`,
    );
  }

  private async importIndex(
    storage: UserSettingsTransaction = this.host.storage,
  ): Promise<string[]> {
    const stored = await storage.get<unknown>(IMPORT_INDEX_KEY);
    return Array.isArray(stored)
      ? stored
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_TEMPLATE_IMPORTS_V1)
      : [];
  }

  private async shareIndex(
    storage: UserSettingsTransaction,
  ): Promise<string[]> {
    const stored = await storage.get<unknown>(SHARE_INDEX_KEY);
    return Array.isArray(stored)
      ? stored
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_TEMPLATE_SHARES_V1)
      : [];
  }

  private async readShare(
    storage: UserSettingsTransaction,
    shareId: string,
  ): Promise<TemplateShareRecordV1 | undefined> {
    const stored = await storage.get<unknown>(`${SHARE_PREFIX}${shareId}`);
    if (stored === undefined) return undefined;
    return decodeTemplateShareRecordV1(stored);
  }

  private async readReceipt(
    commandId: string,
  ): Promise<StoredTemplateReceipt | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${RECEIPT_PREFIX}${commandId}`,
    );
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return undefined;
    }
    const value = stored as Record<string, unknown>;
    if (typeof value.fingerprint !== "string") return undefined;
    return {
      fingerprint: value.fingerprint,
      receipt: value.receipt as TemplateShareReceiptV1,
    };
  }
}

export function createBotTemplateUserBackendContribution(
  host: BotTemplateUserHostV1,
): BotTemplateUserBackendContribution {
  return new BotTemplateUserBackendContribution(host);
}

export function createBotTemplateUserBackendPlugin(
  host: BotTemplateUserHostV1,
  lifecycle: { mount(value: BotTemplateUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createBotTemplateUserBackendContribution(host));
}
