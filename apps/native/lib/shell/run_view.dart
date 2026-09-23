/// What a Turn actually did, and the badge that says it is still doing it.
///
/// Two things live here because they are the same fact drawn twice. The badge
/// is the wordless one: the typing dots on the working Bot's avatar, whose
/// tempo is the Turn's own pace — text arriving quickly is a quick bounce, a
/// Turn waiting on the model still ticks over so the app never reads as dead.
/// It never names what happened, because the thread stays a conversation.
///
/// The run view is where the naming happens. Tool receipts are not chat: the
/// thread is the Bot's words, and what it called to produce them belongs on a
/// Work view the person opens from the message. On the phone that is a page;
/// at wide widths it is the right panel.
library;

import 'dart:async' show Timer;
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'desktop_layout.dart';
import 'semantics.dart';
import 'transcript_model.dart';

// ------------------------------------------------------------- the pace

/// The fastest the pace will ever read, in particles a second: the scale the
/// badge's tempo is drawn against.
const double workingPaceMaxRate = 40;

/// The floor while a Turn is open. A Turn waiting on a model that has not sent
/// a token yet is still working, and a badge that stops reads as a crash.
const double workingPaceTrickleRate = 6;

/// Silence longer than this is a wait, not a pause between chunks.
const Duration workingPaceQuietAfter = Duration(milliseconds: 1500);

/// How far back the chunk-rate average looks.
const Duration workingPaceRateWindow = Duration(milliseconds: 1200);

/// Characters of streamed text one unit of pace stands for.
const int workingPaceCharactersPerParticle = 6;

/// How often the working row re-reads its Turn. The pace only has to notice a
/// stream going quiet, so a few readings a second is plenty.
const Duration workingPaceReadEvery = Duration(milliseconds: 250);

/// The badge's bounce period while a Turn waits on the model.
const Duration workingBadgeWaitingPeriod = Duration(milliseconds: 1600);

/// The badge's bounce period at the pace floor and at the pace cap.
const Duration workingBadgeSlowPeriod = Duration(milliseconds: 1200);
const Duration workingBadgeFastPeriod = Duration(milliseconds: 600);

/// `running` is work arriving now, `waiting` is an open Turn gone quiet, and
/// `ended` is a settled Turn: the badge has nothing left to say.
enum WorkingPaceState { running, waiting, ended }

/// One reading of the open Turn, as the client's projection has it.
class WorkingPaceSample {
  final int characters;
  final int toolStarts;
  final int toolSettles;
  final int sends;

  /// The whole status string rather than a union: only `streaming` means the
  /// Turn is still going, so a status this file has never heard of ends the
  /// pace rather than leaving it running forever.
  final String status;
  const WorkingPaceSample({
    required this.characters,
    required this.toolStarts,
    required this.toolSettles,
    required this.sends,
    required this.status,
  });

  /// A sample read off the transcript's own vocabulary.
  factory WorkingPaceSample.fromLine(TranscriptLine line) => WorkingPaceSample(
    characters: line.text.length,
    toolStarts: line.tools.length,
    toolSettles: line.tools.where((tool) => tool.status != 'running').length,
    sends: line.sends.length,
    status: line.status == LineStatus.streaming ? 'streaming' : 'ended',
  );
}

class WorkingPacePlan {
  final bool active;
  final WorkingPaceState state;
  final double rate;
  const WorkingPacePlan(this.active, this.state, this.rate);
}

/// What the mapping remembers between two samples.
class WorkingPaceMemory {
  final WorkingPaceSample sample;
  final Duration lastEventAt;
  final List<({Duration at, int characters})> window;
  const WorkingPaceMemory(this.sample, this.lastEventAt, this.window);
}

WorkingPaceMemory workingPaceBegin(WorkingPaceSample sample, Duration now) =>
    WorkingPaceMemory(sample, now, const []);

/// The plan for the moment between the remembered sample and this one.
///
/// Deltas are floored at zero: a projection that replaces a Turn's text with a
/// shorter final version is not a negative amount of work, it is no work.
({WorkingPaceMemory memory, WorkingPacePlan plan}) workingPaceStep(
  WorkingPaceMemory memory,
  WorkingPaceSample sample,
  Duration now,
) {
  final characters = math.max(0, sample.characters - memory.sample.characters);
  final startedTools = math.max(
    0,
    sample.toolStarts - memory.sample.toolStarts,
  );
  final settledTools = math.max(
    0,
    sample.toolSettles - memory.sample.toolSettles,
  );
  final delivered = math.max(0, sample.sends - memory.sample.sends);

  if (sample.status != 'streaming') {
    return (
      memory: WorkingPaceMemory(sample, memory.lastEventAt, const []),
      plan: const WorkingPacePlan(false, WorkingPaceState.ended, 0),
    );
  }

  final window = [
    ...memory.window,
    (at: now, characters: characters),
  ].where((entry) => now - entry.at <= workingPaceRateWindow).toList();
  final streamed = window.fold(0, (total, entry) => total + entry.characters);
  final streamRate =
      streamed /
      (workingPaceRateWindow.inMilliseconds / 1000) /
      workingPaceCharactersPerParticle;

  final moved =
      characters > 0 || startedTools > 0 || settledTools > 0 || delivered > 0;
  final lastEventAt = moved ? now : memory.lastEventAt;
  final quiet = now - lastEventAt > workingPaceQuietAfter;

  return (
    memory: WorkingPaceMemory(sample, lastEventAt, window),
    plan: WorkingPacePlan(
      true,
      quiet ? WorkingPaceState.waiting : WorkingPaceState.running,
      math.min(
        workingPaceMaxRate,
        math.max(streamRate, workingPaceTrickleRate),
      ),
    ),
  );
}

/// The badge's bounce period for a plan: a long, patient bounce while the Turn
/// waits, quickening with the stream once text is arriving.
Duration workingBadgePeriod(WorkingPacePlan plan) {
  switch (plan.state) {
    case WorkingPaceState.ended:
      return workingBadgeSlowPeriod;
    case WorkingPaceState.waiting:
      return workingBadgeWaitingPeriod;
    case WorkingPaceState.running:
      final span = workingPaceMaxRate - workingPaceTrickleRate;
      final t = ((plan.rate - workingPaceTrickleRate) / span).clamp(0.0, 1.0);
      return Duration(
        milliseconds:
            (workingBadgeSlowPeriod.inMilliseconds +
                    (workingBadgeFastPeriod.inMilliseconds -
                            workingBadgeSlowPeriod.inMilliseconds) *
                        t)
                .round(),
      );
  }
}

/// The tempo of a running Turn, read off its line: fast while tokens stream,
/// slow while the model is quiet, stopped once the Turn ends. Whatever wears
/// the typing badge — the companion in the conversation header — takes its period
/// from here, so the badge's pace is the Turn's and not a metronome.
class WorkingPace extends StatefulWidget {
  /// The running Turn's line, or nothing while the submission is still being
  /// delivered: the Bot is busy either way, and a Turn not yet admitted is
  /// paced as one waiting on its model.
  final TranscriptLine? line;
  final Widget Function(BuildContext context, Duration tempo) builder;
  const WorkingPace({super.key, required this.line, required this.builder});

  @override
  State<WorkingPace> createState() => _WorkingPaceState();
}

class _WorkingPaceState extends State<WorkingPace> {
  final Stopwatch _clock = Stopwatch()..start();
  Timer? _timer;
  WorkingPaceMemory? _memory;
  WorkingPacePlan _plan = const WorkingPacePlan(
    true,
    WorkingPaceState.running,
    workingPaceTrickleRate,
  );

  /// The tempo is motion and nothing else, so a person who asked for less of
  /// it gets none: the clock does not run at all rather than running into a
  /// badge that holds still.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still) {
      _timer?.cancel();
      _timer = null;
    } else {
      _timer ??= Timer.periodic(workingPaceReadEvery, (_) => _read());
    }
  }

  @override
  void didUpdateWidget(WorkingPace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_timer != null && !identical(oldWidget.line, widget.line)) _read();
  }

  void _read() {
    final line = widget.line;
    if (line == null) {
      // Nothing has streamed: the badge keeps the waiting pace until the Turn
      // is admitted and its line arrives.
      _memory = null;
      const waiting = WorkingPacePlan(true, WorkingPaceState.waiting, 0);
      final changed = workingBadgePeriod(waiting) != workingBadgePeriod(_plan);
      _plan = waiting;
      if (changed && mounted) setState(() {});
      return;
    }
    final sample = WorkingPaceSample.fromLine(line);
    final stepped = workingPaceStep(
      _memory ?? workingPaceBegin(sample, _clock.elapsed),
      sample,
      _clock.elapsed,
    );
    _memory = stepped.memory;
    final period = workingBadgePeriod(stepped.plan);
    final changed = period != workingBadgePeriod(_plan);
    _plan = stepped.plan;
    if (changed && mounted) setState(() {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      widget.builder(context, workingBadgePeriod(_plan));
}

/// The words a running Turn earns in the thread — and only those. A plain
/// running Turn draws nothing here: the companion in the conversation header wears
/// the typing badge and the working pose. Two states still need a line of
/// text above the composer: a Stop the person asked for and is waiting on, and
/// a Turn waiting behind the one it displaced.
class WorkingIndicator extends StatelessWidget {
  final String label;
  const WorkingIndicator({super.key, required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.workingNotice,
      Semantics(
        liveRegion: true,
        label: label,
        child: Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

// ----------------------------------------------------------- the run view

/// A Turn's receipts: what it called, what came back, and how it ended.
class RunView extends StatelessWidget {
  final TranscriptLine line;
  final VoidCallback? onClose;

  /// Off where the surface already carries a title of its own — the page on a
  /// phone has an app bar, and two headings saying "Work" is one too many.
  final bool header;
  const RunView({
    super.key,
    required this.line,
    this.onClose,
    this.header = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return identified(
      ShellIds.runView,
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
                      child: Text('Work', style: theme.textTheme.titleMedium),
                    ),
                    if (onClose != null)
                      identified(
                        ShellIds.runViewClose,
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
            child:
                line.tools.isEmpty &&
                    line.sends.isEmpty &&
                    line.pluginCalls.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.build_outlined,
                            size: 32,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'This reply used no tools.',
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  )
                : ListView(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    children: [
                      for (final tool in line.tools) _ToolRow(tool: tool),
                      if (line.pluginCalls.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                          child: Text(
                            'Plugins',
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                        for (final call in line.pluginCalls)
                          _PluginCallRow(call: call),
                      ],
                      if (line.notice != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                          child: Text(
                            line.notice!,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
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

/// One model call a Plugin made, as the receipt reads it: the Plugin, the
/// model, the tokens, and the cost when the account was billed for it.
class _PluginCallRow extends StatelessWidget {
  final PluginModelCall call;
  const _PluginCallRow({required this.call});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cost = call.cost;
    return ListTile(
      dense: true,
      leading: Icon(
        Icons.extension_outlined,
        size: 18,
        color: theme.colorScheme.primary,
      ),
      title: Text(call.pluginId, style: theme.textTheme.bodyMedium),
      subtitle: Text(
        '${call.model} · ${call.inputTokens} in, ${call.outputTokens} out'
        '${cost == null ? '' : ' · $cost'}',
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}

class _ToolRow extends StatelessWidget {
  final ToolActivity tool;
  const _ToolRow({required this.tool});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (icon, colour) = switch (tool.status) {
      'failed' => (Icons.error_outline, theme.colorScheme.error),
      'running' => (Icons.more_horiz, theme.colorScheme.onSurfaceVariant),
      _ => (Icons.check_circle_outline, theme.colorScheme.primary),
    };
    return ExpansionTile(
      dense: true,
      shape: const Border(),
      collapsedShape: const Border(),
      leading: Icon(icon, size: 18, color: colour),
      title: Text(tool.name, style: theme.textTheme.bodyMedium),
      subtitle: Text(tool.status, style: theme.textTheme.bodySmall),
      childrenPadding: const EdgeInsets.fromLTRB(52, 0, 16, 12),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (tool.input != null)
          SelectableText(
            '${tool.input}',
            style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
          ),
        if (tool.text != null) ...[
          const SizedBox(height: 8),
          SelectableText(tool.text!, style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}
