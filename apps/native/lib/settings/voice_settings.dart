/// How one Bot sounds: the page under its settings (ADR 0031).
///
/// Gemini gives exactly one typed voice field and takes everything else as
/// prose, so this page has the same two halves: a timbre picked from the
/// thirty prebuilt voices, and a delivery described by presets. The presets
/// are stored as slugs and rendered into the instruction by the server, which
/// is why nothing here builds a sentence.
///
/// It saves as the About card does: the moment a choice is made, and a moment
/// after the last keystroke in the person's own words. There is no preview —
/// no endpoint speaks a sample yet — so the way to hear a change is to call.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../voice/appearance.dart';
import 'bot_settings.dart';

/// The row under the Bot's settings that opens this page.
class BotVoiceRow extends StatelessWidget {
  final BotSettingsController controller;
  final String? characterId;
  final String? primary;
  const BotVoiceRow({
    super.key,
    required this.controller,
    this.characterId,
    this.primary,
  });

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) => _row(context),
  );

  /// The line under the row is what the Bot sounds like now, so it follows
  /// every save rather than the values the page was built with.
  Widget _row(BuildContext context) {
    final voice = resolveBotVoiceV1(
      chosen: controller.voice,
      characterId: characterId,
    );
    return identified(
      VoiceIds.settingsRow,
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: FrockRowGroup(
          rows: [
            FrockRow(
              icon: Icons.graphic_eq_rounded,
              title: 'Voice',
              subtitle: voiceSummaryLineV1(voice),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => BotVoicePage(
                    controller: controller,
                    characterId: characterId,
                    primary: primary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class BotVoicePage extends StatefulWidget {
  final BotSettingsController controller;
  final String? characterId;
  final String? primary;
  const BotVoicePage({
    super.key,
    required this.controller,
    this.characterId,
    this.primary,
  });

  @override
  State<BotVoicePage> createState() => _BotVoicePageState();
}

class _BotVoicePageState extends State<BotVoicePage> {
  Timer? _pending;
  late String _custom =
      resolveBotVoiceV1(
        chosen: widget.controller.voice,
        characterId: widget.characterId,
      ).delivery.custom ??
      '';

  BotSettingsController get state => widget.controller;

  BotVoiceAppearanceV1 get _voice => resolveBotVoiceV1(
    chosen: state.voice,
    characterId: widget.characterId,
  );

  /// A choice: written now. The page is its own surface, so there is nothing
  /// else in flight to reconcile with.
  void _chose(BotVoiceAppearanceV1 next) {
    _pending?.cancel();
    _pending = null;
    unawaited(state.saveVoice(next));
  }

  /// The person's own words: written once typing pauses, like every other
  /// free-text field in settings.
  void _typed(String words) {
    _custom = words;
    _pending?.cancel();
    _pending = Timer(botSettingsAutosaveDelay, () {
      _pending = null;
      _chose(
        _voice.copyWith(delivery: _voice.delivery.copyWith(custom: words)),
      );
    });
  }

  @override
  void dispose() {
    // Leaving the page is not losing the last sentence typed on it.
    if (_pending != null) {
      _pending!.cancel();
      _pending = null;
      unawaited(
        state.saveVoice(
          _voice.copyWith(delivery: _voice.delivery.copyWith(custom: _custom)),
        ),
      );
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Voice')),
    body: AnimatedBuilder(
      animation: state,
      builder: (context, _) {
        final voice = _voice;
        final theme = Theme.of(context);
        final timbre = findGeminiVoiceV1(voice.voiceName);
        return identified(
          VoiceIds.settings,
          ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              Row(
                children: [
                  CharacterAvatar(
                    size: 56,
                    characterId: widget.characterId,
                    primary: widget.primary,
                    motion: CharacterMotion.quiet,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          state.name.isEmpty ? 'This Bot' : state.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          voiceSummaryLineV1(voice),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            fontSize: 12.5,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const FrockSectionLabel('Voice'),
              FrockRowGroup(
                rows: [
                  identified(
                    VoiceIds.timbre,
                    FrockRow(
                      title: 'Timbre',
                      subtitle: 'One of 30 Gemini voices',
                      trailing: _value(
                        context,
                        timbre == null
                            ? voice.voiceName
                            : '${timbre.voiceName} · ${timbre.character}',
                      ),
                      onTap: () => unawaited(_pickTimbre(context, voice)),
                    ),
                  ),
                  identified(
                    VoiceIds.accent,
                    FrockRow(
                      title: 'Accent',
                      subtitle: 'The English it speaks',
                      trailing: _value(
                        context,
                        voicePresetLabelV1(
                              voiceAccentsV1,
                              voice.delivery.accent,
                            ) ??
                            'Not set',
                      ),
                      onTap: () => unawaited(
                        _pickPreset(
                          context,
                          title: 'Accent',
                          options: voiceAccentsV1,
                          selected: voice.delivery.accent,
                          onChosen: (slug) => _chose(
                            voice.copyWith(
                              delivery: voice.delivery.copyWith(accent: slug),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  identified(
                    VoiceIds.attitude,
                    FrockRow(
                      title: 'Attitude',
                      subtitle: 'How it comes across',
                      trailing: _value(
                        context,
                        voicePresetLabelV1(
                              voiceAttitudesV1,
                              voice.delivery.attitude,
                            ) ??
                            'Not set',
                      ),
                      onTap: () => unawaited(
                        _pickPreset(
                          context,
                          title: 'Attitude',
                          options: voiceAttitudesV1,
                          selected: voice.delivery.attitude,
                          onChosen: (slug) => _chose(
                            voice.copyWith(
                              delivery: voice.delivery.copyWith(attitude: slug),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const FrockSectionLabel('Delivery'),
              FrockRowGroup(
                rows: [
                  _dial(
                    context,
                    id: VoiceIds.pace,
                    title: 'Pace',
                    options: voicePacesV1,
                    selected: voice.delivery.pace,
                    onChosen: (slug) => _chose(
                      voice.copyWith(
                        delivery: voice.delivery.copyWith(pace: slug),
                      ),
                    ),
                  ),
                  _dial(
                    context,
                    id: VoiceIds.turnLength,
                    title: 'Turn length',
                    options: voiceTurnLengthsV1,
                    selected: voice.delivery.turnLength,
                    onChosen: (slug) => _chose(
                      voice.copyWith(
                        delivery: voice.delivery.copyWith(turnLength: slug),
                      ),
                    ),
                  ),
                  _dial(
                    context,
                    id: VoiceIds.humour,
                    title: 'Humour',
                    options: voiceHumoursV1,
                    selected: voice.delivery.humour,
                    onChosen: (slug) => _chose(
                      voice.copyWith(
                        delivery: voice.delivery.copyWith(humour: slug),
                      ),
                    ),
                  ),
                  _dial(
                    context,
                    id: VoiceIds.disfluency,
                    title: 'Filler words',
                    options: voiceDisfluenciesV1,
                    selected: voice.delivery.disfluency,
                    onChosen: (slug) => _chose(
                      voice.copyWith(
                        delivery: voice.delivery.copyWith(disfluency: slug),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              identified(
                VoiceIds.custom,
                SteadyCaret(
                  child: TextFormField(
                    key: ValueKey('voice-custom.${state.loads}'),
                    initialValue: _custom,
                    minLines: 3,
                    maxLines: 5,
                    maxLength: voiceCustomMaxCharsV1,
                    decoration: const InputDecoration(
                      labelText: 'In your own words',
                      helperText:
                          'Read to the Bot before every call, after the presets. Yours wins a tie.',
                      helperMaxLines: 3,
                    ),
                    onChanged: _typed,
                  ),
                ),
              ),
              _status(context),
            ],
          ),
        );
      },
    ),
  );

  Widget _value(BuildContext context, String text) => ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 190),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      textAlign: TextAlign.right,
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
        fontSize: 13,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    ),
  );

  Widget _dial(
    BuildContext context, {
    required String id,
    required String title,
    required List<VoicePresetV1> options,
    required String? selected,
    required void Function(String) onChosen,
  }) => identified(
    id,
    FrockRow(
      title: title,
      chevron: false,
      trailing: _Segmented(
        options: options,
        selected: selected,
        label: title,
        onChosen: onChosen,
      ),
    ),
  );

  Future<void> _pickTimbre(
    BuildContext context,
    BotVoiceAppearanceV1 voice,
  ) async {
    final chosen = await pickVoiceOptionV1(
      context,
      title: 'Timbre',
      options: [
        for (final option in geminiVoicesV1)
          (
            slug: option.voiceName,
            label: option.voiceName,
            detail: option.character,
          ),
      ],
      selected: voice.voiceName,
    );
    if (chosen != null) _chose(voice.copyWith(voiceName: chosen));
  }

  Future<void> _pickPreset(
    BuildContext context, {
    required String title,
    required List<VoicePresetV1> options,
    required String? selected,
    required void Function(String) onChosen,
  }) async {
    final chosen = await pickVoiceOptionV1(
      context,
      title: title,
      options: [
        for (final option in options)
          (slug: option.slug, label: option.label, detail: null),
      ],
      selected: selected,
    );
    if (chosen != null) onChosen(chosen);
  }

  /// What the page says about writing: the one word, and a failure in the
  /// authority's own words.
  Widget _status(BuildContext context) {
    final text = state.saving ? 'Saving…' : state.message;
    final failed =
        !state.saving && state.message != null && state.message != 'Saved.';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Semantics(
        liveRegion: true,
        child: Text(
          text ?? '',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: failed
                ? Theme.of(context).colorScheme.error
                : Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// Three or four options at the end of a row, one of them on.
class _Segmented extends StatelessWidget {
  final List<VoicePresetV1> options;
  final String? selected;
  final String label;
  final void Function(String) onChosen;
  const _Segmented({
    required this.options,
    required this.selected,
    required this.label,
    required this.onChosen,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final option in options)
            Semantics(
              button: true,
              selected: option.slug == selected,
              label: '$label: ${option.label}',
              child: ExcludeSemantics(
                child: InkWell(
                  onTap: () => onChosen(option.slug),
                  borderRadius: BorderRadius.circular(9),
                  child: Container(
                    height: 30,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: option.slug == selected
                          ? scheme.primary.withValues(alpha: 0.18)
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text(
                      option.label,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(
                        fontSize: 12.5,
                        color: option.slug == selected
                            ? scheme.primary
                            : scheme.onSurfaceVariant,
                        fontWeight: option.slug == selected
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

typedef VoicePickerOptionV1 = ({String slug, String label, String? detail});

/// One list of options, as the character picker offers its cast: a dialog
/// where there is room beside the page, a sheet where there is not.
Future<String?> pickVoiceOptionV1(
  BuildContext context, {
  required String title,
  required List<VoicePickerOptionV1> options,
  required String? selected,
}) {
  final list = _VoiceOptionList(
    title: title,
    options: options,
    selected: selected,
  );
  if (MediaQuery.sizeOf(context).width < 640) {
    return showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: SizedBox(height: MediaQuery.sizeOf(sheet).height * 0.7, child: list),
      ),
    );
  }
  return showDialog<String>(
    context: context,
    builder: (dialog) => Dialog(
      child: SizedBox(width: 400, height: 520, child: list),
    ),
  );
}

class _VoiceOptionList extends StatelessWidget {
  final String title;
  final List<VoicePickerOptionV1> options;
  final String? selected;
  const _VoiceOptionList({
    required this.title,
    required this.options,
    required this.selected,
  });

  @override
  Widget build(BuildContext context) => identified(
    VoiceIds.picker,
    Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 12),
            itemCount: options.length,
            itemBuilder: (context, index) {
              final option = options[index];
              final chosen = option.slug == selected;
              return FrockRow(
                title: option.label,
                subtitle: option.detail,
                chevron: false,
                color: chosen ? Theme.of(context).colorScheme.primary : null,
                trailing: chosen
                    ? const Icon(Icons.check_rounded, size: 18)
                    : null,
                onTap: () => Navigator.of(context).pop(option.slug),
              );
            },
          ),
        ),
      ],
    ),
  );
}
