/// What’s New: the curated list of what production shipped.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'feed.dart';

class WhatsNewPage extends StatefulWidget {
  final NativeApi api;
  final String origin;
  final WhatsNewFeed? feed;
  final Future<void> Function(String id)? onSeen;
  const WhatsNewPage({
    super.key,
    required this.api,
    required this.origin,
    this.feed,
    this.onSeen,
  });

  @override
  State<WhatsNewPage> createState() => _WhatsNewPageState();
}

class _WhatsNewPageState extends State<WhatsNewPage> {
  WhatsNewFeed? feed;
  bool busy = true;

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
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(title: const Text('What’s New')),
      ),
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
            : ListView.separated(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                itemCount: entries.length,
                separatorBuilder: (context, index) =>
                    const SizedBox(height: 16),
                itemBuilder: (context, index) => _WhatsNewCard(
                  entry: entries[index],
                  origin: widget.origin,
                ),
              ),
      ),
    );
  }
}

class _WhatsNewCard extends StatelessWidget {
  final WhatsNewEntry entry;
  final String origin;
  const _WhatsNewCard({required this.entry, required this.origin});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final image = entry.image;
    return identified(
      WhatsNewIds.entry(entry.id),
      Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                entry.when.toUpperCase(),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                entry.title,
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.2,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                entry.summary,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                  height: 1.35,
                ),
              ),
              if (image != null) ...[
                const SizedBox(height: 14),
                _WhatsNewStill(origin: origin, image: image),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _WhatsNewStill extends StatelessWidget {
  final String origin;
  final WhatsNewImage image;
  const _WhatsNewStill({required this.origin, required this.image});

  Widget _still(BuildContext context) {
    final theme = Theme.of(context);
    return ClipRRect(
      borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: Image.network(
          whatsNewImageUrlV1(origin, image.src),
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
    );
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: () => showDialog<void>(
          context: context,
          builder: (dialogContext) => Dialog(
            insetPadding: const EdgeInsets.all(24),
            backgroundColor: Colors.transparent,
            child: GestureDetector(
              onTap: () => Navigator.of(dialogContext).pop(),
              child: _still(dialogContext),
            ),
          ),
        ),
        child: _still(context),
      ),
    );
  }
}
