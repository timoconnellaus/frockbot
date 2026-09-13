/// Archived history is read through the transcript's GET routes. It never
/// starts a Bot session, restores pending commands, or offers a composer.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/chat_pane.dart' show RunPage;
import '../shell/semantics.dart';
import '../shell/transcript.dart';
import 'controller.dart';

class ArchivedConversationPage extends StatefulWidget {
  final NativeApi api;
  final SearchBot bot;
  final String? runId;
  const ArchivedConversationPage({
    super.key,
    required this.api,
    required this.bot,
    this.runId,
  });

  @override
  State<ArchivedConversationPage> createState() =>
      _ArchivedConversationPageState();
}

class _ArchivedConversationPageState extends State<ArchivedConversationPage> {
  late final transport = BackendChatTransport(widget.api);
  final Map<String, Map<String, dynamic>> runs = {};
  List<Object?> announcements = const [];
  String? before;
  String? error;
  bool loading = false;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load({bool older = false}) async {
    if (loading) return;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final page = await transport.page(
        widget.bot.id,
        before: older ? before : null,
      );
      final incoming = <String, Map<String, dynamic>>{
        for (final value in page['runs'] as List)
          (value as Map)['runId'] as String: Map<String, dynamic>.from(value),
      };
      final target = widget.runId;
      if (target != null &&
          !runs.containsKey(target) &&
          !incoming.containsKey(target)) {
        final hit = await transport.lookup(widget.bot.id, target);
        if (hit != null) {
          incoming[target] = hit;
        } else {
          error = 'This message is no longer available.';
        }
      }
      if (!mounted) return;
      setState(() {
        runs.addAll(incoming);
        if (older || before == null) {
          before = (page['page'] as Map)['nextCursor'] as String?;
        }
        if (!older) announcements = page['announcements'] as List? ?? const [];
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Couldn’t load this archived conversation. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(widget.bot.name)),
    body: identified(
      SearchIds.archivedConversation,
      SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 860),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 20,
                    vertical: 12,
                  ),
                  child: Text(
                    'Archived · Read-only conversation',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                Expanded(
                  child: TranscriptView(
                    lines: [
                      ...projectRuns(runs.values.toList()),
                      ...projectAnnouncements(announcements),
                    ],
                    loading: loading,
                    hasEarlier: before != null,
                    onRefresh: load,
                    onOpenRun: (line) => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => RunPage(line: line),
                      ),
                    ),
                    storageKey: 'archived-history-${widget.bot.id}',
                    focusRunId: widget.runId,
                    background: widget.bot.background,
                  ),
                ),
                if (runs.isEmpty && announcements.isEmpty && before != null)
                  identified(
                    ShellIds.transcriptEarlier,
                    TextButton(
                      onPressed: loading ? null : () => load(older: true),
                      child: const Text('Load earlier messages'),
                    ),
                  ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                    child: Row(
                      children: [
                        Expanded(child: Text(error!)),
                        TextButton(
                          onPressed: loading ? null : load,
                          child: const Text('Retry'),
                        ),
                      ],
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
