/// How one Bot looks: the page under its settings.
///
/// Built-in looks are a list that grows; Custom is the document a Plugin
/// assembled. Inherit is not a skin — the thread and right panel use the
/// app Theme as-is.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../shell/semantics.dart';
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

class BotLookPage extends StatelessWidget {
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
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Look')),
    body: AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final theme = Theme.of(context);
        final custom = controller.lookDocument;
        return identified(
          LookIds.settings,
          ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              Row(
                children: [
                  CharacterAvatar(
                    size: 56,
                    characterId: characterId,
                    primary: primary,
                    motion: CharacterMotion.quiet,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          controller.name.isEmpty ? 'This Bot' : controller.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          botLookSummary(controller.look),
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
                        color: controller.look == option.look
                            ? theme.colorScheme.primary
                            : null,
                        trailing: controller.look == option.look
                            ? const Icon(Icons.check_rounded, size: 18)
                            : null,
                        onTap: () => unawaited(_chose(option.look)),
                      ),
                    ),
                  identified(
                    LookIds.option('custom'),
                    FrockRow(
                      title: 'Custom',
                      subtitle: custom == null
                          ? 'A Plugin that changes this Bot’s look appears here'
                          : 'What a Plugin assembled for this Bot',
                      chevron: false,
                      leading: _swatches(custom?.tokens, theme),
                      color: controller.look == BotLook.custom
                          ? theme.colorScheme.primary
                          : custom == null
                          ? theme.colorScheme.onSurfaceVariant
                          : null,
                      trailing: controller.look == BotLook.custom
                          ? const Icon(Icons.check_rounded, size: 18)
                          : null,
                      onTap: custom == null
                          ? null
                          : () => unawaited(_chose(BotLook.custom)),
                    ),
                  ),
                ],
              ),
              if (custom != null) ...[
                const FrockSectionLabel('Assembled'),
                identified(
                  LookIds.preview,
                  _AssembledLookPreview(document: custom),
                ),
              ],
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                child: Text(
                  'Inherit uses the app look. Named looks are this Bot’s own room. Custom is the document a Plugin wrote.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              _status(context, controller),
            ],
          ),
        );
      },
    ),
  );

  Future<void> _chose(BotLook next) async {
    final saved = await controller.saveLook(next);
    if (saved) await onSaved?.call();
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

  Widget _status(BuildContext context, BotSettingsController state) {
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

/// The document a Plugin assembled, painted in its own tokens so Custom is
/// where you see what it changed this Bot to.
class _AssembledLookPreview extends StatelessWidget {
  final ThemeDocument document;
  const _AssembledLookPreview({required this.document});

  @override
  Widget build(BuildContext context) {
    final painted = FrockTheme.fromDocument(document);
    return Theme(
      data: painted,
      child: Card(
        color: painted.colorScheme.surface,
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
              const SizedBox(height: 4),
              Text(
                'What a Plugin assembled for this Bot',
                style: painted.textTheme.bodySmall?.copyWith(
                  color: painted.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _dot(document.tokens.surfaces.window, painted),
                  const SizedBox(width: 8),
                  _dot(document.tokens.surfaces.surface, painted),
                  const SizedBox(width: 8),
                  _dot(document.tokens.surfaces.accent, painted),
                ],
              ),
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
}
