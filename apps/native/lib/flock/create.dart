/// Adding a Bot to the flock, and changing how one looks.
///
/// `FlockOverlay.vue`'s two halves on this app's terms: a name, the sheep, and
/// — because a new Bot with nothing to do is a blank screen — the first thing
/// to say to it; and, from Bot settings, the same sheep again for a Bot that
/// already exists. The wardrobe's other three selects are in neither:
/// wearables are deferred (`docs/plan.md`), so the background is the whole of
/// the choice and every band stays at the catalogue's neutral root.
///
/// The create command is written to the durable store before it is sent and
/// cleared only once the authority has answered it, which is what makes a lost
/// reply a retry of the same `commandId` rather than a second Bot. Changing a
/// colour needs none of that: it is one small idempotent write, fenced on the
/// Bot's own sheep revision, and losing it costs a person one more tap.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';

import 'sheep.dart';

/// A Bot id from the name a person typed, with a suffix so two Bots called the
/// same thing are two Bots. The rule is `FlockOverlay`'s, minus its Unicode
/// fold: a letter outside a-z is dropped rather than turned into its nearest
/// ASCII one, because an id is opaque and the name is what a person reads.
String botIdFromNameV1(String name, {String? suffix}) {
  final slug = name
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  final stem = (slug.isEmpty ? 'bot' : slug);
  return '${stem.substring(0, min(stem.length, 80))}-${suffix ?? randomId().substring(0, 8)}';
}

/// What a finished create hands back: the Bot, and what to say to it first.
typedef CreatedBotV1 = ({String botId, String firstMessage});

class CreateBotController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  CreateBotController(this.api, this.store, this.userId);

  String name = '';
  String firstMessage = '';
  String background = defaultSheepBackgroundV1;
  bool busy = false;
  String? message;
  bool _closed = false;

  String get _key => 'bot-create.$userId';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  void edit(void Function() change) {
    change();
    _changed();
  }

  /// A different sheep, from the backgrounds this build carries.
  void reroll() {
    final ids = sheepBackgroundsV1.keys.toList();
    edit(() => background = ids[Random().nextInt(ids.length)]);
  }

  /// Restores a create whose reply never arrived, so the person is offered the
  /// Bot they already asked for rather than a second one.
  Future<void> restore() async {
    final saved = await store.read(_key);
    if (saved == null || _closed) return;
    final command = (jsonDecode(saved) as Map).cast<String, Object?>();
    wire.BotCreateCommand.fromJson(command);
    edit(() {
      name = command['name']! as String;
      background =
          ((command['sheep'] as Map?)?['background'] as String?) ?? background;
      message = 'This Bot was already asked for. Create it again to finish.';
    });
  }

  /// Creates the Bot, fencing on the directory revision the authority holds
  /// right now rather than one this screen read when it opened.
  ///
  /// A conflict is not a failure: another device added a Bot while this form
  /// was open, so the command is re-fenced against the revision the 409
  /// reported and sent once more, under the same id.
  Future<CreatedBotV1?> create() async {
    if (busy || _closed) return null;
    busy = true;
    message = null;
    _changed();
    try {
      final saved = await store.read(_key);
      var command = saved == null
          ? <String, Object?>{
              'schemaVersion': 1,
              'type': 'bot/create',
              'commandId': randomId(),
              'expectedRevision': await _revision(),
              'botId': botIdFromNameV1(name.trim()),
              'name': name.trim(),
              'sheep': defaultSheepRecipeV1(background),
            }
          : (jsonDecode(saved) as Map).cast<String, Object?>();
      wire.BotCreateCommand.fromJson(command);
      await store.write(_key, jsonEncode(command));
      var receipt = await _send(command);
      if (receipt == null) {
        command = {...command, 'expectedRevision': await _revision()};
        await store.write(_key, jsonEncode(command));
        receipt = await _send(command);
      }
      if (receipt == null) {
        message = 'Your Bots changed while you were typing. Try again.';
        return null;
      }
      if (receipt.status != 'applied') {
        // A refusal is definitive — the name is taken, or the flock is full —
        // so the retained command goes rather than being offered again.
        await store.delete(_key);
        message = receipt.failure ?? 'Couldn’t create the Bot.';
        return null;
      }
      await store.delete(_key);
      return (
        botId: command['botId']! as String,
        firstMessage: firstMessage.trim(),
      );
    } on RequestFailure catch (failure) {
      if (failure.refused) await store.delete(_key);
      message = failure.message;
      return null;
    } catch (_) {
      message =
          'Couldn’t confirm that. Open this again to finish creating the Bot.';
      return null;
    } finally {
      busy = false;
      _changed();
    }
  }

  /// The directory revision the create fences on, read fresh.
  Future<int> _revision() async => wire.BotDirectory.fromJson(
    await api.request('/api/bots'),
  ).revision;

  /// The receipt, or nothing when the authority says the revision moved.
  Future<wire.FlockReceipt?> _send(Map<String, Object?> command) async {
    try {
      return wire.FlockReceipt.fromJson(
        await api.request('/api/bots', body: command),
      );
    } on RequestFailure catch (failure) {
      if (failure.status == 409) return null;
      rethrow;
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// The create sheet. A sheep, a name, and the first thing to say.
class CreateBotSheet extends StatefulWidget {
  final CreateBotController controller;
  const CreateBotSheet({super.key, required this.controller});

  /// Opens the sheet and answers with the Bot that was made, or nothing.
  static Future<CreatedBotV1?> show(
    BuildContext context,
    CreateBotController controller,
  ) => showModalBottomSheet<CreatedBotV1>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheet) => Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(sheet).bottom,
      ),
      child: CreateBotSheet(controller: controller),
    ),
  );

  @override
  State<CreateBotSheet> createState() => _CreateBotSheetState();
}

class _CreateBotSheetState extends State<CreateBotSheet> {
  final form = GlobalKey<FormState>();

  CreateBotController get state => widget.controller;

  @override
  void initState() {
    super.initState();
    unawaited(state.restore());
  }

  Future<void> _create() async {
    if (!form.currentState!.validate()) return;
    final made = await state.create();
    if (made != null && mounted) Navigator.of(context).pop(made);
  }

  @override
  Widget build(BuildContext context) {
    final type = Theme.of(context).textTheme;
    return AnimatedBuilder(
      animation: state,
      builder: (context, _) => identified(
        FlockIds.createSheet,
        SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
            child: Form(
              key: form,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Center(
                    child: Column(
                      children: [
                        SheepAvatar(size: 96, background: state.background),
                        const SizedBox(height: 12),
                        Semantics(
                          header: true,
                          child: Text(
                            'Meet your sheep',
                            style: type.titleLarge,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Pick a colour, or take the one it came with.',
                          style: type.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  Center(
                    child: identified(
                      FlockIds.createBackground,
                      // Two rows of three rather than whatever fits: six
                      // choices laid out five-and-one reads as an accident.
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 236),
                        child: Wrap(
                          alignment: WrapAlignment.center,
                          spacing: 10,
                          runSpacing: 10,
                          children: [
                            for (final entry in sheepBackgroundsV1.entries)
                              _Swatch(
                                id: entry.key,
                                label: entry.value,
                                chosen: entry.key == state.background,
                                onTap: state.busy
                                    ? null
                                    : () => state.edit(
                                        () => state.background = entry.key,
                                      ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Center(
                    child: identified(
                      FlockIds.createReroll,
                      TextButton.icon(
                        onPressed: state.busy ? null : state.reroll,
                        icon: const Icon(Icons.casino_outlined),
                        label: const Text('Surprise me'),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  identified(
                    FlockIds.createName,
                    TextFormField(
                      initialValue: state.name,
                      enabled: !state.busy,
                      autofocus: true,
                      maxLength: 100,
                      textCapitalization: TextCapitalization.words,
                      decoration: const InputDecoration(labelText: 'Bot name'),
                      onChanged: (next) => state.edit(() => state.name = next),
                      validator: (next) => (next ?? '').trim().isEmpty
                          ? 'Give this Bot a name.'
                          : null,
                    ),
                  ),
                  identified(
                    FlockIds.createFirstMessage,
                    TextFormField(
                      initialValue: state.firstMessage,
                      enabled: !state.busy,
                      minLines: 3,
                      maxLines: 3,
                      maxLength: 4000,
                      decoration: const InputDecoration(
                        labelText: 'First message',
                        helperText:
                            'Optional. Sent as soon as the Bot is yours.',
                      ),
                      onChanged: (next) =>
                          state.edit(() => state.firstMessage = next),
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
                    FlockIds.createSubmit,
                    FilledButton(
                      onPressed: state.busy ? null : _create,
                      child: Text(state.busy ? 'Creating…' : 'Create Bot'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Changing an existing Bot's colour.
///
/// The one thing `FlockOverlay.vue`'s edit half still does under the
/// single-default-avatar rule. It is fenced on the revision the read just
/// reported rather than on one held since the sheet opened, because the sheet
/// is open for as long as somebody is looking at six sheep.
class SheepColourSheet extends StatefulWidget {
  final NativeApi api;
  final String botId;
  final String botName;
  const SheepColourSheet({
    super.key,
    required this.api,
    required this.botId,
    required this.botName,
  });

  /// Opens the sheet and answers with the colour that was saved, or nothing.
  static Future<String?> show(
    BuildContext context, {
    required NativeApi api,
    required String botId,
    required String botName,
  }) => showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (sheet) =>
        SheepColourSheet(api: api, botId: botId, botName: botName),
  );

  @override
  State<SheepColourSheet> createState() => _SheepColourSheetState();
}

class _SheepColourSheetState extends State<SheepColourSheet> {
  bool busy = false;
  String? message;

  String get _path => '/api/bots/${Uri.encodeComponent(widget.botId)}/sheep';

  Future<void> _choose(String background) async {
    if (busy) return;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final current = wire.SheepIdentity.fromJson(
        await widget.api.request(_path),
      );
      final receipt = wire.FlockReceipt.fromJson(
        await widget.api.request(
          _path,
          body: wire.BotSheepCommand.fromJson({
            'schemaVersion': 1,
            'type': 'bot/update-sheep',
            'commandId': randomId(),
            'expectedRevision': current.revision,
            'botId': widget.botId,
            'sheep': defaultSheepRecipeV1(background),
          }).toJson(),
        ),
      );
      if (receipt.status != 'applied') {
        throw FormatException(receipt.failure ?? 'refused');
      }
      if (mounted) Navigator.of(context).pop(background);
    } on RequestFailure catch (failure) {
      setState(() => message = failure.message);
    } catch (_) {
      setState(
        () => message = 'Couldn’t change this Bot’s colour. Try again.',
      );
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => identified(
    FlockIds.colourSheet,
    SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              header: true,
              child: Text(
                '${widget.botName}’s colour',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            const SizedBox(height: 16),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 236),
              child: Wrap(
                alignment: WrapAlignment.center,
                spacing: 10,
                runSpacing: 10,
                children: [
                  for (final entry in sheepBackgroundsV1.entries)
                    _Swatch(
                      id: entry.key,
                      label: entry.value,
                      chosen: false,
                      onTap: busy ? null : () => unawaited(_choose(entry.key)),
                    ),
                ],
              ),
            ),
            if (message != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Semantics(liveRegion: true, child: Text(message!)),
              ),
          ],
        ),
      ),
    ),
  );
}

/// One background, shown as the sheep wearing it rather than as a colour chip:
/// a person choosing an avatar should see the avatar.
class _Swatch extends StatelessWidget {
  final String id;
  final String label;
  final bool chosen;
  final VoidCallback? onTap;
  const _Swatch({
    required this.id,
    required this.label,
    required this.chosen,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) => Semantics(
    identifier: FlockIds.createBackgroundOption(id),
    button: true,
    selected: chosen,
    label: label,
    child: Tooltip(
      message: label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              width: 2,
              color: chosen
                  ? Theme.of(context).colorScheme.primary
                  : Colors.transparent,
            ),
          ),
          child: SheepAvatar(size: 58, background: id),
        ),
      ),
    ),
  );
}
