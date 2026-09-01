/**
 * The Bot Template seam.
 *
 * A Bot Template is a *recipe, not a backup*: an immutable, content-addressed
 * JSON document describing how to build a Bot like this one, in prose and
 * references only. It never carries state, secrets, credentials, Connections,
 * Memory, transcripts, or bytes.
 *
 * The register (`docs/research/grokbot-computer.md` lines 313–330) fixes the
 * shape GrokBot's `create_bot_share_json` packs and the contracts that go with
 * it: the host never falls back to the owner's live files, scrubbing lives only
 * in the pack arguments, managed and plugin Skills are always excluded, and the
 * payload is bounded at ~100 000 characters. Three FrockBot readings depart
 * from it, each recorded in `docs/adr/0015-bot-template-recipe.md`: a
 * marketplace `pluginId` becomes `packageId` + `catalogId` + `version`,
 * publication is a User act rather than a tool argument, and Memory is not
 * exported at all.
 *
 * This module mirrors `catalog-core`'s role exactly: DTOs, strict exact-key
 * decoders, bounds, the object-key layout and the content hash — no I/O, no
 * runtime dependency, importable by the gateway, the User Durable Object, the
 * Bot's runtime Contribution and the browser alike.
 */

export class TemplateDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemplateDecodeError";
  }
}

/**
 * Bounds every template document. `MAX_TEMPLATE_BYTES_V1` is the register's own
 * ~100 000-character payload bound (line 329); the rest mirror `MAX_CATALOG_*`
 * so a hostile blob cannot exhaust a Durable Object that decodes one.
 */
export const MAX_TEMPLATE_BYTES_V1 = 100_000;
export const MAX_TEMPLATE_SKILLS_V1 = 200;
export const MAX_TEMPLATE_ROUTINES_V1 = 100;
export const MAX_TEMPLATE_PACKAGES_V1 = 32;
export const MAX_TEMPLATE_SERVERS_V1 = 16;
export const MAX_TEMPLATE_SKILL_BODY_BYTES_V1 = 16_384;
export const MAX_TEMPLATE_ROUTINE_PROMPT_BYTES_V1 = 8_000;

/**
 * The generated sheep avatar, structurally.
 *
 * Declared here rather than imported from `plugin-flock` so this package keeps
 * its promise of no runtime dependency: a template travels between deployments,
 * and its decoder must not need a Package mounted to read it. The layer ids are
 * opaque strings on this side of the seam — the Flock's own decoder is the one
 * that knows which ids exist, and it is what an importing deployment runs
 * before it materializes a Bot.
 */
export interface TemplateSheepRecipeV1 {
  schemaVersion: 1;
  background: string;
  upper: string;
  middle: string;
  lower: string;
}

/** The profile a template carries. Its avatar is the Bot's sheep recipe (D1). */
export interface TemplateProfileV1 {
  name: string;
  title?: string;
  description?: string;
  avatar: { kind: "sheep"; recipe: TemplateSheepRecipeV1 };
}

/** One own-root Skill, body verbatim. Managed and plugin Skills never appear. */
export interface TemplateSkillV1 {
  slug: string;
  name: string;
  description?: string;
  body: string;
}

/**
 * One Routine. A webhook Routine carries `triggerKind: "webhook"` and nothing
 * else about its trigger: `plugin-routines/src/shared.ts` — "A `RoutineViewV1`
 * never carries a webhook key or its digest" — and a template is weaker still,
 * because it crosses to another User entirely.
 */
export interface TemplateRoutineV1 {
  slug: string;
  name: string;
  prompt: string;
  schedule?: string;
  timezone: string;
  triggerKind?: "webhook" | "cron";
}

/**
 * One installable Package, by Catalog identity. There is no numeric
 * marketplace id in FrockBot, and an install must validate against an
 * immutable generation, so a template names what the importer looks up in
 * *their own* pinned generation rather than a version this one happened to see.
 */
export interface TemplatePackageV1 {
  packageId: string;
  catalogId: string;
  version: string;
  displayName: string;
}

export type TemplateMcpServerV1 =
  | {
      kind: "public";
      name: string;
      url: string;
      transport: "streamable-http" | "sse";
    }
  | {
      kind: "needs-connection";
      name: string;
      connectionTypeId: string;
      hint?: string;
    };

/**
 * One template document.
 *
 * There is deliberately no `createdAt` here. A template is content-addressed,
 * so the bytes must be a pure function of the Bot they describe: a timestamp
 * would make every re-export a different hash and a different object, and
 * "re-exporting an unchanged Bot changes nothing" is exactly the property
 * content addressing is for. When a share was packed is share metadata, and it
 * lives on {@link TemplateShareRecordV1}, which is mutable state anyway.
 */
export interface BotTemplateV1 {
  schemaVersion: 1;
  profile: TemplateProfileV1;
  skills: TemplateSkillV1[];
  routines: TemplateRoutineV1[];
  packages: TemplatePackageV1[];
  mcpServers: TemplateMcpServerV1[];
  /** The Catalog generation the *source* User was pinned to, for provenance. */
  sourceCatalogGeneration?: string;
}

/**
 * A share of one template blob.
 *
 * Visibility is *not* in the blob. The blob is content-addressed and immutable,
 * so it can never be un-published; a share is revocable state, and it lives in
 * the User Durable Object that owns it (D3). `shareId` carries the owning
 * User's public id as its first component, so an unauthenticated `GET` routes
 * to exactly one User Durable Object without a lookup table anywhere.
 */
export type TemplateVisibilityV1 = "private" | "link" | "public";

export const TEMPLATE_VISIBILITIES_V1: readonly TemplateVisibilityV1[] = [
  "private",
  "link",
  "public",
];

export interface TemplateShareRecordV1 {
  schemaVersion: 1;
  shareId: string;
  hash: string;
  botId: string;
  visibility: TemplateVisibilityV1;
  createdAt: string;
  revokedAt?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GENERATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONNECTION_TYPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHARE_SECRET_PATTERN = /^[0-9a-f]{32}$/;
const SHARE_OWNER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TemplateDecodeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TemplateDecodeError(
        `${label} has unknown field "${String(key)}"`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TemplateDecodeError(`${label} is missing "${key}"`);
    }
  }
  return value;
}

function text(
  value: unknown,
  label: string,
  maxLength: number,
  { allowEmpty = false } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : text(value, label, maxLength);
}

function pattern(
  value: unknown,
  label: string,
  expression: RegExp,
  maxLength = 128,
): string {
  const candidate = text(value, label, maxLength);
  if (!expression.test(candidate)) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return candidate;
}

function boundedArray(
  value: unknown,
  label: string,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new TemplateDecodeError(`${label} must be a bounded array`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const candidate = text(value, label, 64);
  if (!Number.isFinite(new Date(candidate).getTime())) {
    throw new TemplateDecodeError(`${label} is invalid`);
  }
  return candidate;
}

/**
 * A template's MCP server URL is rendered by a browser and may be handed to a
 * fetch on import, so only an absolute `https:` URL is admitted here — the same
 * rule `catalog-core` holds a logo to, for the same reason.
 */
function httpsUrl(value: unknown, label: string): string {
  const candidate = text(value, label, 2_048);
  const url = URL.parse(candidate);
  if (!url || url.protocol !== "https:" || url.username || url.password) {
    throw new TemplateDecodeError(`${label} must be an https URL`);
  }
  return candidate;
}

function withOptional<T extends Record<string, unknown>>(
  base: T,
  optional: Record<string, string | undefined>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

export function decodeTemplateContentHashV1(
  value: unknown,
  label = "template hash",
): string {
  return pattern(value, label, HASH_PATTERN, 64);
}

export function decodeTemplateSheepRecipeV1(
  value: unknown,
): TemplateSheepRecipeV1 {
  const recipe = exactRecord(value, "template sheep", [
    "schemaVersion",
    "background",
    "upper",
    "middle",
    "lower",
  ]);
  if (recipe.schemaVersion !== 1) {
    throw new TemplateDecodeError("template sheep schema version is invalid");
  }
  return {
    schemaVersion: 1,
    background: text(recipe.background, "template sheep background", 128),
    upper: text(recipe.upper, "template sheep upper", 128),
    middle: text(recipe.middle, "template sheep middle", 128),
    lower: text(recipe.lower, "template sheep lower", 128),
  };
}

function decodeTemplateProfileV1(value: unknown): TemplateProfileV1 {
  const profile = exactRecord(
    value,
    "template profile",
    ["name", "avatar"],
    ["title", "description"],
  );
  const avatar = exactRecord(profile.avatar, "template avatar", [
    "kind",
    "recipe",
  ]);
  if (avatar.kind !== "sheep") {
    // Sheep recipes are the only Bot avatar. A template claiming another kind
    // is refused rather than silently downgraded.
    throw new TemplateDecodeError("template avatar must be a sheep recipe");
  }
  return withOptional(
    {
      name: text(profile.name, "template profile name", 100),
      avatar: {
        kind: "sheep" as const,
        recipe: decodeTemplateSheepRecipeV1(avatar.recipe),
      },
    },
    {
      title: optionalText(profile.title, "template profile title", 120),
      description: optionalText(
        profile.description,
        "template profile description",
        10_000,
      ),
    },
  );
}

function decodeTemplateSkillV1(value: unknown): TemplateSkillV1 {
  const skill = exactRecord(
    value,
    "template skill",
    ["slug", "name", "body"],
    ["description"],
  );
  return withOptional(
    {
      slug: pattern(skill.slug, "template skill slug", SLUG_PATTERN),
      name: text(skill.name, "template skill name", 100),
      body: text(
        skill.body,
        "template skill body",
        MAX_TEMPLATE_SKILL_BODY_BYTES_V1,
      ),
    },
    {
      description: optionalText(
        skill.description,
        "template skill description",
        2_000,
      ),
    },
  );
}

function decodeTemplateRoutineV1(value: unknown): TemplateRoutineV1 {
  const routine = exactRecord(
    value,
    "template routine",
    ["slug", "name", "prompt", "timezone"],
    ["schedule", "triggerKind"],
  );
  if (
    routine.triggerKind !== undefined &&
    routine.triggerKind !== "webhook" &&
    routine.triggerKind !== "cron"
  ) {
    throw new TemplateDecodeError("template routine triggerKind is invalid");
  }
  const schedule = optionalText(
    routine.schedule,
    "template routine schedule",
    256,
  );
  if (routine.triggerKind === "webhook" && schedule !== undefined) {
    throw new TemplateDecodeError(
      "a webhook template routine carries no schedule",
    );
  }
  return {
    slug: pattern(routine.slug, "template routine slug", SLUG_PATTERN),
    name: text(routine.name, "template routine name", 100),
    prompt: text(
      routine.prompt,
      "template routine prompt",
      MAX_TEMPLATE_ROUTINE_PROMPT_BYTES_V1,
    ),
    ...(schedule === undefined ? {} : { schedule }),
    timezone: text(routine.timezone, "template routine timezone", 64),
    ...(routine.triggerKind === undefined
      ? {}
      : { triggerKind: routine.triggerKind }),
  };
}

function decodeTemplatePackageV1(value: unknown): TemplatePackageV1 {
  const entry = exactRecord(value, "template package", [
    "packageId",
    "catalogId",
    "version",
    "displayName",
  ]);
  return {
    packageId: pattern(
      entry.packageId,
      "template packageId",
      PACKAGE_ID_PATTERN,
      64,
    ),
    catalogId: pattern(
      entry.catalogId,
      "template catalogId",
      CATALOG_ID_PATTERN,
      64,
    ),
    version: text(entry.version, "template package version", 100),
    displayName: text(entry.displayName, "template package displayName", 100),
  };
}

function decodeTemplateMcpServerV1(value: unknown): TemplateMcpServerV1 {
  if (!isRecord(value)) {
    throw new TemplateDecodeError("template MCP server must be an object");
  }
  if (value.kind === "public") {
    const server = exactRecord(value, "template MCP server", [
      "kind",
      "name",
      "url",
      "transport",
    ]);
    if (server.transport !== "streamable-http" && server.transport !== "sse") {
      throw new TemplateDecodeError("template MCP transport is invalid");
    }
    return {
      kind: "public",
      name: text(server.name, "template MCP server name", 100),
      url: httpsUrl(server.url, "template MCP server url"),
      transport: server.transport,
    };
  }
  if (value.kind === "needs-connection") {
    const server = exactRecord(
      value,
      "template MCP placeholder",
      ["kind", "name", "connectionTypeId"],
      ["hint"],
    );
    return withOptional(
      {
        kind: "needs-connection" as const,
        name: text(server.name, "template MCP placeholder name", 100),
        connectionTypeId: pattern(
          server.connectionTypeId,
          "template MCP connectionTypeId",
          CONNECTION_TYPE_PATTERN,
          64,
        ),
      },
      { hint: optionalText(server.hint, "template MCP hint", 500) },
    );
  }
  throw new TemplateDecodeError("template MCP server kind is invalid");
}

export function decodeBotTemplateV1(input: unknown): BotTemplateV1 {
  const value = exactRecord(
    input,
    "bot template",
    [
      "schemaVersion",
      "profile",
      "skills",
      "routines",
      "packages",
      "mcpServers",
    ],
    ["sourceCatalogGeneration"],
  );
  if (value.schemaVersion !== 1) {
    throw new TemplateDecodeError("bot template schema version is unsupported");
  }
  const skills = boundedArray(
    value.skills,
    "template skills",
    MAX_TEMPLATE_SKILLS_V1,
  ).map(decodeTemplateSkillV1);
  if (new Set(skills.map((skill) => skill.slug)).size !== skills.length) {
    throw new TemplateDecodeError("bot template repeats a skill slug");
  }
  const routines = boundedArray(
    value.routines,
    "template routines",
    MAX_TEMPLATE_ROUTINES_V1,
  ).map(decodeTemplateRoutineV1);
  if (new Set(routines.map((entry) => entry.slug)).size !== routines.length) {
    throw new TemplateDecodeError("bot template repeats a routine slug");
  }
  const packages = boundedArray(
    value.packages,
    "template packages",
    MAX_TEMPLATE_PACKAGES_V1,
  ).map(decodeTemplatePackageV1);
  if (
    new Set(packages.map((entry) => entry.catalogId)).size !== packages.length
  ) {
    throw new TemplateDecodeError("bot template repeats a catalogId");
  }
  const sourceCatalogGeneration =
    value.sourceCatalogGeneration === undefined
      ? undefined
      : pattern(
          value.sourceCatalogGeneration,
          "template sourceCatalogGeneration",
          GENERATION_PATTERN,
          64,
        );
  return {
    schemaVersion: 1,
    profile: decodeTemplateProfileV1(value.profile),
    skills,
    routines,
    packages,
    mcpServers: boundedArray(
      value.mcpServers,
      "template MCP servers",
      MAX_TEMPLATE_SERVERS_V1,
    ).map(decodeTemplateMcpServerV1),
    ...(sourceCatalogGeneration === undefined
      ? {}
      : { sourceCatalogGeneration }),
  };
}

/**
 * The canonical bytes of one template.
 *
 * Content addressing needs one serialization, so this is it: keys in declared
 * order, no whitespace, and a decode first so a caller cannot hash a document
 * the decoder would refuse. Hashing what `JSON.stringify` happens to produce
 * for an arbitrary object would make the same template hash differently
 * depending on which surface built it.
 */
export function canonicalBotTemplateDocumentV1(
  template: BotTemplateV1,
): string {
  const decoded = decodeBotTemplateV1(template);
  const document = JSON.stringify({
    schemaVersion: 1,
    profile: {
      name: decoded.profile.name,
      ...(decoded.profile.title === undefined
        ? {}
        : { title: decoded.profile.title }),
      ...(decoded.profile.description === undefined
        ? {}
        : { description: decoded.profile.description }),
      avatar: {
        kind: "sheep",
        recipe: {
          schemaVersion: 1,
          background: decoded.profile.avatar.recipe.background,
          upper: decoded.profile.avatar.recipe.upper,
          middle: decoded.profile.avatar.recipe.middle,
          lower: decoded.profile.avatar.recipe.lower,
        },
      },
    },
    skills: decoded.skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      ...(skill.description === undefined
        ? {}
        : { description: skill.description }),
      body: skill.body,
    })),
    routines: decoded.routines.map((routine) => ({
      slug: routine.slug,
      name: routine.name,
      prompt: routine.prompt,
      ...(routine.schedule === undefined ? {} : { schedule: routine.schedule }),
      timezone: routine.timezone,
      ...(routine.triggerKind === undefined
        ? {}
        : { triggerKind: routine.triggerKind }),
    })),
    packages: decoded.packages.map((entry) => ({
      packageId: entry.packageId,
      catalogId: entry.catalogId,
      version: entry.version,
      displayName: entry.displayName,
    })),
    mcpServers: decoded.mcpServers.map((server) =>
      server.kind === "public"
        ? {
            kind: "public",
            name: server.name,
            url: server.url,
            transport: server.transport,
          }
        : {
            kind: "needs-connection",
            name: server.name,
            connectionTypeId: server.connectionTypeId,
            ...(server.hint === undefined ? {} : { hint: server.hint }),
          },
    ),
    ...(decoded.sourceCatalogGeneration === undefined
      ? {}
      : { sourceCatalogGeneration: decoded.sourceCatalogGeneration }),
  });
  assertTemplateDocumentSizeV1(document);
  return document;
}

export function assertTemplateDocumentSizeV1(document: string): void {
  // The bound is on bytes, and a template carries prose in any script, so a
  // character count would let a non-Latin template past a byte budget the
  // bucket and the decoder both measure in bytes.
  const bytes = new TextEncoder().encode(document).byteLength;
  if (bytes > MAX_TEMPLATE_BYTES_V1) {
    throw new TemplateDecodeError(
      `bot template is ${bytes} bytes; the bound is ${MAX_TEMPLATE_BYTES_V1}`,
    );
  }
}

/**
 * SHA-256 over the exact bytes the bucket holds, hex-encoded. Identical to
 * `catalogContentHashV1` in shape and in reason: a pinned hash must mean
 * "these bytes", not "something that re-serializes to this".
 */
export async function templateContentHashV1(document: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(document),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The immutable object key one template blob lives at. */
export function templateObjectKeyV1(hash: string): string {
  return `templates/${decodeTemplateContentHashV1(hash)}.json`;
}

/** Parse a stored blob, verifying the hash before anything downstream sees it. */
export async function decodeBotTemplateDocumentV1(
  document: string,
  expectedHash: string,
): Promise<BotTemplateV1> {
  assertTemplateDocumentSizeV1(document);
  const actual = await templateContentHashV1(document);
  if (actual !== decodeTemplateContentHashV1(expectedHash)) {
    throw new TemplateDecodeError(
      "bot template failed content hash verification",
    );
  }
  return parseBotTemplateDocumentV1(document);
}

/** Parse a document whose hash the caller has not pinned. */
export function parseBotTemplateDocumentV1(document: string): BotTemplateV1 {
  assertTemplateDocumentSizeV1(document);
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch (error) {
    throw new TemplateDecodeError("bot template is not JSON", { cause: error });
  }
  return decodeBotTemplateV1(value);
}

/**
 * `<publicUserId>.<random>`.
 *
 * The owner's public id is the routing half: an unauthenticated
 * `GET /templates/v1/:shareId` derives the one User Durable Object that can
 * answer for it, with no global index. The random half is the capability half —
 * a content hash alone is guessable by anyone holding the same content, so it
 * could never be the secret a `link` share rests on.
 */
export function templateShareIdV1(ownerId: string, secret: string): string {
  if (!SHARE_OWNER_PATTERN.test(ownerId)) {
    throw new TemplateDecodeError("template share owner id is invalid");
  }
  if (!SHARE_SECRET_PATTERN.test(secret)) {
    throw new TemplateDecodeError("template share secret is invalid");
  }
  return `${ownerId}.${secret}`;
}

export interface ParsedTemplateShareIdV1 {
  ownerId: string;
  secret: string;
}

export function parseTemplateShareIdV1(
  value: unknown,
): ParsedTemplateShareIdV1 {
  const candidate = text(value, "template shareId", 160);
  const separator = candidate.lastIndexOf(".");
  if (separator <= 0) {
    throw new TemplateDecodeError("template shareId is invalid");
  }
  const ownerId = candidate.slice(0, separator);
  const secret = candidate.slice(separator + 1);
  if (
    !SHARE_OWNER_PATTERN.test(ownerId) ||
    !SHARE_SECRET_PATTERN.test(secret)
  ) {
    throw new TemplateDecodeError("template shareId is invalid");
  }
  return { ownerId, secret };
}

export function decodeTemplateVisibilityV1(
  value: unknown,
): TemplateVisibilityV1 {
  const found = TEMPLATE_VISIBILITIES_V1.find((known) => known === value);
  if (!found) throw new TemplateDecodeError("template visibility is invalid");
  return found;
}

export function decodeTemplateShareRecordV1(
  input: unknown,
): TemplateShareRecordV1 {
  const value = exactRecord(
    input,
    "template share",
    ["schemaVersion", "shareId", "hash", "botId", "visibility", "createdAt"],
    ["revokedAt"],
  );
  if (value.schemaVersion !== 1) {
    throw new TemplateDecodeError("template share schema version is invalid");
  }
  parseTemplateShareIdV1(value.shareId);
  return withOptional(
    {
      schemaVersion: 1 as const,
      shareId: value.shareId as string,
      hash: decodeTemplateContentHashV1(value.hash),
      botId: text(value.botId, "template share botId", 128),
      visibility: decodeTemplateVisibilityV1(value.visibility),
      createdAt: timestamp(value.createdAt, "template share createdAt"),
    },
    {
      revokedAt:
        value.revokedAt === undefined
          ? undefined
          : timestamp(value.revokedAt, "template share revokedAt"),
    },
  );
}

/**
 * Whether an unauthenticated read of this share is allowed.
 *
 * `private` is the visibility a staged share starts at, and revocation is the
 * only thing that can happen to an immutable blob, so both answers are "no"
 * here and a 404 at the route: an unauthenticated caller learns nothing about
 * whether a share exists.
 */
export function isTemplateShareReadableV1(
  share: TemplateShareRecordV1,
): boolean {
  return (
    share.revokedAt === undefined &&
    (share.visibility === "link" || share.visibility === "public")
  );
}
