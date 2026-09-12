import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../flock/sheep.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/sidebar.dart' show SidebarProfile;
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

  /// How many reads have replaced what the fields show. A field is keyed on
  /// this rather than on the revision: a save moves the revision on every
  /// command, and re-keying a field mid-edit throws away its focus and the
  /// text typed since the debounce fired.
  int loads = 0;

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

  /// What the authority is known to hold: the last values a read reported or a
  /// command of ours landed. A command whose values match this is not sent —
  /// pinning a Bot is one round trip rather than three — and it is where the
  /// sidebar's prediction goes back to when a save is refused.
  Map<String, Object?> _saved = const {};
  bool _savedNotifications = true;
  Object? _savedModel;

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
      loads += 1;
      _saved = _profileBody(pinnedAt);
      _savedNotifications = notifications;
      _savedModel = model;
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

  Map<String, Object?> _profileBody(String pinInstant) => {
    'name': name.trim(),
    'label': label.trim(),
    'description': description,
    'title': title.trim(),
    'hiddenFromSidebar': hidden,
    'pinnedAt': pinInstant,
  };

  /// The instant the sidebar orders a pinned Bot by. It is minted once and
  /// kept, so the tile drawn before the command lands and the one the command
  /// carries are the same pin rather than two instants a millisecond apart.
  String _pinInstant() {
    if (!pinned) return '';
    if (pinnedAt.isEmpty) pinnedAt = DateTime.now().toUtc().toIso8601String();
    return pinnedAt;
  }

  static SidebarProfile _profileOf(Map<String, Object?> body) => SidebarProfile(
    name: body['name'] as String?,
    title: body['title'] as String?,
    label: body['label'] as String?,
    pinnedAt: body['pinnedAt'] as String?,
    hiddenFromSidebar: body['hiddenFromSidebar'] == true,
  );

  /// The profile the sidebar would draw for what is on screen, which is what
  /// the next save is about to send. Predicting it is honest because the
  /// client computed every one of these values itself.
  SidebarProfile predictedProfile() => _profileOf(_profileBody(_pinInstant()));

  /// What the authority last accepted, so a refusal has somewhere to go back
  /// to.
  SidebarProfile get savedProfile => _profileOf(_saved);

  void edit(void Function() change) {
    change();
    _changed();
  }

  /// Up to three commands, each idempotent by its own id: the profile, the
  /// notification policy, and the Bot's model override. Only the ones whose
  /// values actually changed are sent, so flipping the pin switch is one
  /// request rather than three. A failure leaves what already landed in place
  /// and says so, rather than pretending nothing did.
  ///
  /// Every configuration command is fenced on a revision, and each one that is
  /// sent moves it — so the revision the receipt reports is what the next one
  /// fences on rather than the one the read returned. A command that is
  /// skipped sends nothing and moves nothing, so the fence stays current
  /// either way.
  ///
  /// What the fields show is not read back afterwards. The surface saves as
  /// the person edits, and a read landing under a field they are still typing
  /// into would replace their text with the server's copy of it.
  Future<bool> save() async {
    if (saving) return false;
    saving = true;
    message = null;
    _changed();
    final profile = _profileBody(_pinInstant());
    try {
      // Both maps are built by [_profileBody], so their encodings compare.
      if (jsonEncode(profile) != jsonEncode(_saved)) {
        await _command({
          'schemaVersion': 1,
          'commandId': randomId(),
          'type': 'bot/set-profile',
          'botId': botId,
          'profile': profile,
        });
        _saved = profile;
      }
      // The instant the sidebar orders by is now the one that was written, so
      // the next save keeps it rather than minting a newer one.
      pinnedAt = profile['pinnedAt']! as String;
      if (notifications != _savedNotifications) {
        await _command({
          'schemaVersion': 1,
          'commandId': randomId(),
          'type': 'bot/update-notifications',
          'botId': botId,
          'notifications': {'enabled': notifications},
        });
        _savedNotifications = notifications;
      }
      if (modelAvailable && jsonEncode(model) != jsonEncode(_savedModel)) {
        await _command({
          'schemaVersion': 1,
          'commandId': randomId(),
          'type': 'bot/set-package-settings',
          'botId': botId,
          'packageId': 'custom-models',
          if (model != null) 'values': {'model': model} else 'unset': ['model'],
        });
        _savedModel = model;
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
    }
  }

  /// One fenced command, and the revision it left behind.
  ///
  /// A conflict is re-fenced once against the revision the authority now
  /// holds. The only writer that moves a Bot's settings between two of these
  /// three is the previous one, so asking again with the current revision is
  /// what a person pressing Save once means — and a second conflict is a real
  /// one, from somewhere else, which is reported rather than retried.
  Future<void> _command(Map<String, Object?> command) async {
    try {
      _settle(await _send(command));
    } on RequestFailure catch (failure) {
      if (failure.status != 409) rethrow;
      final current = (await api.request('/api/bots/$botId/settings'))! as Map;
      revision = current['revision']! as int;
      _settle(await _send(command));
    }
  }

  Future<Map<String, Object?>> _send(Map<String, Object?> command) async {
    final answer = await api.request(
      '/api/bots/$botId/settings',
      body: {...command, 'expectedRevision': revision},
    );
    return (answer! as Map).cast<String, Object?>();
  }

  /// Adopt the receipt's revision, and refuse in the authority's own words.
  void _settle(Map<String, Object?> receipt) {
    final settled = receipt['revision'];
    if (settled is int) revision = settled;
    if (receipt['status'] != 'rejected') return;
    final failure = receipt['failure'];
    throw RequestFailure(
      failure is String ? failure : 'Couldn’t save these settings. Try again.',
    );
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// How long after the last keystroke a field's change is written. Long enough
/// that a word is not saved letter by letter, short enough that leaving the
/// page never loses one.
const botSettingsAutosaveDelay = Duration(milliseconds: 700);

/// The Bot settings surface: the right-hand panel at wide widths, the Bot's
/// page on the phone. The order is GrokBot's — avatar, name, label, pinned,
/// description, notifications — and everything else is under Advanced.
///
/// There is no Save button. A switch is written the moment it is flipped and a
/// field a moment after the person stops typing, which is what GrokBot does
/// and what a settings page on a phone is expected to do; the one thing the
/// surface says about it is a status line, so a write that failed is never
/// silent.
class BotSettingsView extends StatefulWidget {
  final BotSettingsController controller;
  final VoidCallback? onClose;
  final Future<void> Function()? onSaved;

  /// Draws a profile change where the Bot is listed — its tile, its group, its
  /// name — the moment it is made, and is handed the last accepted profile
  /// again if the authority refuses the save. Only values this client computed
  /// and is about to send are predicted.
  final void Function(SidebarProfile profile)? onPredict;

  /// What the host mounts between the Bot's own settings and Advanced: on the
  /// phone, the rows for its Routines, its Applets and its Package pages.
  final List<Widget> sections;

  /// This Bot's sheep, so the avatar here is the one the sidebar draws.
  final String? background;

  /// Opens the colour sheet. The Flock owns what a Bot looks like, so the
  /// settings surface offers the gesture and nothing else.
  final VoidCallback? onEditAvatar;

  /// Archiving, restoring and deleting belong to the Flock, whose directory
  /// they change, so the zone is handed in rather than rebuilt here. It is
  /// built in `lib/flock/lifecycle.dart`, which owns that seam.
  final Widget? dangerZone;
  const BotSettingsView({
    super.key,
    required this.controller,
    this.onClose,
    this.onSaved,
    this.onPredict,
    this.background,
    this.onEditAvatar,
    this.dangerZone,
    this.sections = const [],
  });

  @override
  State<BotSettingsView> createState() => _BotSettingsViewState();
}

class _BotSettingsViewState extends State<BotSettingsView> {
  final form = GlobalKey<FormState>();
  bool advanced = false;
  Timer? _pending;

  /// Edited since the last save started. A change made while a save is in
  /// flight is not in that save, so it is written again once it lands.
  bool _dirty = false;

  BotSettingsController get state => widget.controller;

  @override
  void initState() {
    super.initState();
    if (!state.loaded && !state.busy) unawaited(state.load());
  }

  /// A field's change: written once typing pauses.
  void _typed(void Function() change) {
    state.edit(change);
    _dirty = true;
    _pending?.cancel();
    _pending = Timer(botSettingsAutosaveDelay, () => unawaited(_save()));
  }

  /// A switch's or a choice's change: written now.
  void _chose(void Function() change) {
    state.edit(change);
    _dirty = true;
    unawaited(_save());
  }

  Future<void> _save() async {
    _pending?.cancel();
    _pending = null;
    if (!mounted && !_dirty) return;
    // A name that is empty is refused before anything is sent; the field
    // says so, and the next keystroke tries again.
    if (mounted && !(form.currentState?.validate() ?? true)) return;
    if (state.saving) {
      // The save in flight does not carry this change. Ask again when it has
      // landed rather than dropping it.
      _pending = Timer(botSettingsAutosaveDelay, () => unawaited(_save()));
      return;
    }
    _dirty = false;
    final predict = widget.onPredict;
    // Where the sidebar goes back to if this save is refused: what the
    // authority last accepted, read before the save moves that baseline.
    final accepted = state.savedProfile;
    predict?.call(state.predictedProfile());
    final saved = await state.save();
    if (!saved) predict?.call(accepted);
    if (saved) await widget.onSaved?.call();
    if (_dirty && mounted) {
      _pending = Timer(botSettingsAutosaveDelay, () => unawaited(_save()));
    }
  }

  @override
  void dispose() {
    // Leaving the page is not losing the last word typed on it.
    if (_pending != null) {
      _pending!.cancel();
      _pending = null;
      if (_dirty && state.name.trim().isNotEmpty) unawaited(state.save());
    }
    super.dispose();
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
      key: ValueKey('$id.${state.loads}'),
      initialValue: value,
      minLines: lines,
      maxLines: lines,
      maxLength: maxLength,
      decoration: InputDecoration(labelText: label, helperText: hint),
      onChanged: (next) => _typed(() => onChanged(next)),
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
      onChanged: (next) => _chose(() => onChanged(next)),
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
                InkWell(
                  onTap: widget.onEditAvatar,
                  borderRadius: BorderRadius.circular(16),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Column(
                      children: [
                        SheepAvatar(size: 72, background: widget.background),
                        const SizedBox(height: 8),
                        Text(
                          widget.onEditAvatar == null
                              ? '${state.name.isEmpty ? 'This Bot' : state.name} avatar'
                              : 'Change colour',
                          style: type.bodySmall,
                        ),
                      ],
                    ),
                  ),
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
              ...widget.sections,
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
                    if (widget.dangerZone case final Widget zone) zone,
                  ],
                ),
              ),
              _status(context),
            ],
          ),
        ),
      );
    },
  );

  /// What the surface says about writing: nothing until something has been
  /// saved, then the one word, and a failure in the authority's own words.
  Widget _status(BuildContext context) {
    final text = state.saving ? 'Saving…' : state.message;
    final failed =
        !state.saving && state.message != null && state.message != 'Saved.';
    return identified(
      SettingsIds.botSaveStatus,
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Semantics(
          liveRegion: true,
          child: AnimatedSwitcher(
            duration: FrockTheme.motion(context, FrockTheme.fast),
            child: text == null
                ? const SizedBox(height: 20)
                : Text(
                    text,
                    key: ValueKey(text),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: failed
                          ? Theme.of(context).colorScheme.error
                          : Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
          ),
        ),
      ),
    );
  }

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
        onTap: () async {
          final choice = await Navigator.of(context).push<wire.SettingChoice>(
            MaterialPageRoute(
              builder: (_) =>
                  ModelPicker(load: state.options, selected: state.model),
            ),
          );
          if (choice != null) {
            _chose(() => state.model = choice.value.value);
          }
        },
      ),
    ),
  );
}
