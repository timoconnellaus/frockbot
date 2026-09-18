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
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../orientation.dart';
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../theme/dialogs.dart';
import '../theme/states.dart';
import '../view/embed.dart';
import '../view/host_frame.dart';
import 'client.dart';

/// The desktop, framed. Also the widget the `computer-viewer` host frame
/// resolves to for any `embed` node under a Computer surface.
///
/// The viewer is first-party and addresses its own origin, so this frame keeps it —
/// which is the one place a framed page here does.
class ComputerViewerFrame extends StatelessWidget {
  final String viewerUrl;

  /// The one client-visible input fence. The card never asks for control, so
  /// its URL is always the view-only one.
  final bool controlling;
  final bool fullscreen;
  const ComputerViewerFrame({
    super.key,
    required this.viewerUrl,
    this.controlling = false,
    this.fullscreen = false,
  });

  @override
  Widget build(BuildContext context) {
    final url = viewerUrlForControlV1(viewerUrl, controlling);
    return HostFrame(
      borderRadius: fullscreen
          ? BorderRadius.zero
          : const BorderRadius.all(Radius.circular(12)),
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

  /// Whose Computer this is, so the full window can say so.
  final String? botName;

  /// How this surface opens the desktop, where the shell wants to own that —
  /// it knows the Bot's name and where the window belongs. Without one the
  /// card opens the full window itself. Either way there is one destination:
  /// the desktop, full window, with Take control in it.
  final VoidCallback? onOpen;
  const ComputerCard({
    super.key,
    required this.controller,
    this.turnRunning = false,
    this.botName,
    this.onOpen,
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
    final status = computerCardStatusV1(
      streaming: _streaming,
      unconfigured: unconfigured,
      message: state.message,
      failure: controller.failure,
      capturedAt: screenshot?.capturedAt,
      now: _now,
    );
    final theme = Theme.of(context);
    final open = unconfigured || controller.busy
        ? null
        : widget.onOpen ?? () => unawaited(_open(context));
    final screen = Semantics(
      button: !unconfigured,
      label: 'Open computer in full window',
      child: AspectRatio(
        aspectRatio: 16 / 10,
        child: Material(
          clipBehavior: Clip.antiAlias,
          color: theme.colorScheme.surfaceContainerHighest,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(15)),
          ),
          child: InkWell(
            onTap: open,
            child: _screen(context, opening, screenshot),
          ),
        ),
      ),
    );
    return HostViewFrames(
      frames: {
        if (state.viewerUrl case final String url)
          computerViewerFrameV1: (_) => ComputerViewerFrame(viewerUrl: url),
      },
      child: identified(
        ComputerIds.card,
        Card(
          margin: EdgeInsets.zero,
          clipBehavior: Clip.antiAlias,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [screen, _statusRow(context, status, open)],
          ),
        ),
      ),
    );
  }

  /// The line the card always carries: a dot for live or idle, what the
  /// Computer is doing, and the way in.
  Widget _statusRow(BuildContext context, String status, VoidCallback? open) {
    final theme = Theme.of(context);
    return identified(
      ComputerIds.status,
      InkWell(
        onTap: open,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
          child: Row(
            children: [
              Icon(
                Icons.circle,
                size: 8,
                color: _streaming
                    ? theme.colorScheme.primary
                    : theme.colorScheme.outline,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  status,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall,
                ),
              ),
              if (open != null) ...[
                const SizedBox(width: 8),
                identified(
                  SettingsIds.botPageComputer,
                  Text(
                    'Open',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
                // Where it goes, said in the icon: the desktop fills the
                // window rather than opening another page with a smaller copy
                // of this same frame on it.
                Icon(
                  Icons.open_in_full_rounded,
                  size: 16,
                  color: theme.colorScheme.primary,
                ),
              ],
            ],
          ),
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
      // Native captures need the account's bearer-authenticated transport.
      return FutureBuilder<Uint8List>(
        key: ValueKey(screenshot.contentHash),
        future: controller.capture(screenshot),
        builder: (context, read) {
          final bytes = read.data;
          if (read.hasError) {
            return const Center(
              child: Text('Couldn’t load the computer screenshot.'),
            );
          }
          if (bytes == null) return _placeholder(context, opening);
          return Image.memory(
            bytes,
            fit: BoxFit.cover,
            errorBuilder: (context, _, _) => _placeholder(context, opening),
          );
        },
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
                  // The card's own status row says the state under the frame,
                  // so the frame does not say it a second time. A refusal is
                  // the exception: it is what the reader needs first.
                  if (controller.failure != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      // What refused, where something did: a projection nobody
                      // could read is not a Computer that said anything.
                      controller.failure ?? state.message,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ],
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) =>
      openComputerViewerV1(context, controller, botName: widget.botName);
}

/// Opens the full viewer immediately while the connection command runs.
Future<void> openComputerViewerV1(
  BuildContext context,
  ComputerController controller, {
  String? botName,
}) async {
  // Attaching to a desktop that is already up, or waking one that is not. The
  // authority decides which; this is one command either way.
  unawaited(controller.open());
  if (!context.mounted) return;
  await Navigator.of(context).push(
    MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) =>
          ComputerViewerPage(controller: controller, botName: botName),
    ),
  );
  await controller.close();
}

/// The full-window viewer: the desktop, who is driving it, and the one way to
/// take over.
class ComputerViewerPage extends StatefulWidget {
  final ComputerController controller;

  /// Whose Computer this is, for the title. Absent where the surface that
  /// opened it does not know — the card inside a Package page, say.
  final String? botName;
  const ComputerViewerPage({super.key, required this.controller, this.botName});

  @override
  State<ComputerViewerPage> createState() => _ComputerViewerPageState();
}

class _ComputerViewerPageState extends State<ComputerViewerPage>
    with WidgetsBindingObserver {
  ComputerController get controller => widget.controller;
  ui.FlutterView? _view;
  bool _landscape = false;
  bool _wasLandscape = false;
  bool _closing = false;
  bool _showTakeControl = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(setMobileOrientation(computerOpen: true));
    controller.addListener(_repaint);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(setComputerFullscreen(false));
    unawaited(setMobileOrientation());
    controller.removeListener(_repaint);
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _view = View.of(context);
    _updateOrientation();
  }

  @override
  void didChangeMetrics() => _updateOrientation();

  void _updateOrientation() {
    if (!isNativeMobile || _view == null || _closing) return;
    // Keyboard insets change the available layout, not the device orientation.
    final size = _view!.physicalSize;
    if (size.isEmpty) return;
    final landscape = size.width > size.height;
    if (_landscape != landscape) {
      setState(() => _landscape = landscape);
      unawaited(setComputerFullscreen(landscape));
    }
    if (landscape) {
      _wasLandscape = true;
    } else if (_wasLandscape) {
      _closing = true;
      final route = ModalRoute.of(context)!;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !route.isActive) return;
        final navigator = Navigator.of(context);
        navigator.popUntil((candidate) => candidate == route);
        navigator.pop();
      });
    }
  }

  void _repaint() {
    if (mounted) {
      setState(() {
        if (controller.state.phase == 'human-control') _showTakeControl = false;
      });
    }
  }

  Future<void> _confirmTakeControl() =>
      confirmComputerTakeControlV1(context, controller);

  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    // The one sentence this window has: what the Computer said, or what
    // refused to say it.
    final said = controller.said;
    final human = state.phase == 'human-control';
    final opening = state.phase == 'provisioning' || state.phase == 'updating';
    final url = state.viewerUrl;
    final actions = <Widget>[
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
              state.phase == 'taking-control' ? 'Pausing Bot…' : 'Take control',
            ),
          ),
        ),
    ];
    return Scaffold(
      appBar: _landscape
          ? null
          : AppBar(
              // What the Computer is doing, said once: as the subtitle of the
              // one title, rather than as a strip under the chrome that
              // repeated whatever the centre of the window already said.
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    widget.botName == null
                        ? 'Computer'
                        : 'Computer · ${widget.botName}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  identified(
                    ComputerIds.phase,
                    Text(
                      said,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
              actions: actions,
            ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          identified(
            ComputerIds.viewer,
            SafeArea(
              left: !_landscape,
              top: !_landscape,
              right: !_landscape,
              bottom: !_landscape,
              child: url == null || opening
                  ? opening
                        ? Center(
                            child: Padding(
                              padding: const EdgeInsets.all(24),
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  maxWidth: 420,
                                ),
                                child: ComputerOpening(state: state),
                              ),
                            ),
                          )
                        : FrockEmptyState(
                            icon: Icons.desktop_windows_outlined,
                            title: 'No computer',
                            detail: said,
                            action: 'Try again',
                            onAction: () =>
                                unawaited(controller.command('connect')),
                          )
                  : ComputerViewerFrame(
                      viewerUrl: url,
                      controlling: human,
                      fullscreen: _landscape,
                    ),
            ),
          ),
          if (url != null && !opening && !human)
            SafeArea(
              left: !_landscape,
              top: !_landscape,
              right: !_landscape,
              bottom: !_landscape,
              child: Semantics(
                label: 'Show Computer controls',
                button: true,
                child: GestureDetector(
                  key: const ValueKey('computer-view-only-tap'),
                  behavior: HitTestBehavior.opaque,
                  onTap: controller.busy
                      ? null
                      : () => setState(
                          () => _showTakeControl = !_showTakeControl,
                        ),
                ),
              ),
            ),
          if (_showTakeControl && url != null && !opening && !human)
            Center(
              child: SafeArea(
                child: Material(
                  color: Theme.of(context).colorScheme.surface,
                  borderRadius: BorderRadius.circular(16),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          controller.failure ??
                              'Pause the Bot and use its computer.',
                        ),
                        const SizedBox(height: 12),
                        FilledButton(
                          key: const ValueKey('computer-tap-take-control'),
                          onPressed:
                              controller.busy || state.phase == 'taking-control'
                              ? null
                              : () => unawaited(controller.takeControl()),
                          child: Text(
                            controller.busy || state.phase == 'taking-control'
                                ? 'Pausing Bot…'
                                : 'Take control',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          if (human)
            IgnorePointer(
              child: Semantics(
                label: 'You are controlling the computer',
                child: DecoratedBox(
                  key: const ValueKey('computer-control-border'),
                  decoration: BoxDecoration(
                    border: Border.all(color: FrockTheme.accent, width: 3),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Take control asks first, and cannot reach the Bot until the second,
/// confirmed gesture. The card's page and the full window ask the same
/// question, so they ask it from here.
Future<void> confirmComputerTakeControlV1(
  BuildContext context,
  ComputerController controller,
) async {
  final taken = await showDialog<bool>(
    context: context,
    builder: (dialog) => identified(
      ComputerIds.takeControlConfirm,
      AlertDialog(
        insetPadding: frockDialogInset,
        title: frockDialogTitle(const Text('Take control?')),
        content: frockDialogBody(
          const Text(
            'The Bot pauses while you are driving. Release control to give it '
            'the keyboard back.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialog).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialog).pop(true),
            child: const Text('Take control'),
          ),
        ],
      ),
    ),
  );
  if (taken ?? false) await controller.takeControl();
}
