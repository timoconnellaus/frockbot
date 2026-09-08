/// The Computer card, and the full-window viewer it opens.
///
/// The card draws the Bot's own screen region as it changes, in the same
/// view-only frame the viewer uses and on the same minted session — no second
/// token, no
/// takeover lease, and no input reaching the desktop. Drawing it wakes
/// nothing: with no session minted the card stays on the stored capture, which
/// the Bot files after every Computer action.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../shell/semantics.dart';
import '../theme/states.dart';
import '../view/embed.dart';
import '../view/host_frame.dart';
import 'client.dart';

/// The desktop, framed. Also the widget the `computer-viewer` host frame
/// resolves to for any `embed` node under a Computer surface.
///
/// noVNC is first-party and addresses its own origin, so this frame keeps it —
/// which is the one place a framed page here does.
class ComputerViewerFrame extends StatelessWidget {
  final String viewerUrl;

  /// The one client-visible input fence. The card never asks for control, so
  /// its URL is always the view-only one.
  final bool controlling;
  const ComputerViewerFrame({
    super.key,
    required this.viewerUrl,
    this.controlling = false,
  });

  @override
  Widget build(BuildContext context) {
    final url = viewerUrlForControlV1(viewerUrl, controlling);
    return HostFrame(
      url: url,
      label: controlling ? 'Computer' : 'Computer, live',
      identity: url,
      allowSameOrigin: true,
    );
  }
}

/// A host mid-operation: what it is doing, how long it usually takes when
/// that is worth promising, the step it is on, and how far along. The card and
/// the full-window viewer draw the same thing, because it is the same run.
class ComputerOpening extends StatelessWidget {
  final ComputerProjection state;
  const ComputerOpening({super.key, required this.state});

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        computerOpeningHeadingV1(state),
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.titleSmall,
      ),
      if (computerColdProvisionV1(state)) ...[
        const SizedBox(height: 4),
        Text(
          computerColdProvisionExpectationV1,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
      const SizedBox(height: 8),
      Semantics(
        liveRegion: true,
        child: Text(
          state.progress?.activeLabel ?? state.message,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ),
      const SizedBox(height: 10),
      identified(
        ComputerIds.progress,
        LinearProgressIndicator(value: state.progress?.fraction),
      ),
    ],
  );
}

/// The card: the screen, and one line saying whether it is the desktop or a
/// photograph of it.
class ComputerCard extends StatefulWidget {
  final ComputerController controller;

  /// A Turn is executing for this Bot right now.
  final bool turnRunning;
  const ComputerCard({
    super.key,
    required this.controller,
    this.turnRunning = false,
  });

  @override
  State<ComputerCard> createState() => _ComputerCardState();
}

class _ComputerCardState extends State<ComputerCard> {
  Timer? _ticker;
  DateTime _now = DateTime.now();
  DateTime? _turnEndedAt;
  bool _lastRunning = false;

  ComputerController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    controller.addListener(_repaint);
    _ticker = Timer.periodic(computerScreenStatusTickV1, (_) {
      if (mounted) setState(() => _now = DateTime.now());
    });
    unawaited(controller.read());
  }

  @override
  void didUpdateWidget(ComputerCard old) {
    super.didUpdateWidget(old);
    if (_lastRunning && !widget.turnRunning) _turnEndedAt = DateTime.now();
    if (widget.turnRunning) _turnEndedAt = null;
    _lastRunning = widget.turnRunning;
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _ticker?.cancel();
    controller.removeListener(_repaint);
    super.dispose();
  }

  bool get _streaming => computerStreamsV1(
    viewerUrl: controller.state.viewerUrl,
    phase: controller.state.phase,
    expanded: controller.expanded,
    turnRunning: widget.turnRunning,
    onScreen: true,
    sinceTurnEnded: _turnEndedAt == null
        ? null
        : _now.difference(_turnEndedAt!),
  );

  @override
  Widget build(BuildContext context) {
    if (!controller.available) return const SizedBox.shrink();
    final state = controller.state;
    final opening = state.phase == 'provisioning' || state.phase == 'updating';
    // A read that failed leaves the last projection standing, which for a card
    // that has never had one is `unknown` — and `unknown` is not the answer
    // "this Bot has no Computer". So a failure is a Computer the card cannot
    // speak for, not one it can say is absent: it opens, and the window says
    // what refused.
    final unconfigured =
        state.phase == 'unconfigured' && controller.failure == null;
    final screenshot = state.screenshots.firstOrNull;
    final status = computerScreenStatusLabelV1(
      streaming: _streaming,
      capturedAt: screenshot?.capturedAt,
      now: _now,
    );
    return HostViewFrames(
      frames: {
        if (state.viewerUrl case final String url)
          computerViewerFrameV1: (_) => ComputerViewerFrame(viewerUrl: url),
      },
      child: identified(
        ComputerIds.card,
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            // A card that says there is no Computer opens nothing: a
            // full-window view repeating the same sentence is a tap that costs
            // a step and answers nothing.
            Semantics(
              button: !unconfigured,
              label: 'Open computer in full window',
              child: AspectRatio(
                aspectRatio: 16 / 10,
                child: Material(
                  clipBehavior: Clip.antiAlias,
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                    side: BorderSide(
                      color: Theme.of(context).colorScheme.outlineVariant,
                    ),
                  ),
                  child: InkWell(
                    onTap: unconfigured || controller.busy
                        ? null
                        : () => unawaited(_open(context)),
                    child: _screen(context, opening, screenshot),
                  ),
                ),
              ),
            ),
            if (status != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: identified(
                  ComputerIds.status,
                  Row(
                    children: [
                      Icon(
                        Icons.circle,
                        size: 8,
                        color: _streaming
                            ? Theme.of(context).colorScheme.primary
                            : Theme.of(context).colorScheme.outline,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        status,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _screen(
    BuildContext context,
    bool opening,
    ComputerScreenshot? screenshot,
  ) {
    final state = controller.state;
    if (!opening && _streaming && state.viewerUrl != null) {
      return ExcludeSemantics(
        child: ComputerViewerFrame(viewerUrl: state.viewerUrl!),
      );
    }
    if (!opening && screenshot != null) {
      return Image.network(
        screenshot.url,
        key: ValueKey(screenshot.contentHash),
        fit: BoxFit.cover,
        errorBuilder: (context, _, _) => _placeholder(context, opening),
      );
    }
    return _placeholder(context, opening);
  }

  Widget _placeholder(BuildContext context, bool opening) {
    final state = controller.state;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: opening
              ? [ComputerOpening(state: state)]
              : [
                  const Icon(Icons.desktop_windows_outlined),
                  const SizedBox(height: 8),
                  Text(switch (state.phase) {
                    'unconfigured' when controller.failure == null =>
                      'No computer',
                    'disconnected' => 'Viewer disconnected',
                    _ => 'Computer',
                  }, style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 4),
                  Text(
                    // What refused, where something did: a projection nobody
                    // could read is not a Computer that said anything.
                    controller.failure ?? state.message,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    await controller.open();
    if (!context.mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => ComputerViewerPage(controller: controller),
      ),
    );
    await controller.close();
  }
}

/// The full-window viewer: the desktop, who is driving it, and the one way to
/// take over.
class ComputerViewerPage extends StatefulWidget {
  final ComputerController controller;
  const ComputerViewerPage({super.key, required this.controller});

  @override
  State<ComputerViewerPage> createState() => _ComputerViewerPageState();
}

class _ComputerViewerPageState extends State<ComputerViewerPage> {
  ComputerController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    controller.addListener(_repaint);
  }

  @override
  void dispose() {
    controller.removeListener(_repaint);
    super.dispose();
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  /// Take control opens local confirmation and cannot reach the Bot until the
  /// second, confirmed gesture.
  Future<void> _confirmTakeControl() async {
    final taken = await showDialog<bool>(
      context: context,
      builder: (context) => identified(
        ComputerIds.takeControlConfirm,
        AlertDialog(
          title: const Text('Take control?'),
          content: const Text(
            'The Bot pauses while you are driving. Release control to give it '
            'the keyboard back.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Take control'),
            ),
          ],
        ),
      ),
    );
    if (taken ?? false) await controller.takeControl();
  }

  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    // The one sentence this window has: what the Computer said, or what
    // refused to say it.
    final said = controller.failure ?? state.message;
    final human = controller.takingControl || state.phase == 'human-control';
    final opening = state.phase == 'provisioning' || state.phase == 'updating';
    final url = state.viewerUrl;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Computer'),
        actions: [
          if (human)
            identified(
              ComputerIds.releaseControl,
              TextButton(
                onPressed: controller.busy
                    ? null
                    : () => unawaited(controller.releaseControl()),
                child: const Text('Release control'),
              ),
            )
          else if (state.phase == 'disconnected')
            identified(
              ComputerIds.reconnect,
              TextButton(
                onPressed: controller.busy
                    ? null
                    : () => unawaited(controller.command('connect')),
                child: const Text('Reconnect'),
              ),
            )
          else if (url != null && !opening)
            identified(
              ComputerIds.takeControl,
              TextButton(
                onPressed: controller.busy || state.phase == 'taking-control'
                    ? null
                    : () => unawaited(_confirmTakeControl()),
                child: Text(
                  state.phase == 'taking-control'
                      ? 'Pausing Bot…'
                      : 'Take control',
                ),
              ),
            ),
        ],
        // What the Computer is doing, under the chrome rather than inside it:
        // an app bar is a few words wide on a phone, and the phase is a
        // sentence.
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(28),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: identified(
                ComputerIds.phase,
                Text(
                  said,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
          ),
        ),
      ),
      body: identified(
        ComputerIds.viewer,
        SafeArea(
          child: url == null || opening
              ? opening
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 420),
                            child: ComputerOpening(state: state),
                          ),
                        ),
                      )
                    : FrockEmptyState(
                        icon: Icons.desktop_windows_outlined,
                        title: 'No computer',
                        detail: said,
                        action: 'Try again',
                        onAction: () => unawaited(controller.read()),
                      )
              : ComputerViewerFrame(viewerUrl: url, controlling: human),
        ),
      ),
    );
  }
}
