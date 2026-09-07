/// The search overlay: every conversation this account has.
///
/// It replaces the Bot-list search the shell cut left behind, which could only
/// ever match a name the sidebar already held. Every state is named — nothing
/// typed, nothing found, rebuilding, truncated — because a blank panel that
/// could mean any of the four is the one outcome this surface must not produce.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import 'controller.dart';

/// Opens search over the shell. The result is the Bot and the Turn the reader
/// chose, or nothing when they closed it.
Future<({String botId, String runId})?> showSearchOverlayV1(
  BuildContext context,
  NativeApi api,
) => showDialog<({String botId, String runId})>(
  context: context,
  barrierDismissible: true,
  builder: (dialog) => SearchOverlay(api: api),
);

class SearchOverlay extends StatefulWidget {
  final NativeApi api;
  const SearchOverlay({super.key, required this.api});

  @override
  State<SearchOverlay> createState() => _SearchOverlayState();
}

class _SearchOverlayState extends State<SearchOverlay> {
  late final BotSearchController controller = BotSearchController(widget.api);
  final editor = TextEditingController();
  final focus = FocusNode();

  @override
  void initState() {
    super.initState();
    controller.addListener(_repaint);
    WidgetsBinding.instance.addPostFrameCallback((_) => focus.requestFocus());
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    controller.removeListener(_repaint);
    controller.dispose();
    editor.dispose();
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Dialog(
      insetPadding: const EdgeInsets.all(16),
      clipBehavior: Clip.antiAlias,
      child: identified(
        SearchIds.overlay,
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640, maxHeight: 720),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: identified(
                        SearchIds.field,
                        TextField(
                          controller: editor,
                          focusNode: focus,
                          autocorrect: false,
                          textInputAction: TextInputAction.search,
                          decoration: const InputDecoration(
                            border: InputBorder.none,
                            icon: Icon(Icons.search),
                            hintText: 'Search every Bot’s conversations',
                          ),
                          onChanged: controller.setQuery,
                          onSubmitted: (_) => unawaited(controller.run()),
                        ),
                      ),
                    ),
                    identified(
                      SearchIds.rebuild,
                      IconButton(
                        tooltip: 'Rebuild the search index',
                        onPressed: controller.rebuilding
                            ? null
                            : () => unawaited(controller.rebuild()),
                        icon: const Icon(Icons.refresh_rounded),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Close search',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Wrap(
                  spacing: 8,
                  children: [
                    identified(
                      SearchIds.includeArchived,
                      FilterChip(
                        label: const Text('Archived Bots'),
                        selected: controller.includeArchived,
                        onSelected: controller.setIncludeArchived,
                      ),
                    ),
                    identified(
                      SearchIds.includeTools,
                      FilterChip(
                        label: const Text('Tool output'),
                        selected: controller.includeTools,
                        onSelected: controller.setIncludeTools,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Flexible(child: _body(theme)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _note(String text) => identified(
    SearchIds.note,
    Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
      child: Semantics(
        liveRegion: true,
        child: Text(text, style: Theme.of(context).textTheme.bodySmall),
      ),
    ),
  );

  Widget _body(ThemeData theme) {
    final groups = controller.groups;
    if (controller.error != null) {
      return FrockEmptyState(
        icon: Icons.cloud_off_rounded,
        title: 'Search couldn’t run',
        detail: controller.error!,
        action: 'Try again',
        onAction: () => unawaited(controller.run()),
      );
    }
    if (controller.query.trim().isEmpty) {
      return _note('Type to search every conversation this account has.');
    }
    if (groups == null) {
      return const FrockLoading(label: 'Searching');
    }
    if (controller.totalHits == 0) {
      return _note('No Turns match “${controller.answeredQuery}”.');
    }
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.only(bottom: 12),
      children: [
        if (controller.indexState == 'rebuilding')
          _note('Rebuilding search. Results are incomplete until it finishes.')
        else if (controller.indexState == 'truncated')
          _note(
            'The oldest conversations are no longer searchable. Rebuilding won’t bring them back.',
          ),
        for (final group in groups)
          identified(
            SearchIds.group(group.botId),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Semantics(
                          header: true,
                          child: Text(
                            group.botName,
                            style: theme.textTheme.titleSmall,
                          ),
                        ),
                      ),
                      if (group.archived)
                        Text('Archived', style: theme.textTheme.labelSmall)
                      else if (group.hidden)
                        Text('Hidden', style: theme.textTheme.labelSmall),
                      const SizedBox(width: 8),
                      Text(
                        '${group.totalHits}',
                        style: theme.textTheme.labelSmall,
                      ),
                    ],
                  ),
                ),
                for (final hit in group.hits)
                  identified(
                    SearchIds.hit(hit.runId),
                    ListTile(
                      dense: true,
                      title: Text(
                        hit.snippet,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        '${hit.kindLabel}${hit.at.isEmpty ? '' : ' · ${_when(hit.at)}'}',
                      ),
                      onTap: () =>
                          Navigator.of(context)
                              .pop((botId: group.botId, runId: hit.runId)),
                    ),
                  ),
              ],
            ),
          ),
        if (controller.truncated)
          _note(
            'More matches than this page holds. Narrow the query to see them.',
          ),
      ],
    );
  }

  String _when(String at) {
    final moment = DateTime.tryParse(at);
    return moment == null
        ? at
        : MaterialLocalizations.of(context).formatShortDate(moment.toLocal());
  }
}
