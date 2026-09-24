// The first-party Skills this deployment ships, as directories the check and
// the generator both walk. Adding a slug here without a directory (or the
// other way around) fails `scripts/check-managed-skills.ts`.
//
// `learn-from-demonstration` is not among them: GrokBot's teach-queue,
// capture UI and `watchVideo` path are not started here (parity row 54), so
// a recipe that names them would teach a procedure the Bot cannot run.
// `write-skill` is the FrockBot path: `skill_write` plus references.

export const MANAGED_SKILL_AUTHORSHIPS_V1 = [
  {
    slug: "add-connector",
    directory: "app/skills/managed-skills/add-connector",
  },
  {
    slug: "export-bot-template",
    directory: "app/skills/managed-skills/export-bot-template",
  },
  {
    slug: "import-bot-template",
    directory: "app/skills/managed-skills/import-bot-template",
  },
  {
    slug: "write-skill",
    directory: "app/skills/managed-skills/write-skill",
  },
  {
    slug: "plugins",
    directory: "app/plugins/skills/plugins",
  },
  {
    slug: "a2ui",
    directory: "app/cards/skills/a2ui",
  },
] as const;

export type ManagedSkillSlugV1 =
  (typeof MANAGED_SKILL_AUTHORSHIPS_V1)[number]["slug"];

/** Recipe Skills the generator compiles as one module; the other three have their own. */
export const MANAGED_RECIPE_SKILL_SLUGS_V1 = [
  "add-connector",
  "export-bot-template",
  "import-bot-template",
  "write-skill",
] as const;

export const FORBIDDEN_MANAGED_SKILL_SLUGS_V1 = [
  "learn-from-demonstration",
] as const;

/**
 * Tool names that belong to GrokBot (or to a path FrockBot has not started)
 * and must not appear in a first-party Skill body.
 */
export const FORBIDDEN_SKILL_TOKENS_V1 = [
  "SearchPlugins",
  "GetPlugin",
  "InstallPlugin",
  "AddMcpServer",
  "AuthenticateMcpServer",
  "SetMcpInstructions",
  "update_state",
  "create_bot_share_json",
  "teach-sessions",
] as const;

export const PLUGIN_AUTHORING_TOOL_NAMES_V1 = [
  "plugin_list",
  "plugin_create",
  "plugin_files",
  "plugin_read_file",
  "plugin_write_file",
  "plugin_check",
  "plugin_publish",
  "plugin_enable",
  "plugin_disable",
  "plugin_settings",
] as const;
