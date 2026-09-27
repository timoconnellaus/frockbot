/// Showing the Bot how: Record while you hold control, and the panel a
/// finished recording waits in until you send it or throw it away.
///
/// A recording is the Computer's browser only, and never what was typed:
/// the Computer records which field, not its contents, and covers form
/// fields in its screenshots. These widgets say so where the person
/// decides — before they press Record, and before they send.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import 'client.dart';

/// Record, or Stop and how long it has run. Offered only to the person
/// holding control, because only they are recorded.
class ComputerRecordButton extends StatelessWidget {
  final ComputerController controller;
  const ComputerRecordButton({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final demonstration = controller.state.demonstration;
    final recording = demonstration?.recording ?? false;
    return identified(
      ComputerIds.record,
      Tooltip(
        message: recording
            ? 'Stop recording and keep what you did'
            : 'Record what you do so the Bot can learn it. '
                  '$computerRecordingScopeV1',
        child: TextButton.icon(
          onPressed: controller.busy
              ? null
              : () => unawaited(
                  recording
                      ? controller.stopRecording()
                      : controller.startRecording(),
                ),
          icon: Icon(
            recording ? Icons.stop_circle_outlined : Icons.fiber_manual_record,
            color: FrockTheme.accent,
            size: 18,
          ),
          label: Text(recording ? 'Stop' : 'Record'),
        ),
      ),
    );
  }
}

/// The mark over the desktop while a recording runs: that it is, for how
/// long, and what it covers.
class ComputerRecordingPill extends StatefulWidget {
  final ComputerDemonstration demonstration;
  const ComputerRecordingPill({super.key, required this.demonstration});

  @override
  State<ComputerRecordingPill> createState() => _ComputerRecordingPillState();
}

class _ComputerRecordingPillState extends State<ComputerRecordingPill> {
  late final Timer _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final elapsed = computerRecordingElapsedV1(
      DateTime.now().difference(widget.demonstration.startedAt),
    );
    final theme = Theme.of(context);
    return identified(
      ComputerIds.recording,
      Semantics(
        liveRegion: true,
        label: 'Recording, $elapsed. Only the browser is recorded.',
        child: ExcludeSemantics(
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: theme.colorScheme.surface.withValues(alpha: 0.92),
              borderRadius: BorderRadius.circular(FrockTheme.radiusPill),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    Icons.fiber_manual_record,
                    color: FrockTheme.accent,
                    size: 12,
                  ),
                  const SizedBox(width: 6),
                  Text(
                    'Recording $elapsed',
                    style: theme.textTheme.labelMedium?.copyWith(
                      fontFeatures: FrockTheme.tabularFigures,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'Only the browser',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
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
}

/// Why the last recording command did nothing, until the next one.
class ComputerRecordingNotice extends StatelessWidget {
  final ComputerController controller;
  const ComputerRecordingNotice({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final notice = controller.recordingNotice;
    if (notice == null) return const SizedBox.shrink();
    return identified(
      ComputerIds.recordingNotice,
      Material(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 4, 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(child: Text(notice)),
              IconButton(
                tooltip: 'Dismiss',
                onPressed: controller.dismissRecordingNotice,
                icon: const Icon(Icons.close, size: 18),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A finished recording, waiting for the person to decide: what they showed
/// the Bot, and Send or Discard. Sending is an ordinary message carrying the
/// recording's files, so the conversation shows exactly what the Bot got.
class ComputerTeachPanel extends StatefulWidget {
  final ComputerController controller;
  final ComputerDemonstration demonstration;

  /// Whose Computer this is, to say who is being taught.
  final String? botName;

  /// After the message is sent: the conversation is where the Bot answers.
  final VoidCallback? onSent;
  const ComputerTeachPanel({
    super.key,
    required this.controller,
    required this.demonstration,
    this.botName,
    this.onSent,
  });

  @override
  State<ComputerTeachPanel> createState() => _ComputerTeachPanelState();
}

class _ComputerTeachPanelState extends State<ComputerTeachPanel> {
  final _name = TextEditingController();
  bool _sending = false;
  String? _failure;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() {
      _sending = true;
      _failure = null;
    });
    final sent = await widget.controller.teach(_name.text);
    if (!mounted) return;
    setState(() {
      _sending = false;
      if (!sent) _failure = 'Couldn’t send it. Try again.';
    });
    if (sent) widget.onSent?.call();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final demonstration = widget.demonstration;
    final steps = demonstration.steps;
    final shots = demonstration.screenshots;
    final canSend = widget.controller.onTeach != null;
    final who = widget.botName ?? 'the Bot';
    return identified(
      ComputerIds.teach,
      Material(
        color: theme.colorScheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(FrockTheme.radiusSheet),
          side: BorderSide(color: FrockTheme.hairline(theme.colorScheme)),
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Teach $who this?', style: theme.textTheme.titleMedium),
                const SizedBox(height: 6),
                Text(
                  '$steps ${steps == 1 ? 'step' : 'steps'}'
                  '${shots == 0 ? '' : ' and $shots ${shots == 1 ? 'screenshot' : 'screenshots'}'}'
                  ' from the browser. $computerRecordingScopeV1',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 14),
                identified(
                  ComputerIds.teachName,
                  TextField(
                    controller: _name,
                    enabled: canSend && !_sending,
                    autofocus: true,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) {
                      if (canSend && !_sending) unawaited(_send());
                    },
                    decoration: const InputDecoration(
                      labelText: 'What did you show it?',
                      hintText: 'Book a squash court',
                    ),
                  ),
                ),
                if (_failure != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _failure!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                  ),
                ],
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    identified(
                      ComputerIds.teachDiscard,
                      TextButton(
                        onPressed: _sending || widget.controller.busy
                            ? null
                            : () => unawaited(
                                widget.controller.discardRecording(),
                              ),
                        child: const Text('Discard'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    identified(
                      ComputerIds.teachSend,
                      FilledButton(
                        onPressed: canSend && !_sending
                            ? () => unawaited(_send())
                            : null,
                        child: Text(_sending ? 'Sending…' : 'Send to $who'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
