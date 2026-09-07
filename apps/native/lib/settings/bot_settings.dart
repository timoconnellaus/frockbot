import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'model_picker.dart';

/// One Bot's own settings: its identity, how it reaches you, and the model it
/// runs on.
///
/// Per-Bot settings exist only for what must genuinely differ. Everything
/// account-shaped — Plugins, Connectors, the default model — is on the User's
/// Settings, and the Members line here says so rather than repeating it.
class BotSettingsController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  bool busy = false;
  bool saving = false;

  /// Whether a read has landed. A Bot that has never been edited is at
  /// revision 0, so the revision cannot double as this.
  bool loaded = false;
  bool _closed = false;
  String? message;
  int revision = 0;
  int accountRevision = 0;

  String name = '';
  String label = '';
  String description = '';
  String title = '';
  bool pinned = false;
  String pinnedAt = '';
  bool hidden = false;
  bool notifications = true;
  String namedBy = 'user';

  /// The Bot's model override, as the `custom-models` Package stores it, and
  /// null when this Bot follows the account model.
  Object? model;
  bool modelAvailable = false;

  BotSettingsController(this.api, this.botId);

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    if (busy) return;
    busy = true;
    message = null;
    _changed();
    try {
      final answer = (await api.request('/api/bots/$botId/settings'))! as Map;
      final profile = (answer['profile'] as Map).cast<String, Object?>();
      revision = answer['revision']! as int;
      name = profile['name'] as String? ?? '';
      label = profile['label'] as String? ?? '';
      description = profile['description'] as String? ?? '';
      title = profile['title'] as String? ?? '';
      hidden = profile['hiddenFromSidebar'] == true;
      pinnedAt = profile['pinnedAt'] as String? ?? '';
      pinned = pinnedAt.isNotEmpty;
      namedBy = profile['namedBy'] as String? ?? 'user';
      notifications =
          ((answer['notifications'] as Map?)?['enabled'] ?? true) == true;
      model =
          ((answer['packageValues'] as Map?)?['custom-models']
              as Map?)?['model'];
      loaded = true;
      await _loadAccount();
    } catch (_) {
      message = 'Couldn’t load this Bot’s settings. Check your connection and try again.';
    } finally {
      busy = false;
      _changed();
    }
  }

  /// The account revision the model catalog is read against. A deployment
  /// without the Package leaves the model row out rather than showing a
  /// control that cannot be saved.
  Future<void> _loadAccount() async {
    try {
      final settings = (await api.request('/api/settings?view=2'))! as Map;
      accountRevision = settings['revision']! as int;
      modelAvailable = (settings['packages'] as List? ?? const []).any(
        (entry) =>
            entry is Map &&
            entry['packageId'] == 'custom-models' &&
            entry['state'] == 'installed',
      );
    } catch (_) {
      modelAvailable = false;
    }
  }

  Future<wire.SettingsOptionsPage> options(String query, int? cursor) async {
    final page = wire.SettingsOptionsPage.fromJson(
      await api.request(
        '/api/settings/models/options',
        body: wire.SettingsOptionsQuery.fromJson({
          'schemaVersion': 1,
          'source': 'account-models',
          'revision': accountRevision,
          'query': query,
          'cursor': ?cursor,
        }).toJson(),
      ),
    );
    if (page.revision != accountRevision) {
      throw const FormatException('Model catalog changed');
    }
    return page;
  }

  void edit(void Function() change) {
    change();
    _changed();
  }

  /// Three commands, each idempotent by its own id: the profile, the
  /// notification policy, and the Bot's model override. A failure leaves what
  /// already landed in place and says so, rather than pretending nothing did.
  Future<bool> save() async {
    if (saving) return false;
    saving = true;
    message = null;
    _changed();
    try {
      await _command({
        'schemaVersion': 1,
        'commandId': randomId(),
        'type': 'bot/set-profile',
        'botId': botId,
        'profile': {
          'name': name.trim(),
          'label': label.trim(),
          'description': description,
          'title': title.trim(),
          'hiddenFromSidebar': hidden,
          'pinnedAt': pinned
              ? (pinnedAt.isEmpty
                    ? DateTime.now().toUtc().toIso8601String()
                    : pinnedAt)
              : '',
        },
      });
      await _command({
        'schemaVersion': 1,
        'commandId': randomId(),
        'type': 'bot/update-notifications',
        'botId': botId,
        'notifications': {'enabled': notifications},
      });
      if (modelAvailable) {
        await _command({
          'schemaVersion': 1,
          'commandId': randomId(),
          'type': 'bot/set-package-settings',
          'botId': botId,
          'packageId': 'custom-models',
          if (model != null) 'values': {'model': model} else 'unset': ['model'],
        });
      }
      message = 'Saved.';
      return true;
    } on RequestFailure catch (failure) {
      message = failure.message;
      return false;
    } catch (_) {
      message = 'Couldn’t save these settings. Try again.';
      return false;
    } finally {
      saving = false;
      _changed();
      unawaited(load());
    }
  }

  Future<void> _command(Map<String, Object?> command) async {
    await api.request('/api/bots/$botId/settings', body: command);
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// The Bot settings surface: the right-hand panel at wide widths, a page on
/// the phone. The order is GrokBot's — avatar, name, label, pinned,
/// description, notifications — and everything else is under Advanced.
class BotSettingsView extends StatefulWidget {
  final BotSettingsController controller;
  final VoidCallback? onClose;
  final Future<void> Function()? onSaved;
  const BotSettingsView({
    super.key,
    required this.controller,
    this.onClose,
    this.onSaved,
  });

  @override
  State<BotSettingsView> createState() => _BotSettingsViewState();
}

class _BotSettingsViewState extends State<BotSettingsView> {
  final form = GlobalKey<FormState>();
  bool advanced = false;

  BotSettingsController get state => widget.controller;

  @override
  void initState() {
    super.initState();
    if (!state.loaded && !state.busy) unawaited(state.load());
  }

  Future<void> _save() async {
    if (!form.currentState!.validate()) return;
    if (await state.save()) await widget.onSaved?.call();
  }

  Widget _field({
    required String id,
    required String label,
    required String value,
    required void Function(String) onChanged,
    String? hint,
    int? maxLength,
    int lines = 1,
    bool required = false,
  }) => identified(
    id,
    TextFormField(
      key: ValueKey('$id.${state.revision}'),
      initialValue: value,
      enabled: !state.saving,
      minLines: lines,
      maxLines: lines,
      maxLength: maxLength,
      decoration: InputDecoration(labelText: label, helperText: hint),
      onChanged: (next) => state.edit(() => onChanged(next)),
      validator: required
          ? (next) => (next ?? '').trim().isEmpty
                ? 'Enter a name for this Bot.'
                : null
          : null,
    ),
  );

  Widget _switch({
    required String id,
    required String title,
    required String detail,
    required bool value,
    required void Function(bool) onChanged,
  }) => identified(
    id,
    SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(title),
      subtitle: Text(detail),
      value: value,
      onChanged: state.saving
          ? null
          : (next) => state.edit(() => onChanged(next)),
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: state,
    builder: (context, _) {
      if (!state.loaded && state.busy) {
        return const FrockLoading(label: 'Loading Bot settings');
      }
      if (!state.loaded) {
        return FrockEmptyState(
          icon: Icons.cloud_off_rounded,
          title: 'Settings couldn’t load',
          detail: state.message ?? 'Check your connection and try again.',
          action: 'Try again',
          onAction: state.load,
        );
      }
      final type = Theme.of(context).textTheme;
      return identified(
        SettingsIds.botSettings,
        Form(
          key: form,
          // A Column, not a list: the region this lands in — the panel, or the
          // page — owns the scroll, and only one of them may.
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              // The panel names itself; the page's app bar already did.
              if (widget.onClose != null) ...[
                Row(
                  children: [
                    Expanded(
                      child: Semantics(
                        header: true,
                        child: Text('Settings', style: type.titleMedium),
                      ),
                    ),
                    identified(
                      ShellIds.rightPanelClose,
                      IconButton(
                        tooltip: 'Close settings',
                        onPressed: widget.onClose,
                        icon: const Icon(Icons.close_rounded),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
              ],
              identified(
                SettingsIds.botAvatar,
                Column(
                  children: [
                    const SheepAvatar(size: 72),
                    const SizedBox(height: 8),
                    Text(
                      '${state.name.isEmpty ? 'This Bot' : state.name} avatar',
                      style: type.bodySmall,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              _field(
                id: SettingsIds.botName,
                label: 'Name',
                value: state.name,
                maxLength: 100,
                required: true,
                onChanged: (next) => state.name = next,
              ),
              _field(
                id: SettingsIds.botLabel,
                label: 'Label',
                hint: 'Research, marketing, admin',
                value: state.label,
                maxLength: 120,
                onChanged: (next) => state.label = next,
              ),
              _switch(
                id: SettingsIds.botPinned,
                title: 'Pinned',
                detail: 'Pin this Bot to the top of the sidebar. Unpin it to put it back in the list.',
                value: state.pinned,
                onChanged: (next) => state.pinned = next,
              ),
              _field(
                id: SettingsIds.botDescription,
                label: 'Description',
                value: state.description,
                maxLength: 10000,
                lines: 6,
                onChanged: (next) => state.description = next,
              ),
              _switch(
                id: SettingsIds.botNotifications,
                title: 'Notifications',
                detail: 'Get notified when this Bot finishes or needs input',
                value: state.notifications,
                onChanged: (next) => state.notifications = next,
              ),
              if (state.modelAvailable) _model(context),
              const SizedBox(height: 8),
              identified(
                SettingsIds.botAdvanced,
                ExpansionTile(
                  title: const Text('Advanced'),
                  initiallyExpanded: advanced,
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: EdgeInsets.zero,
                  onExpansionChanged: (open) => setState(() => advanced = open),
                  children: [
                    _field(
                      id: SettingsIds.botTitle,
                      label: 'Title',
                      hint: 'Chief of staff, night-shift researcher',
                      value: state.title,
                      maxLength: 120,
                      onChanged: (next) => state.title = next,
                    ),
                    _switch(
                      id: SettingsIds.botHidden,
                      title: 'Hidden from sidebar',
                      detail: 'Keeps this Bot out of the list without archiving it.',
                      value: state.hidden,
                      onChanged: (next) => state.hidden = next,
                    ),
                    identified(
                      SettingsIds.botIdentity,
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: const Text('Identity'),
                        subtitle: Text(
                          state.name.isEmpty ? 'This Bot' : state.name,
                        ),
                        trailing: Text(
                          state.namedBy == 'bot'
                              ? 'Named by this Bot'
                              : 'Named by you',
                          style: type.bodySmall,
                        ),
                      ),
                    ),
                    identified(
                      SettingsIds.botMembers,
                      const ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text('Members'),
                        subtitle: Text(
                          'This Bot uses what you enable for all of your Bots.',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (state.message != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(state.message!),
                  ),
                ),
              const SizedBox(height: 8),
              identified(
                SettingsIds.botSave,
                FilledButton(
                  onPressed: state.saving ? null : _save,
                  child: Text(state.saving ? 'Saving…' : 'Save settings'),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );

  Widget _model(BuildContext context) => identified(
    SettingsIds.botModel,
    Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: ListTile(
        leading: const Icon(Icons.memory_rounded),
        title: Text(
          state.model == null
              ? 'Follow the account model'
              : 'This Bot’s own model',
        ),
        subtitle: Text(
          state.model == null
              ? 'Change it to give this Bot a model of its own.'
              : jsonEncode(state.model),
        ),
        trailing: const Icon(Icons.expand_more_rounded),
        onTap: state.saving
            ? null
            : () async {
                final choice = await Navigator.of(context)
                    .push<wire.SettingChoice>(
                      MaterialPageRoute(
                        builder: (_) => ModelPicker(
                          load: state.options,
                          selected: state.model,
                        ),
                      ),
                    );
                if (choice != null) {
                  state.edit(() => state.model = choice.value.value);
                }
              },
      ),
    ),
  );
}
