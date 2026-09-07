/// The names the browser specs select on.
///
/// Flutter Web draws to a canvas, so Playwright sees no DOM of its own: the
/// engine's accessibility tree is the only thing it can select, and a widget
/// reaches that tree by carrying a `Semantics(identifier:)`. Every identifier
/// the specs use is written here once, kebab-case, so a rename is one edit
/// rather than a search through the widget files for a string literal.
library;

import 'package:flutter/widgets.dart';

abstract final class ShellIds {
  static const sidebar = 'shell-sidebar';
  static const sidebarToggle = 'sidebar-toggle';
  static const sidebarSearch = 'sidebar-search';
  static const sidebarCreateBot = 'sidebar-create-bot';
  static const sidebarProfile = 'sidebar-profile';
  static const sidebarInbox = 'sidebar-inbox';
  static const sidebarManage = 'sidebar-manage';
  static const sidebarHiddenToggle = 'sidebar-hidden-toggle';
  static const sidebarRetry = 'sidebar-retry';
  static const conversation = 'shell-conversation';
  static const rightPanel = 'shell-right-panel';
  static const rightPanelClose = 'right-panel-close';
  static const scrim = 'shell-scrim';
  static const botPanelToggle = 'bot-panel-toggle';
  static const transcript = 'chat-transcript';
  static const transcriptEarlier = 'transcript-earlier';
  static const composer = 'chat-composer';
  static const sendButton = 'send-button';
  static const stopButton = 'stop-button';
  static const composerCounter = 'composer-counter';
  static const skillMenu = 'skill-menu';
  static const skillChips = 'skill-chips';
  static const workingIndicator = 'working-indicator';
  static const runView = 'run-view';
  static const runViewClose = 'run-view-close';
  static const reconnect = 'reconnect-button';
  static const checkDelivery = 'check-delivery';

  static String sidebarBot(String botId) => 'sidebar-bot-$botId';
  static String sidebarPinned(String botId) => 'sidebar-pinned-$botId';
  static String sidebarGroup(String key) => 'sidebar-group-$key';
  static String message(String id) => 'message-$id';
  static String retryTurn(String runId) => 'retry-turn-$runId';
  static String openRun(String runId) => 'open-run-$runId';
  static String approve(String approvalId) => 'approval-approve-$approvalId';
  static String deny(String approvalId) => 'approval-deny-$approvalId';
  static String skillOption(String ref) => 'skill-option-$ref';
  static String skillChip(String ref) => 'skill-chip-$ref';
  static String slot(String name) => 'shell-slot-$name';
}

/// Names a widget for the browser specs without changing how it is drawn, or
/// what it says.
///
/// Deliberately not a semantics container: a container node carries the
/// identifier and nothing else, and the label the widget already had — a
/// button's tooltip, a field's hint — stops reaching the accessibility tree.
/// Annotating merges the identifier onto the node that has the label instead.
Widget identified(String identifier, Widget child) =>
    Semantics(identifier: identifier, child: child);

/// Settings: the account surfaces, and the Bot's own panel.
///
/// The names follow the Vue specs' selectors where those specs name a thing —
/// `bot-settings.e2e.ts`, `settings-models.e2e.ts` and `profile.e2e.ts` — so
/// each can be rewritten against Flutter Web with the same intent rather than
/// re-derived from the widgets.
abstract final class SettingsIds {
  static const document = 'settings-document';
  static const refresh = 'settings-refresh';
  static const modelsLink = 'settings-models';
  static const connectorsLink = 'settings-connections';
  static const modelField = 'settings-model-field';
  static const modelPicker = 'model-picker';
  static const modelPickerSearch = 'model-picker-search';

  static const profileTrigger = ShellIds.sidebarProfile;
  static const profileMenu = 'profile-menu';
  static const profileName = 'profile-name';
  static const profileSettings = 'profile-settings';
  static const profileModels = 'profile-models';
  static const profileConnections = 'profile-connections';
  static const profileSignOut = 'profile-sign-out';

  static const botSettings = 'bot-settings';
  static const botAvatar = 'bot-avatar';
  static const botName = 'bot-name';
  static const botLabel = 'bot-label';
  static const botPinned = 'bot-pinned';
  static const botDescription = 'bot-description';
  static const botNotifications = 'bot-notifications';
  static const botModel = 'bot-model';
  static const botAdvanced = 'bot-advanced';
  static const botTitle = 'bot-title';
  static const botHidden = 'bot-hidden-from-sidebar';
  static const botIdentity = 'bot-info-identity';
  static const botMembers = 'bot-info-members';
  static const botSave = 'bot-settings-save';

  static String modelOption(String label) => 'model-option-$label';
}

/// Connectors: the accounts a User authorizes for every Bot they own.
///
/// The names follow what `connect-ollama.e2e.ts` selects on — the provider
/// card, the connect form's three fields, the connect button and the account
/// row's state line — so that spec can be rewritten against Flutter Web with
/// the same intent rather than re-derived from the widgets. A provider's own
/// controls are named by the projected field ids, which is the one place the
/// document's conventions surface in a selector.
abstract final class ConnectorIds {
  static const document = 'connections-document';
  static const refresh = 'connections-refresh';

  /// The connect form of the provider at `index`, field by field. These are
  /// the projected ids from `connectionsDocumentV1`.
  static String connectLabel(int index) =>
      viewFieldIdentifierV1('c$index.label');
  static String connectKey(int index) => viewFieldIdentifierV1('c$index.key');
  static String connectSetting(int index, String setting) =>
      viewFieldIdentifierV1('c$index.s.$setting');

  static String group(String title) => viewGroupIdentifierV1(title);
  static String action(String actionId) => viewActionIdentifierV1(actionId);
}

/// A `field` node's identifier: the id the document gave it.
String viewFieldIdentifierV1(String id) => 'view-field-$id';

/// An `action` node's identifier. Several nodes may name one declared action —
/// a row's Disconnect is the same action as the next row's — so a spec that
/// means one of them scopes to the group it is in.
String viewActionIdentifierV1(String actionId) => 'view-action-$actionId';

/// A titled `group` node's identifier.
///
/// A title is prose a projection wrote, so it is slugged rather than used as
/// it stands: a selector should not have to know how a Package spelled its own
/// name. Two groups that slug the same are two matches, which is what a spec
/// scoping to one of them already has to handle.
String viewGroupIdentifierV1(String title) =>
    'view-group-${title.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-|-$'), '')}';

/// Plugins: what a User has, and whether it is on.
///
/// `defaults.e2e.ts` proves a fresh account needs none of this — no model
/// prompt, no plugin to enable — so what it selects on here is absence. The
/// names exist so a spec can say so.
abstract final class PluginIds {
  static const document = 'plugins-document';
  static const refresh = 'plugins-refresh';
  static const profileEntry = 'profile-plugins';
}

/// Routines: what a Bot does on its own, and what it left behind.
///
/// The names follow what `routines.e2e.ts` selects on — the section, a
/// Routine's card, its controls and the delete confirmation — so that spec can
/// be rewritten against Flutter Web with the same intent. The completions
/// badge and its drawer follow `RoutineInboxBadge.vue`: a count, a trigger and
/// one acknowledgement per entry.
abstract final class RoutineIds {
  static const document = 'routines-document';
  static const refresh = 'routines-refresh';
  static const panel = 'routines-panel';
  static const panelToggle = 'routines-panel-toggle';
  static const inboxBadge = 'routine-inbox-badge';
  static const inboxDrawer = 'routine-inbox-drawer';
  static const runLog = 'routine-run-log';
  static const confirmDelete = 'routine-delete-confirm';

  /// The editor's fields are the projection's own ids, so a spec names them the
  /// way it names any other field. There is one form on the surface — a new
  /// Routine, or the one the reader asked to edit — so the ids do not carry a
  /// Routine in them.
  static String editorField(String field) =>
      viewFieldIdentifierV1('routine.$field');

  /// The minted webhook key, which is host chrome: it comes back on a receipt,
  /// once, and is never in a document.
  static const webhookKey = 'routine-webhook-key';
  static const webhookCopy = 'routine-webhook-copy';
  static const webhookDismiss = 'routine-webhook-dismiss';

  static String run(String runId) => 'routine-run-$runId';
  static String action(String actionId) => viewActionIdentifierV1(actionId);
}

/// Flock: adding a Bot, and putting one away.
///
/// The names follow what `delete-bot.e2e.ts` and `bot-info.e2e.ts` select on —
/// the create gesture, the danger zone's three verbs, and the one confirmation
/// they share, whose title carries the Bot's name. The create sheet's names are
/// new: the Vue overlay's wardrobe was four selects and this is one choice.
abstract final class FlockIds {
  static const createTrigger = ShellIds.sidebarCreateBot;
  static const createSheet = 'flock-create';
  static const createName = 'flock-create-name';
  static const createFirstMessage = 'flock-create-first-message';
  static const createBackground = 'flock-create-background';
  static const createReroll = 'flock-create-reroll';
  static const createSubmit = 'flock-create-submit';
  static const colourSheet = 'flock-colour';

  static const dangerZone = 'flock-danger-zone';
  static const archiveBot = 'flock-archive-bot';
  static const restoreBot = 'flock-restore-bot';
  static const deleteBot = 'flock-delete-bot';
  static const lifecycleConfirm = 'flock-lifecycle-confirm';

  static String createBackgroundOption(String id) => 'flock-background-$id';
}

/// Bot templates: packing a Bot up, and unpacking someone else's.
///
/// Both halves are projections, so the controls are named by the document's own
/// conventions and only the surface's chrome is named here.
abstract final class TemplateIds {
  static const shareDocument = 'template-share-document';
  static const shareRefresh = 'template-share-refresh';
  static const importDocument = 'template-import-document';
  static const importRefresh = 'template-import-refresh';
  static const profileEntry = 'profile-templates';
}

/// Registered machines: the computers a Bot may reach, and the code that
/// registers one.
///
/// The pairing code is host chrome rather than a node, for the same reason a
/// `SettingField.secret` is never seeded: it exists once, on a receipt, and is
/// never in a document the server could send twice.
abstract final class MachineIds {
  static const document = 'machines-document';
  static const refresh = 'machines-refresh';
  static const profileEntry = 'profile-machines';
  static const pairingCode = 'machine-pairing-code';
  static const pairingCopy = 'machine-pairing-copy';
  static const pairingDismiss = 'machine-pairing-dismiss';
}

/// Audit: every effect a Bot performed, and what the log can and cannot say.
abstract final class AuditIds {
  static const document = 'audit-document';
  static const refresh = 'audit-refresh';
  static const recoveryEntry = 'recovery-audit-entry';
}

/// Search: every conversation this account has, and the Bots that had them.
///
/// The overlay replaces the Bot-list `SearchDelegate` the shell cut left, so
/// the sidebar's own trigger keeps its name and everything below it is new.
abstract final class SearchIds {
  static const trigger = ShellIds.sidebarSearch;
  static const overlay = 'search-overlay';
  static const field = 'search-field';
  static const rebuild = 'search-rebuild';
  static const includeArchived = 'search-include-archived';
  static const includeTools = 'search-include-tools';
  static const note = 'search-note';

  static String group(String botId) => 'search-group-$botId';
  static String hit(String runId) => 'search-hit-$runId';
}

/// Conversations: the one a Bot is holding, and the ones it has put down.
abstract final class ConversationIds {
  static const newConversation = 'new-conversation';
  static const picker = 'conversation-picker';

  static String option(String conversationId) => 'conversation-$conversationId';
}

/// Admin: the deployment's own surface, reachable only by an admin.
abstract final class AdminIds {
  static const refresh = 'admin-refresh';
  static const signups = 'admin-signups';
  static const profileEntry = 'profile-admin';
}
