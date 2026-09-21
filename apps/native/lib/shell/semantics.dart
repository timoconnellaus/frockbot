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
  static const sidebarMarketplace = 'sidebar-marketplace';
  static const sidebarHiddenToggle = 'sidebar-hidden-toggle';
  static const sidebarRetry = 'sidebar-retry';
  static const conversation = 'shell-conversation';
  static const rightPanel = 'shell-right-panel';
  static const rightPanelClose = 'right-panel-close';

  /// The panel's way back out of a sub-page to the Bot page under it. Only
  /// there while the panel holds a stack; the phone pops a route instead.
  /// Leaving the Routine detail is not leaving Routines — that press uses
  /// [panelBackIdentifierV1] so the detail keeps its own id.
  static const rightPanelBack = 'right-panel-back';
  static const rightPanelToggle = 'right-panel-toggle';
  static const scrim = 'shell-scrim';
  static const botPanelToggle = 'bot-panel-toggle';
  static const computerDestination = 'computer-destination';
  static const transcript = 'chat-transcript';
  static const transcriptEarlier = 'transcript-earlier';
  static const composer = 'chat-composer';
  static const sendButton = 'send-button';
  static const stopButton = 'stop-button';
  static const composerCounter = 'composer-counter';
  static const skillMenu = 'skill-menu';
  static const skillChips = 'skill-chips';
  static const workingIndicator = 'working-indicator';

  /// The words a running Turn earns in the thread: a Stop being waited on,
  /// or a Turn queued behind the one it displaced.
  static const workingNotice = 'working-notice';
  static const runView = 'run-view';
  static const runViewClose = 'run-view-close';
  static const reconnect = 'reconnect-button';
  static const checkDelivery = 'check-delivery';
  static const updateReady = 'update-ready';
  static const updateRestart = 'update-restart';
  static const updateControl = 'update-control';

  static String sidebarBot(String botId) => 'sidebar-bot-$botId';
  static String sidebarPinned(String botId) => 'sidebar-pinned-$botId';
  static String sidebarGroup(String key) => 'sidebar-group-$key';
  static String message(String id) => 'message-$id';
  static String retryTurn(String runId) => 'retry-turn-$runId';

  /// The Billing door under a reply the account could not pay for.
  static String openBilling(String runId) => 'open-billing-$runId';

  /// The banner over a conversation whose account cannot spend.
  static const outOfCredit = 'out-of-credit';
  static String openRun(String runId) => 'open-run-$runId';

  /// The marker in the thread for a message to or from a counterpart, and the
  /// view-only chat it opens.
  static String exchange(String lineId) => 'exchange-$lineId';
  static const exchangeView = 'exchange-view';
  static const exchangeViewClose = 'exchange-view-close';
  static String approve(String approvalId) => 'approval-approve-$approvalId';
  static String deny(String approvalId) => 'approval-deny-$approvalId';
  static String skillOption(String ref) => 'skill-option-$ref';
  static String skillChip(String ref) => 'skill-chip-$ref';
  static String slot(String name) => 'shell-slot-$name';
}

/// The quick actions on one Bot in the list.
abstract final class BotActionIds {
  /// The control a desktop row grows on hover and focus.
  static String menu(String botId) => 'bot-actions-$botId';

  /// The button a phone row reveals when swiped towards the leading edge.
  static String swipeHide(String botId) => 'bot-swipe-hide-$botId';
  static String item(Object action) =>
      'bot-action-${action.toString().split('.').last}';
  static const labelPicker = 'bot-label-picker';
  static const labelClear = 'bot-label-clear';
  static String labelChoice(String label) =>
      'bot-label-choice-${label.toLowerCase()}';
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

/// What’s New: the profile row and the page it opens.
abstract final class WhatsNewIds {
  static const page = 'whats-new-page';
  static const unread = 'whats-new-unread';
  static String entry(String id) => 'whats-new-entry-$id';
}

/// General's first-run suggestions, which only ever fill the composer.
abstract final class StarterIds {
  static const list = 'starter-suggestions';
  static String suggestion(String id) => 'starter-$id';
}

/// The sign-in door, which on the web is the first thing anyone sees.
///
/// The page is public and pre-session, so it is where a browser spec starts:
/// the shell's own identifiers are not in the tree until an account is.
abstract final class SignInIds {
  static const page = 'sign-in';
  static const submit = 'sign-in-submit';
  static const note = 'sign-in-note';
}

/// Voice: the control that starts it, and the surfaces that are it.
///
/// The control is always present — a deployment without the keys answers a
/// press with one line rather than hiding the button — so a spec can select
/// on it whatever the deployment is configured with.
abstract final class VoiceIds {
  static const footer = 'voice-footer';
  static const footerAnimation = 'voice-footer-animation';
  static const mute = 'voice-mute';
  static const end = 'voice-end';

  /// The fixed voice control at the far right of the composer (ADR 0029).
  /// Unlike the morphing action beside it, it is always this one thing.
  static const mode = 'voice-mode';
  static const callChrome = 'voice-call-chrome';
  static const callUser = 'voice-call-user';
  static const callBot = 'voice-call-bot';
  static const callWave = 'voice-call-wave';
  static const callState = 'voice-call-state';
  static const stage = 'voice-stage';
  static const state = 'voice-state';
  static const activity = 'voice-activity';

  /// The one line the call is saying on its own surface: a failure that
  /// ended it, the end itself, or a notice that is borrowing the stage.
  static const modeNotice = 'voice-mode-notice';
  static const pause = 'voice-pause';
  static const resume = 'voice-resume';
  static const hangUp = 'voice-hang-up';
  static const modeMeter = 'voice-mode-meter';
  static const headerPill = 'voice-header-pill';
  static String chip(String runId) => 'voice-chip-$runId';

  /// The Bot's voice under its settings: the row, the page and its pickers.
  static const settingsRow = 'voice-settings-row';
  static const settings = 'voice-settings';
  static const timbre = 'voice-timbre';
  static const accent = 'voice-accent';
  static const attitude = 'voice-attitude';
  static const pace = 'voice-pace';
  static const turnLength = 'voice-turn-length';
  static const humour = 'voice-humour';
  static const disfluency = 'voice-disfluency';
  static const custom = 'voice-custom';
  static const picker = 'voice-picker';

  static const composerVoice = 'composer-voice';
  static const composerDictate = 'composer-dictate';
  static const composerDictationStop = 'composer-dictation-stop';
  static const composerDictationLevel = 'composer-dictation-level';
  static const composerDictationElapsed = 'composer-dictation-elapsed';
  static const composerDictationDiscard = 'composer-dictation-discard';
}

abstract final class LookIds {
  static const settings = 'bot-look-settings';
  static const preview = 'bot-look-preview';
  static const editor = 'bot-look-editor';
  static const typeface = 'bot-look-typeface';
  static const botBubble = 'bot-look-bot-bubble';
  static const meBubble = 'bot-look-me-bubble';
  static String option(String look) => 'bot-look-$look';
  static String surface(String name) => 'bot-look-surface-$name';
}

/// Settings: the account surfaces, and the Bot's own panel.
///
/// The names follow the specs' selectors where those specs name a thing —
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
  static const profileManageBots = 'profile-manage-bots';
  static const profileSignOut = 'profile-sign-out';
  static const profileVersion = 'profile-version';
  static const profileWhatsNew = 'profile-whats-new';

  /// What the account can still spend, at the top of the Profile page.
  static const profileCredit = 'profile-credit';

  static const botSettings = 'bot-settings';
  static const botAvatar = 'bot-avatar';
  static const botName = 'bot-name';
  static const botLabel = 'bot-label';
  static const botPinned = 'bot-pinned';
  static const botDescription = 'bot-description';
  static const botNotifications = 'bot-notifications';
  static const botModel = 'bot-model';
  static const botTitle = 'bot-title';
  static const botHidden = 'bot-hidden-from-sidebar';
  static const botHideConfirm = 'bot-hide-confirm';
  static const botSaveStatus = 'bot-settings-status';
  static const botLook = 'bot-settings-look';

  /// The Bot page: what the Bot is doing, and the doors to the rest of it.
  static const botPage = 'bot-page';

  /// The gear in the Bot page's header, the one way into Settings.
  static const botPageSettings = 'bot-page-settings';

  /// The Computer section's "Open" on the Bot page.
  static const botPageComputer = 'bot-page-computer';

  /// The row under the recent runs, which opens the whole Routines surface.
  static const botPageRoutinesAll = 'bot-page-routines-all';

  /// One recent Routine run on the Bot page, which opens its run log.
  static String botPageRun(String entryId) => 'bot-page-run-$entryId';

  /// The row under the running Applets, which opens the whole list.
  static const botPageAppletsAll = 'bot-page-applets-all';

  /// One running Applet on the Bot page. Not the Applet list's own row id:
  /// the list is a page of its own and both can be on screen at once.
  static String botPageApplet(String appletId) => 'bot-page-applet-$appletId';

  /// Settings' door to this Bot's Plugins, and to its model.
  static const botPlugins = 'bot-settings-plugins';

  static String modelOption(String label) => 'model-option-$label';
}

/// Connectors: the accounts a User authorizes for every Bot they own.
///
/// The page is host chrome over the `ConnectionsFrame`, so the names here are
/// what a connect flow is driven by: the page, its refresh, a provider's card
/// and its connect button. A card is named by its provider's display name the
/// way a titled group is, so a spec scopes to "Ollama Cloud" the same way
/// whichever renderer draws it.
abstract final class ConnectorIds {
  static const document = 'connections-document';
  static const refresh = 'connections-refresh';
  static const marketplaceRefresh = 'marketplace-refresh';
  static const marketplaceSearch = 'marketplace-search';
  static const marketplaceFilter = 'marketplace-filter';
  static const marketplaceFilterAll = 'marketplace-filter-all';
  static const marketplaceFilterModels = 'marketplace-filter-models';
  static const marketplaceFilterConnectors = 'marketplace-filter-connectors';

  /// The Marketplace dialog a desktop opens from the foot of the sidebar; a
  /// phone pushes the same page, and the page's own id is the marker on both.
  static const marketplaceDialog = 'marketplace-dialog';

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
  static const marketplaceDocument = 'marketplace-plugins-document';
  static const refresh = 'plugins-refresh';

  /// The Profile's entry: the account's list, what is installed.
  static const profileEntry = 'profile-plugins';
}

/// Routines: what a Bot does on its own, and what it left behind.
///
/// The names follow what `routines.e2e.ts` selects on — the section, a
/// Routine's row, its controls and the delete confirmation — so that spec can
/// be rewritten against Flutter Web with the same intent. The one door to the
/// surface is the All Routines row on the Bot page
/// ([SettingsIds.botPageRoutinesAll]) at every tier.
abstract final class RoutineIds {
  static const document = 'routines-document';
  static const refresh = 'routines-refresh';
  static const panel = 'routines-panel';

  static const inboxDrawer = 'routine-inbox-drawer';
  static const runLog = 'routine-run-log';
  static const confirmDelete = 'routine-delete-confirm';

  /// The detail's way back to the list. On the phone this is the AppBar back.
  /// In the right panel it is the panel header back while the detail is open.
  static const detailBack = 'routine-detail-back';

  static String detailField(String field) =>
      viewFieldIdentifierV1('routine.$field');

  /// The minted webhook key, which is host chrome: it comes back on a receipt,
  /// once, and is never in a document.
  static const webhookKey = 'routine-webhook-key';
  static const webhookCopy = 'routine-webhook-copy';
  static const webhookDismiss = 'routine-webhook-dismiss';

  static String run(String runId) => 'routine-run-$runId';
  static String completion(String entryId) => 'routine-completion-$entryId';
  static String action(String actionId) => viewActionIdentifierV1(actionId);
}

/// The panel header back. Leaving the Routines detail is not leaving
/// Routines, so that press keeps the detail's own id.
String panelBackIdentifierV1({
  required String? panelKey,
  required bool routinesEditorOpen,
}) => panelKey == 'routines' && routinesEditorOpen
    ? RoutineIds.detailBack
    : ShellIds.rightPanelBack;

/// Flock: adding a Bot, and putting one away.
///
/// The names follow what `delete-bot.e2e.ts` and `bot-info.e2e.ts` select on —
/// the create gesture, the danger zone's three verbs, and the one confirmation
/// they share, whose title carries the Bot's name. The create sheet's names are
/// new: its character is one choice, followed by an optional colour.
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
  static const archivedConversation = 'search-archived-conversation';
  static const field = 'search-field';
  static const rebuild = 'search-rebuild';
  static const includeArchived = 'search-include-archived';
  static const includeTools = 'search-include-tools';
  static const note = 'search-note';
  static const close = 'search-close';
  static const filter = 'search-filter';
  static const options = 'search-options';

  static String category(String category) => 'search-category-$category';
  static String bot(String botId) => 'search-bot-$botId';
  static String routine(String botId, String routineId) =>
      'search-routine-$botId-$routineId';
  static String action(String actionId) => 'search-action-$actionId';

  static String group(String botId) => 'search-group-$botId';
  static String hit(String runId) => 'search-hit-$runId';
}

/// Applets: what a Bot built, and what it is doing to it now.
///
/// The names follow what `applets.e2e.ts` and `applets-shell.e2e.ts` select on
/// — the canvas region, its progress line, the App/Code toggle, one file
/// button and the failure's retry — so both specs can be rewritten against
/// Flutter Web with the same intent rather than re-derived from the widgets.
/// The one door to the selected Bot's Applet list is the All Applets row on
/// its page ([SettingsIds.botPageAppletsAll]): the list is the sidebar's
/// Applets mode on a wide window and a page of its own on a phone.
abstract final class AppletIds {
  static const canvas = 'applet-canvas';
  static const progress = 'applet-canvas-progress';
  static const failure = 'applet-canvas-failure';
  static const retry = 'applet-canvas-retry';
  static const tabs = 'applet-canvas-tabs';
  static const close = 'applet-canvas-close';
  static const source = 'applet-canvas-source';
  static const list = 'applet-list';
  static const listBack = 'applet-list-back';
  static const listRetry = 'applet-list-retry';

  /// One Applet in the list, which opens it.
  static String row(String appletId) => 'applet-row-$appletId';

  /// Whether the Bot owns the Applet in that row or has it shared.
  static String access(String appletId) => 'applet-access-$appletId';

  /// The owner's delete, on rows the Bot owns and no others.
  static String delete(String appletId) => 'applet-delete-$appletId';

  /// A file button in the code view, by the path it opens. Paths carry dots
  /// and slashes, which a selector reads perfectly well and a slug would lose.
  static String file(String path) => 'applet-file-$path';
}

/// The Computer: whether it is there, what it is doing, and who is driving.
///
/// The names follow what `computer-presence.e2e.ts` selects on — the card, its
/// live/snapshot line, the full-window viewer, Take control and the
/// confirmation it opens, Release control and Reconnect.
abstract final class ComputerIds {
  static const card = 'computer-card';
  static const status = 'computer-screen-status';
  static const progress = 'computer-progress';
  static const viewer = 'computer-viewer';
  static const phase = 'computer-phase';
  static const takeControl = 'computer-take-control';
  static const takeControlConfirm = 'computer-take-control-confirm';
  static const releaseControl = 'computer-release-control';
  static const reconnect = 'computer-reconnect';
}

/// Package pages: a first-party or Bot-authored page, and the control that
/// opens it.
///
/// The names follow what `package-iframe-ui.e2e.ts` selects on — the framed
/// page and its attribution. An entry is named by the Package and the entry
/// the manifest declared, because that pair is what a spec means when it says
/// "the Applets door" — a row under More on the Bot page, since this Bot's
/// Package entries left the conversation bar.
abstract final class PackageIds {
  static String entry(String packageId, String entryId) =>
      'package-entry-$packageId-$entryId';
  static String page(String packageId, String pageId) =>
      'package-page-$packageId-$pageId';
}
