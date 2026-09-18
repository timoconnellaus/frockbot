/// One Routine's firings, and one firing's work.
///
/// An automation Turn is absent from the visible transcript by construction,
/// so the run log is the only door to one — and it is a read in both
/// directions: the detail carries what happened and no way to act on it. What
/// it happened to *do* is the Work view's, which is the same surface a Turn in
/// the thread opens, reached from here with the run projected into the
/// transcript's own vocabulary.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../shell/chat_pane.dart';
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../theme/states.dart';

/// One automation run as the Work view reads it.
///
/// The run's own events are flattened to the receipts the Work view draws:
/// each is a thing that happened, at a moment, with a sentence. The run's
/// outcome is the line under them, never the Bot's voice — an automation run
/// has no voice, which is the whole reason this surface exists.
TranscriptLine routineRunLineV1(Map<String, Object?> detail) {
  final events = (detail['events'] as List? ?? const [])
      .cast<Map<String, Object?>>();
  final runId = (detail['runId'] as String?) ?? 'routine-run';
  final status = detail['status'] as String?;
  return TranscriptLine(
    id: '$runId:routine',
    runId: runId,
    role: LineRole.assistant,
    text: (detail['input'] as String?) ?? '',
    at: detail['admittedAt'] as String?,
    status: switch (status) {
      'running' => LineStatus.streaming,
      'failed' => LineStatus.error,
      'cancelled' || 'superseded' => LineStatus.aborted,
      _ => LineStatus.completed,
    },
    notice: detail['outcome'] as String?,
    tools: [
      for (var index = 0; index < events.length; index += 1)
        ToolActivity(
          id: '$runId:$index',
          name: (events[index]['type'] as String?) ?? 'event',
          status: 'completed',
          text: events[index]['summary'] as String?,
        ),
    ],
  );
}

/// The house order's own month names. A moment reads as a moment — "8 Sep
/// 2026, 6:23am" — never as the wire it arrived on.
const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// A durable moment in this device's own zone, in the house order.
String routineRunMomentV1(String? iso) {
  final at = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (at == null) return iso ?? '';
  final hour = at.hour % 12 == 0 ? 12 : at.hour % 12;
  final minute = at.minute.toString().padLeft(2, '0');
  return '${at.day} ${_months[at.month - 1]} ${at.year}, '
      '$hour:$minute${at.hour < 12 ? 'am' : 'pm'}';
}

/// The firings of one Routine, newest last, as the authority recorded them.
class RoutineRunsPage extends StatefulWidget {
  final NativeApi api;
  final String botId;
  final String routineId;
  final void Function(TranscriptLine line)? onOpenRun;
  const RoutineRunsPage({
    super.key,
    required this.api,
    required this.botId,
    required this.routineId,
    this.onOpenRun,
  });

  @override
  State<RoutineRunsPage> createState() => _RoutineRunsPageState();
}

class _RoutineRunsPageState extends State<RoutineRunsPage> {
  List<Map<String, Object?>> entries = const [];
  bool loading = true;
  String? message;

  String get _path =>
      '/api/bots/${Uri.encodeComponent(widget.botId)}'
      '/routines/${Uri.encodeComponent(widget.routineId)}/runs';

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    setState(() {
      loading = true;
      message = null;
    });
    try {
      final answer = await widget.api.request(_path);
      final list = (answer as Map?)?['entries'] as List? ?? const [];
      if (!mounted) return;
      setState(() {
        entries = [
          for (final entry in list) (entry as Map).cast<String, Object?>(),
        ];
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => message = 'Couldn’t load this Routine’s run log. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _open(String runId) async {
    try {
      final detail = await widget.api.request(
        '$_path/${Uri.encodeComponent(runId)}',
      );
      if (!mounted) return;
      final line = routineRunLineV1(
        ((detail as Map?) ?? const {}).cast<String, Object?>(),
      );
      final open = widget.onOpenRun;
      if (open != null) {
        Navigator.of(context).pop();
        open(line);
        return;
      }
      await Navigator.of(context)
          .push(MaterialPageRoute<void>(builder: (_) => RunPage(line: line)));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Couldn’t open that firing. Please try again.'),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Run log'),
      actions: [
        IconButton(
          tooltip: 'Refresh the run log',
          onPressed: loading ? null : load,
          icon: const Icon(Icons.refresh_rounded),
        ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: identified(
        RoutineIds.runLog,
        loading && entries.isEmpty
            ? const FrockLoading(label: 'Loading the run log')
            : message != null && entries.isEmpty
            ? FrockEmptyState(
                icon: Icons.cloud_off_rounded,
                title: 'Run log couldn’t load',
                detail: message!,
                action: 'Try again',
                onAction: load,
              )
            : entries.isEmpty
            ? const _NoRuns()
            : RefreshIndicator(
                onRefresh: load,
                child: ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  itemCount: entries.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final entry = entries[index];
                    final runId = (entry['runId'] as String?) ?? '';
                    return identified(
                      RoutineIds.run(runId),
                      ListTile(
                        title: Text(switch (entry['status']) {
                          'ok' => 'Completed',
                          'failed' => 'Failed',
                          'skipped' => 'Skipped',
                          'cancelled' => 'Cancelled',
                          'running' => 'Running',
                          _ => 'Outcome unknown',
                        }),
                        subtitle: Text(
                          [
                            switch (entry['trigger']) {
                              'cron' => 'Scheduled',
                              'webhook' => 'Webhook',
                              _ => 'Run by you',
                            },
                            routineRunMomentV1(entry['startedAt'] as String?),
                            ?entry['summary'] as String?,
                          ].join(' · '),
                        ),
                        trailing: const Icon(Icons.chevron_right),
                        onTap: runId.isEmpty ? null : () => _open(runId),
                      ),
                    );
                  },
                ),
              ),
      ),
    ),
  );
}

class _NoRuns extends StatelessWidget {
  const _NoRuns();

  @override
  Widget build(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(32),
      child: Text(
        'This Routine hasn’t fired yet. Its firings will appear here.',
        textAlign: TextAlign.center,
      ),
    ),
  );
}
