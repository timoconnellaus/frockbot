/// The chat between this Bot and one counterpart, read back.
///
/// A Bot's questions to another Bot, and the other Bot's questions to it, are
/// one conversation seen from this Bot's side, and this is where it is read:
/// every exchange in order, each request under the name that sent it and each
/// answer under the name that gave it. Nothing here is typed. The person
/// watches their Bots talk; they do not join in, and the view says so.
library;

import 'package:flutter/material.dart';

import '../flock/avatar.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'desktop_layout.dart';
import 'markdown.dart';
import 'semantics.dart';
import 'transcript.dart';

/// One side of the chat: a name and the character that goes with it.
class ExchangeParty {
  final String name;
  final String? background;
  final String? primary;
  const ExchangeParty({required this.name, this.background, this.primary});
}

class ExchangeView extends StatelessWidget {
  /// This Bot, whose thread the view was opened from.
  final ExchangeParty self;
  final ExchangeCounterpart counterpart;
  final String? counterpartBackground;
  final String? counterpartPrimary;

  /// Oldest first.
  final List<Exchange> exchanges;

  /// Whether the cloud holds exchanges older than these, and the way to
  /// ask for them.
  final bool hasEarlier;
  final bool loading;
  final String? error;
  final VoidCallback? onOlder;
  final VoidCallback? onClose;

  /// Off where the surface already carries a title of its own.
  final bool header;
  final void Function(String url)? onOpenLink;
  final DateTime? clock;
  const ExchangeView({
    super.key,
    required this.self,
    required this.counterpart,
    required this.exchanges,
    this.counterpartBackground,
    this.counterpartPrimary,
    this.hasEarlier = false,
    this.loading = false,
    this.error,
    this.onOlder,
    this.onClose,
    this.header = true,
    this.onOpenLink,
    this.clock,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final other = ExchangeParty(
      name: counterpart.label,
      background: counterpartBackground,
      primary: counterpartPrimary,
    );
    return identified(
      ShellIds.exchangeView,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (header) ...[
            DesktopWindowDragRegion(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: ExchangeTitle(
                        self: self,
                        counterpart: counterpart,
                        counterpartBackground: counterpartBackground,
                        counterpartPrimary: counterpartPrimary,
                      ),
                    ),
                    if (onClose != null)
                      identified(
                        ShellIds.exchangeViewClose,
                        IconButton(
                          tooltip: 'Close',
                          onPressed: onClose,
                          icon: const Icon(Icons.close),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const Divider(height: 1),
          ],
          Expanded(
            child: exchanges.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: loading
                          ? const FrockLoading(label: 'Loading this chat')
                          : Text(
                              error ??
                                  'Nothing between ${self.name} and '
                                      '${other.name} yet.',
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                              textAlign: TextAlign.center,
                            ),
                    ),
                  )
                : SingleChildScrollView(
                    reverse: true,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (hasEarlier)
                          Center(
                            child: TextButton(
                              onPressed: loading ? null : onOlder,
                              style: TextButton.styleFrom(
                                foregroundColor:
                                    theme.colorScheme.onSurfaceVariant,
                                textStyle: theme.textTheme.labelMedium,
                                minimumSize: const Size(0, 32),
                              ),
                              child: const Text('Earlier messages'),
                            ),
                          ),
                        if (error != null)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                            child: Text(
                              error!,
                              textAlign: TextAlign.center,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.error,
                              ),
                            ),
                          ),
                        for (final exchange in exchanges)
                          _ExchangeRows(
                            key: ValueKey('exchange:${exchange.id}'),
                            exchange: exchange,
                            self: self,
                            other: other,
                            onOpenLink: onOpenLink,
                            clock: clock,
                          ),
                      ],
                    ),
                  ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  Icons.lock_outline_rounded,
                  size: 14,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Text(
                  'This chat is view-only',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// "General ⇄ Xero Books", each with its face.
class ExchangeTitle extends StatelessWidget {
  final ExchangeParty self;
  final ExchangeCounterpart counterpart;
  final String? counterpartBackground;
  final String? counterpartPrimary;
  const ExchangeTitle({
    super.key,
    required this.self,
    required this.counterpart,
    this.counterpartBackground,
    this.counterpartPrimary,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.titleMedium;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        CharacterAvatar(
          size: 22,
          characterId: self.background,
          primary: self.primary,
          motion: CharacterMotion.quiet,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(self.name, style: style, overflow: TextOverflow.ellipsis),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Icon(
            Icons.swap_horiz_rounded,
            size: 18,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        CounterpartAvatar(
          counterpart: counterpart,
          background: counterpartBackground,
          primary: counterpartPrimary,
          size: 22,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            counterpart.label,
            style: style,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

/// One exchange: when, the request under its sender, the answer under its
/// author — or, in place of an answer, where the request stands.
class _ExchangeRows extends StatelessWidget {
  final Exchange exchange;
  final ExchangeParty self;
  final ExchangeParty other;
  final void Function(String url)? onOpenLink;
  final DateTime? clock;
  const _ExchangeRows({
    super.key,
    required this.exchange,
    required this.self,
    required this.other,
    this.onOpenLink,
    this.clock,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final outbound = exchange.direction == ExchangeDirection.outbound;
    final asker = outbound ? self : other;
    final answerer = outbound ? other : self;
    final when = formatExchangeTime(exchange.at, clock);
    final pending = switch (exchange.status) {
      ExchangeStatus.queued =>
        '${answerer.name} will answer once its current work is done.',
      ExchangeStatus.working => '${answerer.name} is working on it.',
      ExchangeStatus.stopped => 'Stopped before ${answerer.name} answered.',
      ExchangeStatus.failed => '${answerer.name} couldn’t answer.',
      ExchangeStatus.answered => null,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (when.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Center(
              child: Text(
                when,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant.withValues(
                    alpha: 0.8,
                  ),
                ),
              ),
            ),
          ),
        _ExchangeMessage(
          party: asker,
          voice: !outbound && exchange.counterpart.isVoice,
          text: exchange.request,
          onOpenLink: onOpenLink,
        ),
        if (exchange.reply != null)
          _ExchangeMessage(
            party: answerer,
            text: exchange.reply!,
            onOpenLink: onOpenLink,
          )
        else if (pending != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(52, 2, 16, 6),
            child: Text(
              pending,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }
}

/// A message under its author's name, with their face beside its foot. Every
/// message sits on the left: this is a chat between two others, read over
/// their shoulders, and neither side is "mine".
class _ExchangeMessage extends StatelessWidget {
  final ExchangeParty party;
  final bool voice;
  final String text;
  final void Function(String url)? onOpenLink;
  const _ExchangeMessage({
    required this.party,
    this.voice = false,
    required this.text,
    this.onOpenLink,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          voice
              ? const CounterpartAvatar(
                  counterpart: ExchangeCounterpart.voice(),
                  size: 26,
                )
              : CharacterAvatar(
                  size: 26,
                  characterId: party.background,
                  primary: party.primary,
                  motion: CharacterMotion.quiet,
                ),
          const SizedBox(width: 10),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.only(left: 4, bottom: 4),
                  child: Text(
                    party.name,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
                Container(
                  constraints: const BoxConstraints(maxWidth: 720),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 13,
                    vertical: 9,
                  ),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(18),
                      topRight: Radius.circular(18),
                      bottomLeft: Radius.circular(4),
                      bottomRight: Radius.circular(18),
                    ),
                  ),
                  child: DefaultTextStyle.merge(
                    style: FrockTheme.message(theme),
                    child: ShellMarkdown(text: text, onOpenLink: onOpenLink),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
