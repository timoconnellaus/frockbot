/// A Bot's setup history, at the foot of its Plugins page.
///
/// Every Composition generation this Bot has been set up with — the Plugin
/// code it wrote, and whether each version ran — newest first, with the code
/// itself a tap away. Read-only: a generation is superseded, never edited, and
/// nothing here changes which one runs.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/rows.dart';

/// How many generations one read asks for.
const _pageSize = 10;

class SetupHistorySection extends StatefulWidget {
  final NativeApi api;
  final String botId;
  const SetupHistorySection({
    super.key,
    required this.api,
    required this.botId,
  });

  @override
  State<SetupHistorySection> createState() => _SetupHistorySectionState();
}

class _SetupHistorySectionState extends State<SetupHistorySection> {
  List<Map<String, dynamic>>? generations;
  String? cursor;
  bool loading = false;
  String? error;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load({bool earlier = false}) async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    final botId = widget.botId;
    final after = earlier ? cursor : null;
    try {
      final query = Uri(
        queryParameters: {'limit': '$_pageSize', 'cursor': ?after},
      ).query;
      final page = Map<String, dynamic>.from(
        wire.SetupHistory.fromJson(
              await widget.api.request(
                '/api/bots/${Uri.encodeComponent(botId)}/composition/generations?$query',
              ),
            ).toJson()
            as Map,
      );
      final next = [
        for (final value in page['generations'] as List)
          Map<String, dynamic>.from(value as Map),
      ];
      // Another Bot's history, or a cursor that did not move, is not this
      // Bot's next page.
      if (page['botId'] != botId ||
          next.any((generation) => generation['botId'] != botId) ||
          (after != null && page['cursor'] == after)) {
        throw const FormatException('Mismatched setup history');
      }
      if (!mounted || widget.botId != botId) return;
      setState(() {
        generations = [if (earlier) ...?generations, ...next];
        cursor = page['cursor'] as String?;
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Couldn’t load setup history. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = generations;
    final List<Widget> rows;
    if (list == null && error != null) {
      rows = [
        FrockRow(
          icon: Icons.cloud_off_rounded,
          title: 'Setup history couldn’t load',
          subtitle: error,
          chevron: false,
          trailing: TextButton(
            onPressed: loading ? null : load,
            child: const Text('Try again'),
          ),
        ),
      ];
    } else if (list == null) {
      rows = [
        const FrockRow(
          icon: Icons.history_rounded,
          title: 'Loading setup history',
          chevron: false,
          trailing: SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      ];
    } else if (list.isEmpty) {
      rows = [
        const FrockRow(
          icon: Icons.history_rounded,
          title: 'No setup changes yet',
          subtitle:
              'When this Bot writes Plugin code, each version is kept here.',
          chevron: false,
        ),
      ];
    } else {
      rows = [
        for (final generation in list)
          identified(
            PluginIds.historyEntry(generation['generationId'] as String),
            _GenerationTile(generation: generation),
          ),
      ];
    }
    return identified(
      PluginIds.history,
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 12),
          const FrockSectionLabel('History'),
          FrockRowGroup(rows: rows),
          if (list != null && error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 4, 0),
              child: Text(error!, style: Theme.of(context).textTheme.bodySmall),
            ),
          if (list != null && cursor != null)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: identified(
                  PluginIds.historyEarlier,
                  TextButton(
                    onPressed: loading ? null : () => load(earlier: true),
                    child: const Text('Earlier setups'),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// One generation: what it is and when, and under it the Plugins it held,
/// each with the code the Bot wrote.
class _GenerationTile extends StatelessWidget {
  final Map<String, dynamic> generation;
  const _GenerationTile({required this.generation});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final current = generation['isCurrent'] == true;
    final (status, glyph, tint) = switch (generation['status']) {
      'active' => ('Active', Icons.check_circle_outline_rounded, null),
      'pending' => ('Waiting for its next Turn', Icons.schedule_rounded, null),
      'failed' => (
        'Couldn’t activate',
        Icons.error_outline_rounded,
        scheme.error,
      ),
      'quarantined' => (
        'Needs attention',
        Icons.report_gmailerrorred_rounded,
        FrockTheme.warning,
      ),
      _ => ('Previous setup', Icons.history_rounded, null),
    };
    final origin = switch ((generation['origin'] as Map?)?['kind']) {
      'bot-authored' => 'Written by this Bot',
      'revert' => 'Put back',
      'bootstrap' => 'First setup',
      _ => null,
    };
    final date = MaterialLocalizations.of(context).formatShortDate(
      DateTime.parse(generation['createdAt'] as String).toLocal(),
    );
    final members = (generation['members'] as List? ?? const [])
        .cast<Map<dynamic, dynamic>>();
    final failed = (generation['failures'] as List? ?? const []).isNotEmpty;
    final quiet = MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : null;
    return Theme(
      // The tile draws its own dividers; the card's hairlines are enough.
      data: theme.copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        expansionAnimationStyle: quiet,
        tilePadding: const EdgeInsets.fromLTRB(14, 2, 12, 2),
        childrenPadding: const EdgeInsets.fromLTRB(48, 0, 14, 14),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        leading: SizedBox(
          width: 22,
          child: Icon(glyph, size: 20, color: tint ?? scheme.onSurfaceVariant),
        ),
        minTileHeight: 58,
        title: Text(
          current ? 'Current setup' : status,
          style: theme.textTheme.bodyMedium?.copyWith(
            fontSize: 14,
            fontWeight: FontWeight.w500,
            letterSpacing: -0.1,
          ),
        ),
        subtitle: Text(
          [date, if (current) status, ?origin].join(' · '),
          style: theme.textTheme.bodySmall?.copyWith(
            fontSize: 12.5,
            color: scheme.onSurfaceVariant,
          ),
        ),
        children: [
          if (members.isEmpty)
            Text(
              'No Plugins in this setup.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          for (final member in members)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    '${member['packageId']} · ${member['version']}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (member['source'] case final String source)
                    ExpansionTile(
                      expansionAnimationStyle: quiet,
                      tilePadding: EdgeInsets.zero,
                      minTileHeight: 36,
                      title: Text(
                        'Inspect authored code',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.primary,
                        ),
                      ),
                      children: [
                        DecoratedBox(
                          decoration: BoxDecoration(
                            color: scheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(
                              FrockTheme.radiusRow,
                            ),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.all(12),
                            child: SelectableText(
                              source,
                              style: theme.textTheme.bodySmall?.copyWith(
                                fontFamily: 'monospace',
                                fontSize: 12,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          if (failed)
            Text(
              'This setup failed a check before it could run. The last '
              'working setup stays in place.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}
