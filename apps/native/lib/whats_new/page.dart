/// What’s New: the curated list of what production shipped.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import '../theme/states.dart';
import 'feed.dart';
import 'mark.dart';

class WhatsNewPage extends StatefulWidget {
  final NativeApi api;
  final String origin;
  final WhatsNewFeed? feed;

  /// Last seen id when the page opened, so this visit still shows what was new.
  final String? seenId;
  final Future<void> Function(String id)? onSeen;

  /// Tests substitute a local still so the card does not hit the network.
  @visibleForTesting
  final ImageProvider Function(WhatsNewImage image)? stillFor;
  const WhatsNewPage({
    super.key,
    required this.api,
    required this.origin,
    this.feed,
    this.seenId,
    this.onSeen,
    this.stillFor,
  });

  @override
  State<WhatsNewPage> createState() => _WhatsNewPageState();
}

class _WhatsNewPageState extends State<WhatsNewPage> {
  WhatsNewFeed? feed;
  bool busy = true;
  late final String? seenWhenOpened = widget.seenId;

  @override
  void initState() {
    super.initState();
    feed = widget.feed;
    if (feed != null) {
      busy = false;
      _markSeen(feed!);
    } else {
      unawaitedLoad();
    }
  }

  void unawaitedLoad() {
    () async {
      final next = await readWhatsNewFeedV1(widget.api);
      if (!mounted) return;
      setState(() {
        feed = next;
        busy = false;
      });
      _markSeen(next);
    }();
  }

  void _markSeen(WhatsNewFeed next) {
    final id = next.newestId;
    if (id != null) unawaited(widget.onSeen?.call(id) ?? Future<void>.value());
  }

  @override
  Widget build(BuildContext context) {
    final entries = feed?.entries ?? const <WhatsNewEntry>[];
    final days = _byDay(entries);
    return Scaffold(
      appBar: DesktopHeader(child: AppBar(title: const Text('What’s New'))),
      body: identified(
        WhatsNewIds.page,
        busy
            ? const FrockLoading(label: 'Loading What’s New')
            : entries.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Text(
                    'When something ships that is worth a look, it lands here.',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              )
            : ListView.builder(
                padding: EdgeInsets.fromLTRB(
                  16,
                  4,
                  16,
                  32 + MediaQuery.paddingOf(context).bottom,
                ),
                itemCount: days.length,
                itemBuilder: (context, index) => Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 680),
                    child: _WhatsNewDay(
                      when: days[index].when,
                      entries: days[index].entries,
                      origin: widget.origin,
                      unread: (id) =>
                          feed?.isUnread(id, seenWhenOpened) ?? false,
                      stillFor: widget.stillFor,
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}

/// Consecutive entries that share a day, so the date is said once.
List<({String when, List<WhatsNewEntry> entries})> _byDay(
  List<WhatsNewEntry> entries,
) {
  final days = <({String when, List<WhatsNewEntry> entries})>[];
  for (final entry in entries) {
    final when = entry.when;
    if (days.isNotEmpty && days.last.when == when) {
      days.last.entries.add(entry);
    } else {
      days.add((when: when, entries: [entry]));
    }
  }
  return days;
}

/// One release day: its date over one card of what shipped.
class _WhatsNewDay extends StatelessWidget {
  final String when;
  final List<WhatsNewEntry> entries;
  final String origin;
  final bool Function(String id) unread;
  final ImageProvider Function(WhatsNewImage image)? stillFor;
  const _WhatsNewDay({
    required this.when,
    required this.entries,
    required this.origin,
    required this.unread,
    this.stillFor,
  });

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      FrockSectionLabel(
        when,
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
      ),
      Card(
        margin: EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var index = 0; index < entries.length; index++) ...[
              if (index > 0) const Divider(height: 1, indent: 16),
              _WhatsNewItem(
                entry: entries[index],
                origin: origin,
                unread: unread(entries[index].id),
                stillFor: stillFor,
              ),
            ],
          ],
        ),
      ),
    ],
  );
}

class _WhatsNewItem extends StatelessWidget {
  final WhatsNewEntry entry;
  final String origin;
  final bool unread;
  final ImageProvider Function(WhatsNewImage image)? stillFor;
  const _WhatsNewItem({
    required this.entry,
    required this.origin,
    required this.unread,
    this.stillFor,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final image = entry.image;
    return identified(
      WhatsNewIds.entry(entry.id),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Flexible(
                  child: Text(entry.title, style: theme.textTheme.titleMedium),
                ),
                if (unread) ...[
                  const SizedBox(width: 8),
                  const WhatsNewUnreadMark(),
                ],
              ],
            ),
            const SizedBox(height: 4),
            Text(
              entry.summary,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (image != null) ...[
              const SizedBox(height: 14),
              _WhatsNewStill(
                origin: origin,
                image: image,
                still: stillFor?.call(image),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _WhatsNewStill extends StatelessWidget {
  final String origin;
  final WhatsNewImage image;
  final ImageProvider? still;
  const _WhatsNewStill({required this.origin, required this.image, this.still});

  Widget _still(BuildContext context) {
    final theme = Theme.of(context);
    final radius = BorderRadius.circular(FrockTheme.radiusControl);
    // The stills are dark product UI; the line keeps one from reading as a
    // hole in the card.
    return Container(
      foregroundDecoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
      ),
      child: ClipRRect(
        borderRadius: radius,
        child: AspectRatio(
          aspectRatio: 16 / 9,
          child: Image(
            image: still ?? NetworkImage(whatsNewImageUrlV1(origin, image.src)),
            fit: BoxFit.cover,
            semanticLabel: image.alt,
            errorBuilder: (context, error, stack) => ColoredBox(
              color: theme.colorScheme.surface,
              child: Icon(
                Icons.image_not_supported_outlined,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
        onTap: () => showDialog<void>(
          context: context,
          builder: (dialogContext) => Dialog(
            insetPadding: const EdgeInsets.all(24),
            backgroundColor: Colors.transparent,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1200),
              child: GestureDetector(
                onTap: () => Navigator.of(dialogContext).pop(),
                child: _still(dialogContext),
              ),
            ),
          ),
        ),
        child: _still(context),
      ),
    );
  }
}
