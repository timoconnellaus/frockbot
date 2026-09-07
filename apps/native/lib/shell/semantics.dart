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
