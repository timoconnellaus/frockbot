import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../flock/avatar.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/sidebar.dart' show SidebarProfile;
import '../theme/caret.dart';
import '../theme/dialogs.dart';
import '../theme/document.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import '../voice/appearance.dart';
import 'model_picker.dart';
import 'voice_settings.dart';

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
  Future<bool> _voiceWrites = Future.value(false);
  Future<bool> _lookWrites = Future.value(false);

  /// Whether a read has landed. A Bot that has never been edited is at
  /// revision 0, so the revision cannot double as this.
  bool loaded = false;
  bool _closed = false;
  String? message;
  int revision = 0;
  int accountRevision = 0;

  /// The voice record's own revision. Voice is fenced separately from the
  /// profile (`/api/bots/:id/voice`), so a profile save never moves it and a
  /// voice save never moves [revision].
  int voiceRevision = 0;

  /// The look record's own revision, fenced like voice.
  int lookRevision = 0;

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

  /// Where the sidebar draws the Bot. This page never changes it — a drag on
  /// the list does — but it saves the whole profile, so it carries the value
  /// it read rather than saving the Bot back to the end of its group.
  int? sidebarOrder;
  bool notifications = true;

  /// How this Bot sounds (ADR 0031), or null when it has chosen nothing and
  /// speaks in its character's default voice.
  BotVoiceAppearanceV1? voice;

  /// Inherit the account look, or Studio for this thread.
  BotLook look = BotLook.inherit;

  /// The Bot's model override, as the `custom-models` Package stores it, and
  /// null when this Bot follows the account model.
  Object? model;
  bool modelAvailable = false;

  /// What the Plugins row says under its name: how many this Bot runs and
  /// which. Null until the read lands, or where it could not be read — the row
  /// is still the door, it just says nothing it does not know.
  String? pluginsSummary;

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
      sidebarOrder = (profile['sidebarOrder'] as num?)?.toInt();
      notifications =
          ((answer['notifications'] as Map?)?['enabled'] ?? true) == true;
      // The voice has its own record and revision beside the profile; an
      // absent `voice` means the Bot speaks in its character's default.
      final voiceAnswer = (await api.request('/api/bots/$botId/voice'))! as Map;
      voiceRevision = (voiceAnswer['revision'] as num?)?.toInt() ?? 0;
      voice = BotVoiceAppearanceV1.fromJson(voiceAnswer['voice']);
      final lookAnswer = (await api.request('/api/bots/$botId/look'))! as Map;
      lookRevision = (lookAnswer['revision'] as num?)?.toInt() ?? 0;
      look = parseBotLook(lookAnswer['look'] as String?);
      model =
          ((answer['packageValues'] as Map?)?['custom-models']
              as Map?)?['model'];
      loaded = true;
      loads += 1;
      _saved = _profileBody(pinnedAt);
      _savedNotifications = notifications;
      _savedModel = model;
      await _loadAccount();
      await _loadPlugins();
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

  /// What this Bot runs, for the Plugins row's own line. The Plugins surface
  /// is the authority on it; this is the same read without the document.
  Future<void> _loadPlugins() async {
    try {
      final answer = (await api.request('/api/bots/$botId/plugins'))! as Map;
      pluginsSummary = botPluginsSummaryV1([
        for (final row in (answer['plugins'] as List? ?? const []))
          if (row is Map && row['on'] == true)
            row['displayName'] as String? ?? '',
      ]);
    } catch (_) {
      pluginsSummary = null;
    }
  }

  /// Re-reads the Plugins line after the Plugins surface changed what this Bot
  /// runs, so the row that summarises them cannot outlive the change.
  Future<void> refreshPlugins() async {
    if (!loaded) return;
    await _loadPlugins();
    _changed();
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
    if (sidebarOrder case final int order) 'sidebarOrder': order,
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
    sidebarOrder: (body['sidebarOrder'] as num?)?.toInt(),
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

  /// Hiding a Bot mutes it: the authority turns notifications off in the same
  /// write, so the switch is drawn off now and no second command is sent.
  /// Showing it again leaves notifications where hiding put them.
  void setHidden(bool next) {
    hidden = next;
    if (next) notifications = false;
  }

  /// A hide the authority has not accepted goes back to what it holds. Which
  /// that is cannot be guessed from here: a hiding write can land and its
  /// answer be lost, leaving the authority hidden and muted while the client
  /// still believes neither. So the two switches the authority couples are
  /// re-read from it, and only a read that fails too falls back to the last
  /// values known to have landed.
  Future<void> _reconcileUnacceptedHide() async {
    if (!hidden || _saved['hiddenFromSidebar'] == true) return;
    try {
      final answer = (await api.request('/api/bots/$botId/settings'))! as Map;
      final settled = answer['revision'];
      if (settled is int) revision = settled;
      hidden = (answer['profile'] as Map)['hiddenFromSidebar'] == true;
      notifications =
          ((answer['notifications'] as Map?)?['enabled'] ?? true) == true;
      _saved = {..._saved, 'hiddenFromSidebar': hidden};
      _savedNotifications = notifications;
    } catch (_) {
      hidden = false;
      notifications = _savedNotifications;
    }
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
  /// into would replace their text with the server's copy of it. The one
  /// exception is a failed save that may have hidden the Bot: see
  /// [_reconcileUnacceptedHide], which re-reads the two switches the authority
  /// couples because their landed values cannot be guessed from here.
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
        if (profile['hiddenFromSidebar'] == true) _savedNotifications = false;
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
      await _reconcileUnacceptedHide();
      return false;
    } catch (_) {
      message = 'Couldn’t save these settings. Try again.';
      await _reconcileUnacceptedHide();
      return false;
    } finally {
      saving = false;
      _changed();
    }
  }

  /// How this Bot sounds, saved as the person changes it.
  ///
  /// One command, fenced like every other configuration write. It is its own
  /// save rather than part of [save] because the voice page is a page of its
  /// own: nothing else on it can be dirty at the same time.
  ///
  /// The voice page saves on every tap, so a second choice made while the
  /// first is still in flight queues behind it rather than being dropped.
  Future<bool> saveVoice(BotVoiceAppearanceV1 next) {
    final write = _voiceWrites.then((_) => _writeVoice(next));
    _voiceWrites = write;
    return write;
  }

  Future<bool> _writeVoice(BotVoiceAppearanceV1 next) async {
    saving = true;
    message = null;
    final previous = voice;
    voice = next;
    _changed();
    try {
      await _voiceCommand({
        'schemaVersion': 1,
        'type': 'bot/update-voice',
        'commandId': randomId(),
        'botId': botId,
        'voice': next.toJson(),
      });
      message = 'Saved.';
      return true;
    } on RequestFailure catch (failure) {
      voice = previous;
      message = failure.message;
      return false;
    } catch (_) {
      voice = previous;
      message = 'Couldn’t save this Bot’s voice. Try again.';
      return false;
    } finally {
      saving = false;
      _changed();
    }
  }

  /// This Bot's look, saved as the person changes it. Fenced on its own
  /// revision like the voice, so a profile save never races it.
  Future<bool> saveLook(BotLook next) {
    final write = _lookWrites.then((_) => _writeLook(next));
    _lookWrites = write;
    return write;
  }

  Future<bool> _writeLook(BotLook next) async {
    saving = true;
    message = null;
    final previous = look;
    look = next;
    _changed();
    try {
      await _lookCommand({
        'schemaVersion': 1,
        'type': 'bot/update-look',
        'commandId': randomId(),
        'botId': botId,
        'look': next == BotLook.studio ? 'studio' : 'inherit',
      });
      message = 'Saved.';
      return true;
    } on RequestFailure catch (failure) {
      look = previous;
      message = failure.message;
      return false;
    } catch (_) {
      look = previous;
      message = 'Couldn’t save this Bot’s look. Try again.';
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

  /// The voice's own fenced write, to its own route, with the same one
  /// re-fence on conflict as [_command].
  Future<void> _voiceCommand(Map<String, Object?> command) async {
    Future<Map<String, Object?>> send() async {
      final answer = await api.request(
        '/api/bots/$botId/voice',
        body: {...command, 'expectedRevision': voiceRevision},
      );
      return (answer! as Map).cast<String, Object?>();
    }

    Map<String, Object?> receipt;
    try {
      receipt = await send();
    } on RequestFailure catch (failure) {
      if (failure.status != 409) rethrow;
      final current = (await api.request('/api/bots/$botId/voice'))! as Map;
      voiceRevision = (current['revision'] as num?)?.toInt() ?? voiceRevision;
      receipt = await send();
    }
    final settled = receipt['revision'];
    if (settled is int) voiceRevision = settled;
    if (receipt['status'] != 'rejected') return;
    final failure = receipt['failure'];
    throw RequestFailure(
      failure is String
          ? failure
          : 'Couldn’t save this Bot’s voice. Try again.',
    );
  }

  /// The look's own fenced write, to `/api/bots/:id/look`.
  Future<void> _lookCommand(Map<String, Object?> command) async {
    Future<Map<String, Object?>> send() async {
      final answer = await api.request(
        '/api/bots/$botId/look',
        body: {...command, 'expectedRevision': lookRevision},
      );
      return (answer! as Map).cast<String, Object?>();
    }

    Map<String, Object?> receipt;
    try {
      receipt = await send();
    } on RequestFailure catch (failure) {
      if (failure.status != 409) rethrow;
      final current = (await api.request('/api/bots/$botId/look'))! as Map;
      lookRevision = (current['revision'] as num?)?.toInt() ?? lookRevision;
      receipt = await send();
    }
    final settled = receipt['revision'];
    if (settled is int) lookRevision = settled;
    if (receipt['status'] != 'rejected') return;
    final failure = receipt['failure'];
    throw RequestFailure(
      failure is String
          ? failure
          : 'Couldn’t save this Bot’s look. Try again.',
    );
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

/// What the Plugins row says about what this Bot runs.
String botPluginsSummaryV1(List<String> on) {
  final names = [
    for (final name in on)
      if (name.isNotEmpty) name,
  ];
  if (names.isEmpty) return 'None on';
  return '${names.length} on · ${names.join(', ')}';
}

/// What the Model row says about the choice this Bot is on.
String botModelLabelV1(Object? model) {
  if (model == null) return 'Follows the account model';
  if (model is String) return model;
  if (model is Map) {
    for (final key in const ['label', 'name', 'model', 'id']) {
      final value = model[key];
      if (value is String && value.isNotEmpty) return value;
    }
  }
  return jsonEncode(model);
}

/// One Bot's Settings: what it is, rather than what it is doing.
///
/// Reached only from the gear on the Bot page, at every width. One grammar all
/// the way down — a section label over a card of rows, the About fields on a
/// card of their own — so nothing sits bare on the page but the labels and the
/// line that says what became of the last write.
///
/// There is no Save button. A switch is written the moment it is flipped and a
/// field a moment after the person stops typing, which is what a settings page
/// on a phone is expected to do; the one thing the surface says about it is a
/// status line, so a write that failed is never silent.
class BotSettingsView extends StatefulWidget {
  final BotSettingsController controller;
  final Future<void> Function()? onSaved;

  /// Draws a profile change where the Bot is listed — its tile, its group, its
  /// name — the moment it is made, and is handed the last accepted profile
  /// again if the authority refuses the save. Only values this client computed
  /// and is about to send are predicted.
  final void Function(SidebarProfile profile)? onPredict;

  /// The package settings cards the host mounts, drawn between Capabilities
  /// and Danger — each Package's own section, in the same card grammar.
  final List<Widget> sections;

  /// This Bot's avatar, so the avatar here is the one the sidebar draws.
  final String? background;
  final String? primary;

  /// Opens the character picker. The Flock owns what a Bot looks like, so the
  /// settings surface offers the gesture and nothing else.
  final VoidCallback? onEditAvatar;

  /// Opens this Bot's Plugins, which is a page of its own: the row here says
  /// what is on and the way in, and the switches live there.
  final VoidCallback? onOpenPlugins;

  /// Archiving, restoring and deleting belong to the Flock, whose directory
  /// they change, so the card is handed in rather than rebuilt here. It is
  /// built in `lib/flock/lifecycle.dart`, which owns that seam.
  final Widget? dangerZone;
  const BotSettingsView({
    super.key,
    required this.controller,
    this.onSaved,
    this.onPredict,
    this.background,
    this.primary,
    this.onEditAvatar,
    this.onOpenPlugins,
    this.dangerZone,
    this.sections = const [],
  });

  @override
  State<BotSettingsView> createState() => _BotSettingsViewState();
}

class _BotSettingsViewState extends State<BotSettingsView> {
  final form = GlobalKey<FormState>();
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
    predict?.call(state.predictedProfile());
    final saved = await state.save();
    // Where the sidebar goes back to if this save is refused: what the
    // authority is known to hold once the save has settled that question,
    // which is not what it held before a hide that landed unanswered.
    if (!saved) predict?.call(state.savedProfile);
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
    bool last = false,
  }) => identified(
    id,
    Padding(
      padding: EdgeInsets.only(bottom: last ? 0 : 12),
      child: SteadyCaret(
        child: TextFormField(
          key: ValueKey('$id.${state.loads}'),
          initialValue: value,
          minLines: lines,
          maxLines: lines,
          maxLength: maxLength,
          // The counter is news only as the budget runs out; a "7/100" under
          // every name is a ledger nobody asked for.
          decoration: InputDecoration(labelText: label, hintText: hint),
          buildCounter:
              (
                context, {
                required currentLength,
                required isFocused,
                required maxLength,
              }) => maxLength != null && currentLength >= maxLength * 0.9
              ? Text(
                  '$currentLength/$maxLength',
                  style: Theme.of(context).textTheme.bodySmall,
                )
              : null,
          onChanged: (next) => _typed(() => onChanged(next)),
          validator: required
              ? (next) => (next ?? '').trim().isEmpty
                    ? 'Enter a name for this Bot.'
                    : null
              : null,
        ),
      ),
    ),
  );

  /// One behaviour: a glyph, what it is called, what flipping it also does,
  /// and the switch at the end of the row.
  Widget _switchRow({
    required String id,
    required IconData icon,
    required String title,
    String? subtitle,
    required bool value,
    required void Function(bool) onChanged,
    bool enabled = true,
    Future<bool> Function(bool next)? confirm,
  }) {
    Future<void> flip(bool next) async {
      if (confirm != null && !await confirm(next)) return;
      if (mounted) _chose(() => onChanged(next));
    }

    // The identifier is the switch's, not the row's: a row whose own press is
    // refused has nothing but the switch left to carry a node, and an id that
    // moved between the two as the row enabled and disabled is an id no spec
    // could select on twice.
    return FrockRow(
      icon: icon,
      title: title,
      subtitle: subtitle,
      chevron: false,
      onTap: enabled ? () => unawaited(flip(!value)) : null,
      trailing: identified(
        id,
        Semantics(
          label: subtitle ?? title,
          child: Switch(
            value: value,
            onChanged: enabled ? (next) => unawaited(flip(next)) : null,
          ),
        ),
      ),
    );
  }

  /// Hiding a Bot that notifies turns its notifications off, so the person is
  /// told before it happens. A Bot already muted has nothing to warn about.
  Future<bool> _confirmHide(bool next) async {
    if (!next || !state.notifications) return true;
    return await showDialog<bool>(
          context: context,
          builder: (dialog) => identified(
            SettingsIds.botHideConfirm,
            AlertDialog(
              insetPadding: frockDialogInset,
              title: frockDialogTitle(const Text('Hide this Bot?')),
              content: frockDialogBody(
                const Text(
                  'Hiding this Bot from the sidebar also turns off its notifications. Its new messages still show as unread.',
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialog, false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(dialog, true),
                  child: const Text('Hide and turn off'),
                ),
              ],
            ),
          ),
        ) ??
        false;
  }

  Future<void> _saveLook(BotLook next) async {
    final saved = await state.saveLook(next);
    if (saved) await widget.onSaved?.call();
  }

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
      final theme = Theme.of(context);
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
              _character(context),
              const FrockSectionLabel('About'),
              Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
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
                      _field(
                        id: SettingsIds.botTitle,
                        label: 'Title',
                        hint: 'Chief of staff, night-shift researcher',
                        value: state.title,
                        maxLength: 120,
                        onChanged: (next) => state.title = next,
                      ),
                      _field(
                        id: SettingsIds.botDescription,
                        label: 'Description',
                        value: state.description,
                        maxLength: 10000,
                        lines: 4,
                        last: true,
                        onChanged: (next) => state.description = next,
                      ),
                    ],
                  ),
                ),
              ),
              const FrockSectionLabel('Behaviour'),
              FrockRowGroup(
                rows: [
                  _switchRow(
                    id: SettingsIds.botPinned,
                    icon: Icons.push_pin_outlined,
                    title: 'Pinned',
                    value: state.pinned,
                    onChanged: (next) => state.pinned = next,
                  ),
                  _switchRow(
                    id: SettingsIds.botNotifications,
                    icon: Icons.notifications_none_rounded,
                    title: 'Notifications',
                    subtitle: state.hidden
                        ? 'Off while this Bot is hidden from the sidebar. Show it in the sidebar to turn notifications on.'
                        : null,
                    value: state.notifications,
                    enabled: !state.hidden,
                    onChanged: (next) => state.notifications = next,
                  ),
                  _switchRow(
                    id: SettingsIds.botHidden,
                    icon: Icons.visibility_off_outlined,
                    title: 'Hidden from list',
                    subtitle: 'Also turns notifications off',
                    value: state.hidden,
                    confirm: _confirmHide,
                    onChanged: state.setHidden,
                  ),
                ],
              ),
              const FrockSectionLabel('Capabilities'),
              FrockRowGroup(
                rows: [
                  if (widget.onOpenPlugins case final VoidCallback open)
                    identified(
                      SettingsIds.botPlugins,
                      FrockRow(
                        icon: Icons.extension_outlined,
                        title: 'Plugins',
                        subtitle: state.pluginsSummary,
                        onTap: open,
                      ),
                    ),
                  // How this Bot sounds (ADR 0031): its own page, because
                  // the presets are a surface of their own and the row says
                  // enough.
                  botVoiceRow(
                    context,
                    controller: state,
                    characterId: widget.background,
                    primary: widget.primary,
                  ),
                  identified(
                    SettingsIds.botLook,
                    FrockRow(
                      icon: Icons.palette_outlined,
                      title: 'Look',
                      chevron: false,
                      trailing: FittedBox(
                        child: SegmentedButton<BotLook>(
                          showSelectedIcon: false,
                          style: const ButtonStyle(
                            visualDensity: VisualDensity.compact,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                          segments: const [
                            ButtonSegment(
                              value: BotLook.inherit,
                              label: Text('Inherit'),
                            ),
                            ButtonSegment(
                              value: BotLook.studio,
                              label: Text('Studio'),
                            ),
                          ],
                          selected: {state.look},
                          onSelectionChanged: (next) =>
                              unawaited(_saveLook(next.single)),
                        ),
                      ),
                    ),
                  ),
                  if (state.modelAvailable) _model(context),
                ],
              ),
              ...widget.sections,
              if (widget.dangerZone case final Widget zone) ...[
                FrockSectionLabel(
                  'Danger',
                  padding: const EdgeInsets.fromLTRB(12, 18, 4, 6),
                  color: theme.colorScheme.error,
                ),
                zone,
              ],
              _status(context),
            ],
          ),
        ),
      );
    },
  );

  /// The face at the top of the page, and the one gesture that changes it.
  Widget _character(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      SettingsIds.botAvatar,
      InkWell(
        onTap: widget.onEditAvatar,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 16, 0, 4),
          child: Column(
            children: [
              CharacterAvatar(
                size: 76,
                characterId: widget.background,
                primary: widget.primary,
                // A preview at rest; the panel can stay open for an hour and
                // an idle loop here repaints the window.
                motion: CharacterMotion.quiet,
              ),
              const SizedBox(height: 10),
              Text(
                widget.onEditAvatar == null
                    ? '${state.name.isEmpty ? 'This Bot' : state.name} avatar'
                    : 'Change character',
                style: theme.textTheme.labelMedium?.copyWith(
                  fontSize: 12.5,
                  color: widget.onEditAvatar == null
                      ? theme.colorScheme.onSurfaceVariant
                      : theme.colorScheme.primary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// What the surface says about writing: nothing until something has been
  /// saved, then the one word, and a failure in the authority's own words.
  Widget _status(BuildContext context) {
    final text = state.saving ? 'Saving…' : state.message;
    final failed =
        !state.saving && state.message != null && state.message != 'Saved.';
    return identified(
      SettingsIds.botSaveStatus,
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 14, 4, 8),
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
    FrockRow(
      icon: Icons.memory_rounded,
      title: 'Model',
      subtitle: botModelLabelV1(state.model),
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
  );
}
