/// How one Bot looks: the page under its settings.
///
/// Built-in looks are a list that grows; Custom is this Bot's own tokens, which
/// a person can edit by hand. Inherit is not a skin — the thread and right
/// panel use the app Theme as-is.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../flock/avatar.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../theme/document.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import 'bot_settings.dart';

/// The Capabilities row that opens this page.
Widget botLookRow(
  BuildContext context, {
  required BotSettingsController controller,
  String? characterId,
  String? primary,
  Future<void> Function()? onSaved,
}) {
  return identified(
    SettingsIds.botLook,
    FrockRow(
      icon: Icons.palette_outlined,
      title: 'Look',
      subtitle: botLookSummary(controller.look),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => BotLookPage(
            controller: controller,
            characterId: characterId,
            primary: primary,
            onSaved: onSaved,
          ),
        ),
      ),
    ),
  );
}

class BotLookPage extends StatefulWidget {
  final BotSettingsController controller;
  final String? characterId;
  final String? primary;
  final Future<void> Function()? onSaved;
  const BotLookPage({
    super.key,
    required this.controller,
    this.characterId,
    this.primary,
    this.onSaved,
  });

  @override
  State<BotLookPage> createState() => _BotLookPageState();
}

class _BotLookPageState extends State<BotLookPage> {
  Timer? _pending;
  ThemeDocument? _draft;
  String? _localError;
  final Map<String, TextEditingController> _hex = {};

  BotSettingsController get state => widget.controller;

  @override
  void initState() {
    super.initState();
    final stored = state.lookDocument;
    if (state.look == BotLook.custom && stored != null) _bindDraft(stored);
  }

  @override
  void dispose() {
    final pending = _pending;
    _pending?.cancel();
    _pending = null;
    if (pending != null &&
        state.look == BotLook.custom &&
        _draft != null &&
        tokensMeetContrastFloor(_draft!.tokens)) {
      unawaited(state.saveLook(BotLook.custom, document: _draft));
    }
    for (final controller in _hex.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _bindDraft(ThemeDocument document) {
    _draft = document;
    for (final field in themeSurfaceFields) {
      final hex = encodeHexColor(document.tokens.surfaces.named(field.name));
      final controller = _hex.putIfAbsent(
        field.name,
        () => TextEditingController(),
      );
      if (controller.text != hex) controller.text = hex;
    }
  }

  ThemeDocument _seeded() {
    final stored = state.lookDocument;
    if (stored != null) return stored;
    return compileBotLook(
      look: state.look == BotLook.studio ? BotLook.studio : BotLook.inherit,
      account: AccountLook.system,
      platform: Theme.of(context).brightness,
    );
  }

  Future<void> _chose(BotLook next) async {
    _pending?.cancel();
    _pending = null;
    _localError = null;
    if (next != BotLook.custom) {
      _draft = null;
      final saved = await state.saveLook(next);
      if (saved) await widget.onSaved?.call();
      return;
    }
    final document = _draft ?? _seeded();
    setState(() => _bindDraft(document));
    if (state.look == BotLook.custom && state.lookDocument != null) return;
    final saved = await state.saveLook(BotLook.custom, document: document);
    if (saved) await widget.onSaved?.call();
  }

  void _typedHex(String name, String value) {
    _pending?.cancel();
    _pending = Timer(botSettingsAutosaveDelay, () => _applyHex(name, value));
  }

  void _applyHex(String name, String value) {
    final colour = parseHexColor(value.trim());
    final current = _draft;
    if (colour == null || current == null) return;
    _saveDraft(
      current.copyWith(
        tokens: current.tokens.copyWith(
          surfaces: current.tokens.surfaces.replacing(name, colour),
        ),
      ),
    );
  }

  void _setTokens(ThemeTokens tokens) {
    final current = _draft;
    if (current == null) return;
    _pending?.cancel();
    _pending = null;
    _saveDraft(current.copyWith(tokens: tokens));
  }

  Future<void> _saveDraft(ThemeDocument document) async {
    setState(() {
      _draft = document;
      _localError = null;
    });
    if (!tokensMeetContrastFloor(document.tokens)) {
      setState(
        () => _localError = 'Those colours don’t meet the contrast floor.',
      );
      return;
    }
    final saved = await state.saveLook(BotLook.custom, document: document);
    if (saved) await widget.onSaved?.call();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: DesktopHeader(child: AppBar(title: const Text('Look'))),
    body: AnimatedBuilder(
      animation: state,
      builder: (context, _) {
        final theme = Theme.of(context);
        final custom = _draft ?? state.lookDocument;
        final editing = state.look == BotLook.custom || _draft != null;
        return identified(
          LookIds.settings,
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
                          botLookSummary(state.look),
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
              const FrockSectionLabel('Looks'),
              FrockRowGroup(
                rows: [
                  for (final option in builtInBotLooks)
                    identified(
                      LookIds.option(option.look.name),
                      FrockRow(
                        title: option.title,
                        subtitle: option.subtitle,
                        chevron: false,
                        leading: _swatches(
                          option.look == BotLook.studio
                              ? ThemeDocument.studio.tokens
                              : null,
                          theme,
                        ),
                        color: state.look == option.look
                            ? theme.colorScheme.primary
                            : null,
                        trailing: state.look == option.look
                            ? const Icon(Icons.check_rounded, size: 18)
                            : null,
                        onTap: () => unawaited(_chose(option.look)),
                      ),
                    ),
                  identified(
                    LookIds.option('custom'),
                    FrockRow(
                      title: 'Custom',
                      subtitle: 'This Bot’s own tokens',
                      chevron: false,
                      leading: _swatches(custom?.tokens, theme),
                      color: state.look == BotLook.custom
                          ? theme.colorScheme.primary
                          : null,
                      trailing: state.look == BotLook.custom
                          ? const Icon(Icons.check_rounded, size: 18)
                          : null,
                      onTap: () => unawaited(_chose(BotLook.custom)),
                    ),
                  ),
                ],
              ),
              if (editing && custom != null) _editor(custom, theme),
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                child: Text(
                  'Inherit uses the app look. Named looks are this Bot’s own room. Custom is this Bot’s tokens — edit them here.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _status(context),
            ],
          ),
        );
      },
    ),
  );

  Widget _editor(ThemeDocument document, ThemeData theme) {
    final tokens = document.tokens;
    return identified(
      LookIds.editor,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const FrockSectionLabel('Custom'),
          identified(LookIds.preview, _CustomLookPreview(tokens: tokens)),
          const FrockSectionLabel('Colours'),
          FrockRowGroup(
            rows: [
              for (final field in themeSurfaceFields)
                identified(
                  LookIds.surface(field.name),
                  FrockRow(
                    title: field.label,
                    chevron: false,
                    leading: _dot(tokens.surfaces.named(field.name), theme),
                    trailing: SizedBox(
                      width: 92,
                      child: SteadyCaret(
                        child: TextField(
                          controller: _hex[field.name],
                          maxLength: 7,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontFamily: 'monospace',
                            fontSize: 13,
                            letterSpacing: 0,
                          ),
                          inputFormatters: [
                            FilteringTextInputFormatter.allow(
                              RegExp(r'[#0-9A-Fa-f]'),
                            ),
                          ],
                          decoration: const InputDecoration(
                            isDense: true,
                            counterText: '',
                            border: InputBorder.none,
                            hintText: '#000000',
                          ),
                          onChanged: (value) => _typedHex(field.name, value),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const FrockSectionLabel('Type'),
          FrockRowGroup(
            rows: [
              identified(
                LookIds.typeface,
                FrockRow(
                  title: 'Typeface',
                  chevron: false,
                  trailing: _segmented(
                    label: 'Typeface',
                    selected: tokens.type.name,
                    options: const [
                      (slug: 'manrope', label: 'Manrope'),
                      (slug: 'inter', label: 'Inter'),
                    ],
                    onChosen: (slug) => _setTokens(
                      tokens.copyWith(
                        type: slug == 'inter'
                            ? ThemeTypeface.inter
                            : ThemeTypeface.manrope,
                      ),
                    ),
                  ),
                ),
              ),
              identified(
                LookIds.botBubble,
                FrockRow(
                  title: 'Bot bubble',
                  chevron: false,
                  trailing: _segmented(
                    label: 'Bot bubble',
                    selected: tokens.botBubble.name,
                    options: const [
                      (slug: 'plain', label: 'Plain'),
                      (slug: 'raised', label: 'Raised'),
                    ],
                    onChosen: (slug) => _setTokens(
                      tokens.copyWith(
                        botBubble: slug == 'plain'
                            ? BotBubble.plain
                            : BotBubble.raised,
                      ),
                    ),
                  ),
                ),
              ),
              identified(
                LookIds.meBubble,
                FrockRow(
                  title: 'Me bubble',
                  chevron: false,
                  trailing: _segmented(
                    label: 'Me bubble',
                    selected: tokens.meBubble.name,
                    options: const [
                      (slug: 'accent', label: 'Accent'),
                      (slug: 'tint', label: 'Tint'),
                    ],
                    onChosen: (slug) => _setTokens(
                      tokens.copyWith(
                        meBubble: slug == 'tint'
                            ? MeBubble.tint
                            : MeBubble.accent,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _segmented({
    required String label,
    required String selected,
    required List<({String slug, String label})> options,
    required void Function(String) onChosen,
  }) {
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

  Widget? _swatches(ThemeTokens? tokens, ThemeData theme) {
    if (tokens == null) {
      return Icon(
        Icons.tonality_outlined,
        size: 20,
        color: theme.colorScheme.onSurfaceVariant,
      );
    }
    return SizedBox(
      width: 22,
      height: 22,
      child: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: theme.colorScheme.outlineVariant),
          gradient: SweepGradient(
            colors: [
              tokens.surfaces.window,
              tokens.surfaces.surface,
              tokens.surfaces.accent,
              tokens.surfaces.window,
            ],
          ),
        ),
      ),
    );
  }

  Widget _dot(Color color, ThemeData theme) => Container(
    width: 22,
    height: 22,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: theme.colorScheme.outlineVariant),
    ),
  );

  Widget _status(BuildContext context) {
    final text = _localError ?? (state.saving ? 'Saving…' : state.message);
    final failed =
        _localError != null ||
        (!state.saving && state.message != null && state.message != 'Saved.');
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

/// The Custom document painted in its own tokens so the person can see
/// the eight surfaces they are editing.
class _CustomLookPreview extends StatelessWidget {
  final ThemeTokens tokens;
  const _CustomLookPreview({required this.tokens});

  @override
  Widget build(BuildContext context) {
    final painted = FrockTheme.fromTokens(tokens);
    return Theme(
      data: painted,
      child: Card(
        color: painted.scaffoldBackgroundColor,
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Custom',
                style: painted.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  color: painted.colorScheme.onSurface,
                ),
              ),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: painted.colorScheme.surface,
                  borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
                  border: Border.all(color: painted.dividerColor),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'A line of text',
                      style: painted.textTheme.bodyMedium?.copyWith(
                        color: painted.colorScheme.onSurface,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Muted sits under it',
                      style: painted.textTheme.bodySmall?.copyWith(
                        color: painted.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Align(
                      alignment: Alignment.centerRight,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: painted.colorScheme.primary,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 6,
                          ),
                          child: Text(
                            'Me',
                            style: painted.textTheme.labelMedium?.copyWith(
                              color: painted.colorScheme.onPrimary,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
