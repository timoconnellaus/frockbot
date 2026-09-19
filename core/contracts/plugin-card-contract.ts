/**
 * Dependency-free metadata shared by every decoder of a Plugin card action.
 *
 * Keep this leaf free of imports: the contracts barrel reaches Plugin cards
 * through several cycles, and the generated worker also embeds this source
 * into an isolated module that cannot import the host contracts at runtime.
 */
export const PLUGIN_CARD_ACTION_NAME_PATTERN_V1 = "^[a-z][a-z0-9_-]{0,63}$";
