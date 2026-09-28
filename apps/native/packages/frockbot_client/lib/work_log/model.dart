/// What the Work log reads: its rows, its Turns, its filters, and the
/// controller that pages them in. Everything the server wrote is read out of
/// its wire form once, here, rather than on every paint.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

String workLogPathV1(String botId, {String? before}) {
  final path = '/api/bots/${Uri.encodeComponent(botId)}/work-log';
  return before == null
      ? path
      : '$path?before=${Uri.encodeQueryComponent(before)}';
}

/// One step on the way a call got to run.
class WorkLogLinkView {
  final String kind;
  final String title;
  final String? detail;
  final int? durationMs;
  final bool isError;
  const WorkLogLinkView({
    required this.kind,
    required this.title,
    this.detail,
    this.durationMs,
    this.isError = false,
  });
}

/// One row.
class WorkLogRow {
  final String id;

  /// Its place in its Turn, from 1.
  final int number;
  final String runId;
  final DateTime at;
  final String kind;
  final int? step;
  final String title;
  final String? label;
  final String? detail;
  final String? verdict;
  final int? durationMs;
  final bool isError;
  final bool beforeTurn;
  final wire.WorkLogTokens? tokens;
  final List<wire.WorkLogField> fields;
  final List<wire.WorkLogSection> sections;
  final List<WorkLogLinkView> chain;

  /// The entry exactly as the server sent it, for the Raw tab.
  final String raw;
  final String _haystack;

  WorkLogRow._({
    required this.id,
    required this.number,
    required this.runId,
    required this.at,
    required this.kind,
    required this.step,
    required this.title,
    required this.label,
    required this.detail,
    required this.verdict,
    required this.durationMs,
    required this.isError,
    required this.beforeTurn,
    required this.tokens,
    required this.fields,
    required this.sections,
    required this.chain,
    required this.raw,
  }) : _haystack = [
         title,
         label ?? '',
         detail ?? '',
         for (final field in fields) '${field.label} ${field.value}',
         for (final section in sections) section.text,
       ].join('\n').toLowerCase();

  factory WorkLogRow.fromWire(
    String runId,
    int number,
    wire.WorkLogEntry entry,
  ) => WorkLogRow._(
    id: '$runId:${entry.seq}',
    number: number,
    runId: runId,
    at: DateTime.parse(entry.at.value).toLocal(),
    kind: entry.kind,
    step: entry.step,
    title: entry.title,
    label: entry.label,
    detail: entry.detail,
    verdict: entry.verdict,
    durationMs: entry.durationMs,
    isError: entry.isError ?? false,
    beforeTurn: entry.beforeTurn ?? false,
    tokens: entry.tokens,
    fields: entry.fields ?? const [],
    sections: entry.sections ?? const [],
    chain: [
      for (final link in entry.chain ?? const <wire.WorkLogLink>[])
        WorkLogLinkView(
          kind: link.kind,
          title: link.title,
          detail: link.detail,
          durationMs: link.durationMs,
          isError: link.isError ?? false,
        ),
    ],
    raw: const JsonEncoder.withIndent('  ').convert(entry.toJson()),
  );

  bool matches(String query) => query.isEmpty || _haystack.contains(query);

  /// When the row stopped taking time.
  DateTime get end => at.add(Duration(milliseconds: durationMs ?? 0));

  /// The sections drawn on one tab. Summary also takes those the server
  /// named no tab for.
  List<wire.WorkLogSection> onTab(String tab) => [
    for (final section in sections)
      if ((section.tab ?? 'summary') == tab) section,
  ];
}

/// One Turn, with its rows.
class WorkLogTurnView {
  final String runId;
  final int? turn;
  final DateTime at;
  final String status;
  final String via;
  final String input;
  final int? durationMs;
  final String? outcome;
  final wire.WorkLogTotals totals;

  /// What happened before the Turn began, drawn between it and the one
  /// before: a compaction.
  final List<WorkLogRow> before;
  final List<WorkLogRow> rows;
  final int omitted;

  WorkLogTurnView._({
    required this.runId,
    required this.turn,
    required this.at,
    required this.status,
    required this.via,
    required this.input,
    required this.durationMs,
    required this.outcome,
    required this.totals,
    required this.before,
    required this.rows,
    required this.omitted,
  });

  factory WorkLogTurnView.fromWire(wire.WorkLogTurn turn) {
    // The Turn's own rows are numbered from 1; what came before it is not
    // part of the count.
    var before = 0;
    var inside = 0;
    final all = [
      for (final entry in turn.entries)
        WorkLogRow.fromWire(
          turn.runId,
          entry.beforeTurn == true ? ++before : ++inside,
          entry,
        ),
    ];
    return WorkLogTurnView._(
      runId: turn.runId,
      turn: turn.turn,
      at: DateTime.parse(turn.at.value).toLocal(),
      status: turn.status,
      via: turn.via,
      input: turn.input,
      durationMs: turn.durationMs,
      outcome: turn.outcome,
      totals: turn.totals,
      before: [
        for (final row in all)
          if (row.beforeTurn) row,
      ],
      rows: [
        for (final row in all)
          if (!row.beforeTurn) row,
      ],
      omitted: turn.omittedEntries ?? 0,
    );
  }

  String get label => turn == null ? 'Turn' : 'Turn $turn';
  String get shortLabel => turn == null ? 'T' : 'T$turn';
  List<WorkLogRow> get everything => [...before, ...rows];
  int get errors => rows.where((row) => row.isError).length;

  /// The Turn's plain summary, the same everywhere it is drawn.
  String summary({bool jev = true}) {
    final t = totals;
    return [
      '${t.steps} step${t.steps == 1 ? '' : 's'}',
      if (t.toolCalls > 0)
        '${t.toolCalls} tool call${t.toolCalls == 1 ? '' : 's'}',
      if (jev && t.jevChecks > 0)
        '${t.jevChecks} Jev check${t.jevChecks == 1 ? '' : 's'}',
      if (t.retries > 0) '${t.retries} retr${t.retries == 1 ? 'y' : 'ies'}',
      if (t.computerMs > 0) 'Computer ${workLogDuration(t.computerMs)}',
    ].join(' · ');
  }
}

/// The filters over row kinds. `All` is the absence of one.
class WorkLogFilter {
  final String slug;
  final String label;
  final Set<String> kinds;
  const WorkLogFilter(this.slug, this.label, this.kinds);
}

const workLogFilters = [
  WorkLogFilter('all', 'All', {}),
  WorkLogFilter('model', 'Model', {'model'}),
  WorkLogFilter('tools', 'Tools', {'tool'}),
  WorkLogFilter('jev', 'Jev', {'jev'}),
  WorkLogFilter('memory', 'Memory & skills', {'memory', 'skill'}),
  WorkLogFilter('plugins', 'Plugins', {'plugin'}),
  WorkLogFilter('computer', 'Computer', {'computer'}),
  WorkLogFilter('recovery', 'Recovery', {'retry', 'compaction'}),
  WorkLogFilter('errors', 'Errors', {}),
];

class WorkLogController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  WorkLogController(this.api, this.botId);

  List<WorkLogTurnView> turns = const [];
  String? nextCursor;
  bool loaded = false;
  bool loading = false;
  bool loadingMore = false;
  String? error;
  String? moreError;

  /// Turns a Stop was sent for and not yet read back.
  final stopping = <String>{};
  String? stopError;
  bool _closed = false;
  int _request = 0;
  int _commands = 0;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    final request = ++_request;
    loading = true;
    error = null;
    _changed();
    try {
      final page = wire.WorkLogPage.fromJson(
        await api.request(workLogPathV1(botId)),
      );
      if (request != _request) return;
      turns = page.turns.map(WorkLogTurnView.fromWire).toList();
      nextCursor = page.nextCursor;
      loaded = true;
    } catch (_) {
      if (request != _request) return;
      error =
          'Couldn’t load the Work log. Check your connection and try again.';
    } finally {
      if (request == _request) {
        loading = false;
        _changed();
      }
    }
  }

  Future<void> more() async {
    final cursor = nextCursor;
    if (cursor == null || loading || loadingMore) return;
    final request = _request;
    loadingMore = true;
    moreError = null;
    _changed();
    try {
      final page = wire.WorkLogPage.fromJson(
        await api.request(workLogPathV1(botId, before: cursor)),
      );
      if (request != _request) return;
      turns = [...turns, ...page.turns.map(WorkLogTurnView.fromWire)];
      nextCursor = page.nextCursor;
    } catch (_) {
      if (request != _request) return;
      moreError = 'Couldn’t load earlier Turns.';
    } finally {
      loadingMore = false;
      _changed();
    }
  }

  /// Stops a running Turn — the one way to stop a Routine that has not said
  /// anything in the chat, where `/stop` reaches only what the thread shows.
  /// The log is read again afterwards, and it is what says the Turn stopped.
  Future<void> stop(String runId) async {
    if (!stopping.add(runId)) return;
    stopError = null;
    _changed();
    try {
      await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/turns/'
        '${Uri.encodeComponent(runId)}/stop',
        body: {
          'schemaVersion': 1,
          'action': 'stop',
          'commandId':
              'wl-${DateTime.now().microsecondsSinceEpoch}-${_commands++}',
          'runId': runId,
        },
      );
      await load();
    } catch (_) {
      stopError = 'Couldn’t stop that Turn. Try again.';
    } finally {
      stopping.remove(runId);
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

String workLogKindLabel(String kind) => switch (kind) {
  'input' => 'Input',
  'model' => 'Model',
  'jev' => 'Jev',
  'tool' => 'Tool',
  'memory' => 'Memory',
  'skill' => 'Skill',
  'plugin' => 'Plugin',
  'computer' => 'Computer',
  'retry' => 'Retry',
  'compaction' => 'Compacted',
  'send' => 'Sent',
  'task' => 'Task',
  _ => 'System',
};

/// Each kind's colour, from the flock, with a darker twin that carries on
/// paper. Kinds that sit side by side differ in lightness as well as hue.
Color workLogKindColor(ThemeData theme, String kind) {
  final dark = theme.brightness == Brightness.dark;
  Color pick(int onInk, int onPaper) => Color(dark ? onInk : onPaper);
  return switch (kind) {
    'input' => pick(0xff58c98b, 0xff1c7a4e),
    'model' => pick(0xfffc85ae, 0xffb3245f),
    'jev' => pick(0xff59c7ff, 0xff0b6fa4),
    'tool' => pick(0xffffc928, 0xff8a6000),
    'memory' || 'skill' => pick(0xffb8a6f0, 0xff6a4fc4),
    'plugin' => pick(0xffff8b27, 0xffa04e00),
    'computer' => pick(0xff7fd8c4, 0xff1f7a68),
    'task' => pick(0xffef6b4a, 0xffb03d20),
    'send' => theme.colorScheme.onSurface,
    _ => theme.colorScheme.onSurfaceVariant,
  };
}

/// Which of the timeline's three lanes a kind runs in.
int workLogLane(String kind) => switch (kind) {
  'input' || 'memory' || 'skill' => 0,
  'model' || 'jev' || 'retry' || 'compaction' => 1,
  _ => 2,
};

/// Where a row is marked as coming from a tool, it is set in under the model
/// request that asked for it.
bool workLogIndented(String kind) =>
    kind == 'tool' || kind == 'plugin' || kind == 'computer';

String workLogDuration(int ms) {
  if (ms < 10000) return '${_thousands(ms)} ms';
  if (ms < 60000) return '${(ms / 1000).toStringAsFixed(1)} s';
  final minutes = ms ~/ 60000;
  final seconds = (ms % 60000) ~/ 1000;
  return seconds == 0 ? '$minutes m' : '$minutes m $seconds s';
}

String workLogTokens(int count) {
  if (count < 1000) return '$count';
  if (count < 1000000) return '${(count / 1000).toStringAsFixed(1)}k';
  return '${(count / 1000000).toStringAsFixed(2)}M';
}

String workLogCount(int count) => _thousands(count);

String _thousands(int value) {
  final digits = value.toString();
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}
