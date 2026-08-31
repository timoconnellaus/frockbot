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
  decodeTemplateCommandV1,
  MAX_TEMPLATE_SHARES_V1,
  templateCommandFingerprintV1,
  type TemplateCommandV1,
  type TemplateExportSummaryV1,
  type TemplateShareListViewV1,
  type TemplateShareReceiptV1,
} from "./shared.js";

export const BOT_TEMPLATE_PACKAGE_ID = "bot-template";

const SHARE_PREFIX = "bot-template:share:";
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
  /** This Bot's own generated sheep. Uploaded avatar bytes never travel (D1). */
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

export interface BotTemplateUserHostV1 {
  storage: UserSettingsStorage;
  settings: UserSettingsBackendContribution;
  bots: TemplateBotReaderV1;
  blobs: TemplateBlobStoreV1;
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
    const user = await this.host.settings.read(userId);
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
    command: Exclude<TemplateCommandV1, { type: "template/stage" }>,
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
        ...(settings.profile.avatar?.kind === "image"
          ? { avatarKind: "image" as const }
          : {}),
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
      hasModelAssignment: settings.model !== undefined,
      assignmentCount: settings.assignments.length,
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
