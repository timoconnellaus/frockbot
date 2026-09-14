/// What a Turn actually did, and the trail that says it is still doing it.
///
/// Two things live here because they are the same fact drawn twice. The trail
/// is the wordless one: particles stream off the working Bot's avatar and
/// their density is the Turn's own pace — text arriving quickly is a dense
/// stream, a tool call starting or settling throws a burst, a Turn waiting on
/// the model still breathes so the app never reads as dead. It never names
/// what happened, because the thread stays a conversation.
///
/// The run view is where the naming happens. Tool receipts are not chat: the
/// thread is the Bot's words, and what it called to produce them belongs on a
/// Work view the person opens from the message. On the phone that is a page;
/// at wide widths it is the right panel.
library;

import 'dart:math' as math;

import 'package:flutter/scheduler.dart' show Ticker;

import 'package:flutter/material.dart';

import '../flock/sheep.dart';
import 'semantics.dart';
import 'transcript_model.dart';

// ------------------------------------------------------------- the trail

/// The most particles a second the trail will ever ask for.
const double activityTrailMaxRate = 40;

/// The floor while a Turn is open. A Turn waiting on a model that has not sent
/// a token yet is still working, and a trail that stops reads as a crash.
const double activityTrailTrickleRate = 6;

/// Silence longer than this is a wait, not a pause between chunks.
const Duration activityTrailQuietAfter = Duration(milliseconds: 1500);

/// How far back the chunk-rate average looks.
const Duration activityTrailRateWindow = Duration(milliseconds: 1200);

/// Characters of streamed text one particle stands for.
const int activityTrailCharactersPerParticle = 6;

/// A tool call starting, or its result settling.
const int activityTrailToolBurst = 15;

/// A payload reaching the person.
const int activityTrailSendBurst = 14;

/// The most burst events one step will honour, so a reconnect replaying a
/// whole Turn does not fire two hundred bursts into the same frame.
const int activityTrailMaxBurstsPerStep = 4;

/// `running` is work arriving now, `waiting` is an open Turn gone quiet, and
/// `ended` is a settled Turn: nothing new is emitted and the field drains.
enum ActivityTrailState { running, waiting, ended }

/// One reading of the open Turn, as the client's projection has it.
class ActivityTrailSample {
  final int characters;
  final int toolStarts;
  final int toolSettles;
  final int sends;

  /// The whole status string rather than a union: only `streaming` means the
  /// Turn is still going, so a status this file has never heard of ends the
  /// trail rather than leaving it emitting forever.
  final String status;
  const ActivityTrailSample({
    required this.characters,
    required this.toolStarts,
    required this.toolSettles,
    required this.sends,
    required this.status,
  });

  /// A sample read off the transcript's own vocabulary.
  factory ActivityTrailSample.fromLine(TranscriptLine line) =>
      ActivityTrailSample(
        characters: line.text.length,
        toolStarts: line.tools.length,
        toolSettles: line.tools
            .where((tool) => tool.status != 'running')
            .length,
        sends: line.sends.length,
        status: line.status == LineStatus.streaming ? 'streaming' : 'ended',
      );
}

class ActivityTrailBurst {
  final int count;
  final double speed;
  final double brightness;
  const ActivityTrailBurst(this.count, this.speed, this.brightness);
}

class ActivityTrailPlan {
  final bool active;
  final ActivityTrailState state;
  final double rate;
  final List<ActivityTrailBurst> bursts;
  const ActivityTrailPlan(this.active, this.state, this.rate, this.bursts);
}

/// What the mapping remembers between two samples.
class ActivityTrailMemory {
  final ActivityTrailSample sample;
  final Duration lastEventAt;
  final List<({Duration at, int characters})> window;
  const ActivityTrailMemory(this.sample, this.lastEventAt, this.window);
}

ActivityTrailMemory activityTrailBegin(
  ActivityTrailSample sample,
  Duration now,
) => ActivityTrailMemory(sample, now, const []);

/// The plan for the moment between the remembered sample and this one.
///
/// Deltas are floored at zero: a projection that replaces a Turn's text with a
/// shorter final version is not a negative amount of work, it is no work.
({ActivityTrailMemory memory, ActivityTrailPlan plan}) activityTrailStep(
  ActivityTrailMemory memory,
  ActivityTrailSample sample,
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
      memory: ActivityTrailMemory(sample, memory.lastEventAt, const []),
      plan: const ActivityTrailPlan(false, ActivityTrailState.ended, 0, []),
    );
  }

  final window = [
    ...memory.window,
    (at: now, characters: characters),
  ].where((entry) => now - entry.at <= activityTrailRateWindow).toList();
  final streamed = window.fold(0, (total, entry) => total + entry.characters);
  final streamRate =
      streamed /
      (activityTrailRateWindow.inMilliseconds / 1000) /
      activityTrailCharactersPerParticle;

  final moved =
      characters > 0 || startedTools > 0 || settledTools > 0 || delivered > 0;
  final lastEventAt = moved ? now : memory.lastEventAt;
  final quiet = now - lastEventAt > activityTrailQuietAfter;

  final bursts = <ActivityTrailBurst>[
    for (var index = 0; index < startedTools + settledTools; index++)
      const ActivityTrailBurst(activityTrailToolBurst, 1.8, 1.15),
    for (var index = 0; index < delivered; index++)
      const ActivityTrailBurst(activityTrailSendBurst, 1.2, 1.9),
  ];

  return (
    memory: ActivityTrailMemory(sample, lastEventAt, window),
    plan: ActivityTrailPlan(
      true,
      quiet ? ActivityTrailState.waiting : ActivityTrailState.running,
      math.min(
        activityTrailMaxRate,
        math.max(streamRate, activityTrailTrickleRate),
      ),
      bursts.take(activityTrailMaxBurstsPerStep).toList(),
    ),
  );
}

/// The working row: the Bot's avatar with the trail streaming off it, and the
/// only words it ever says — the ones a supersede drain needs.
class WorkingIndicator extends StatefulWidget {
  static const double avatarSize = 28;

  final TranscriptLine line;
  final String? label;

  /// The Bot's sheep, so the working row wears the same one the thread and the
  /// sidebar do.
  final String? background;
  const WorkingIndicator({
    super.key,
    required this.line,
    this.label,
    this.background,
  });

  @override
  State<WorkingIndicator> createState() => _WorkingIndicatorState();
}

class _WorkingIndicatorState extends State<WorkingIndicator>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  final _particles = <_Particle>[];
  final _random = math.Random(7);
  late ActivityTrailMemory _memory = activityTrailBegin(
    ActivityTrailSample.fromLine(widget.line),
    Duration.zero,
  );
  ActivityTrailPlan _plan = const ActivityTrailPlan(
    true,
    ActivityTrailState.running,
    activityTrailTrickleRate,
    [],
  );
  Duration _last = Duration.zero;
  double _owed = 0;

  /// The trail is motion and nothing else, so a person who asked for less of
  /// it gets none: the ticker does not run at all rather than running into a
  /// hidden canvas.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.disableAnimationsOf(context);
    if (still && _ticker.isActive) {
      _ticker.stop();
    } else if (!still && !_ticker.isActive) {
      _ticker.start();
    }
  }

  void _tick(Duration elapsed) {
    final seconds = ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 0.05);
    _last = elapsed;
    final stepped = activityTrailStep(
      _memory,
      ActivityTrailSample.fromLine(widget.line),
      elapsed,
    );
    _memory = stepped.memory;
    _plan = stepped.plan;
    if (_plan.active) {
      _owed += _plan.rate * seconds;
      while (_owed >= 1) {
        _owed -= 1;
        _spawn(1, 1);
      }
      for (final burst in _plan.bursts) {
        _spawn(burst.count, burst.speed, brightness: burst.brightness);
      }
    }
    for (final particle in _particles) {
      particle.advance(seconds);
    }
    _particles.removeWhere((particle) => particle.life <= 0);
    if (mounted) setState(() {});
  }

  void _spawn(int count, double speed, {double brightness = 1}) {
    for (var index = 0; index < count && _particles.length < 220; index++) {
      _particles.add(
        _Particle(
          dy: (_random.nextDouble() - 0.5) * 10,
          speed: (26 + _random.nextDouble() * 46) * speed,
          drift: (_random.nextDouble() - 0.5) * 24,
          brightness: brightness,
        ),
      );
    }
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final still = MediaQuery.disableAnimationsOf(context);
    return identified(
      ShellIds.workingIndicator,
      Semantics(
        liveRegion: true,
        label: widget.label ?? 'Working',
        child: Row(
          children: [
            SheepAvatar(
              size: WorkingIndicator.avatarSize,
              background: widget.background,
            ),
            SizedBox(
              width: 96,
              height: WorkingIndicator.avatarSize,
              child: still
                  ? const SizedBox.shrink()
                  : CustomPaint(
                      painter: _TrailPainter(
                        _particles,
                        theme.colorScheme.primary,
                      ),
                    ),
            ),
            if (widget.label != null)
              Flexible(
                child: Text(
                  widget.label!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Particle {
  double x = 0;
  final double dy;
  final double speed;
  final double drift;
  final double brightness;
  double life = 1;
  _Particle({
    required this.dy,
    required this.speed,
    required this.drift,
    required this.brightness,
  });

  void advance(double seconds) {
    x += speed * seconds;
    life -= seconds * 1.1;
  }
}

class _TrailPainter extends CustomPainter {
  final List<_Particle> particles;
  final Color colour;
  const _TrailPainter(this.particles, this.colour);

  @override
  void paint(Canvas canvas, Size size) {
    final centre = size.height / 2;
    for (final particle in particles) {
      if (particle.x > size.width) continue;
      final paint = Paint()
        ..color = colour.withValues(
          alpha: (particle.life * 0.7 * particle.brightness).clamp(0.0, 1.0),
        );
      canvas.drawCircle(
        Offset(
          particle.x,
          centre + particle.dy + particle.drift * (1 - particle.life),
        ),
        1.6,
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_TrailPainter oldDelegate) => true;
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
            Padding(
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
