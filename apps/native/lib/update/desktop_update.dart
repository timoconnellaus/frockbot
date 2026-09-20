/// Desktop application updates: one press, from "available" to relaunched.
///
/// A desktop build is a whole signed app, so it updates by replacing itself
/// rather than by a Shorebird patch. On macOS Sparkle does the downloading,
/// signature verification, staging and the swap of the bundle; this file owns
/// what the person sees and the one step Sparkle cannot know about — saving
/// local state before the process goes away. `docs/app-updates.md` records how
/// the other platforms will fit the same seam.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shell/semantics.dart';

/// Where the platform updater is, in its own words.
enum DesktopUpdatePhase {
  /// No updater in this build (a development build has no feed) or nothing
  /// newer than what is running.
  idle,
  available,
  downloading,

  /// Downloaded; being verified and unpacked beside the running app.
  preparing,

  /// Staged and waiting only for this process to exit.
  ready,

  /// The process was asked to exit so the installer can swap the bundle.
  installing,
  failed,
}

class DesktopUpdateSnapshot {
  final DesktopUpdatePhase phase;

  /// The release on offer. The feed only ever names the newest one.
  final String? version;

  /// The archive is already on disk from an earlier session.
  final bool downloaded;
  final int received;
  final int? expected;

  const DesktopUpdateSnapshot({
    this.phase = DesktopUpdatePhase.idle,
    this.version,
    this.downloaded = false,
    this.received = 0,
    this.expected,
  });

  static DesktopUpdateSnapshot decode(Object? value) {
    if (value is! Map) return const DesktopUpdateSnapshot();
    final phase = DesktopUpdatePhase.values.asNameMap()[value['phase']];
    int? integer(Object? raw) => raw is num ? raw.toInt() : null;
    final version = value['version'];
    return DesktopUpdateSnapshot(
      phase: phase ?? DesktopUpdatePhase.idle,
      version: version is String && version.isNotEmpty ? version : null,
      downloaded: value['downloaded'] == true,
      received: integer(value['received']) ?? 0,
      expected: integer(value['expected']),
    );
  }
}

/// The platform half. Tests drive this seam; the app's only implementation
/// today is [MacDesktopUpdater].
abstract interface class DesktopUpdater {
  Stream<DesktopUpdateSnapshot> get changes;
  Future<DesktopUpdateSnapshot> current();

  /// Looks for a newer release without downloading it. An offer still waiting
  /// on the person is replaced by whatever is newest now.
  Future<void> check();

  /// Downloads, verifies and stages the newest release.
  Future<void> download();

  /// Lets the staged release install: the app exits and is relaunched.
  /// False when nothing was staged to install.
  Future<bool> install();
}

class MacDesktopUpdater implements DesktopUpdater {
  static const channel = MethodChannel('com.frockbot/update');
  final _changes = StreamController<DesktopUpdateSnapshot>.broadcast();

  MacDesktopUpdater() {
    channel.setMethodCallHandler((call) async {
      if (call.method == 'state') {
        _changes.add(DesktopUpdateSnapshot.decode(call.arguments));
      }
    });
  }

  @override
  Stream<DesktopUpdateSnapshot> get changes => _changes.stream;

  @override
  Future<DesktopUpdateSnapshot> current() async {
    try {
      return DesktopUpdateSnapshot.decode(
        await channel.invokeMethod<Object?>('state'),
      );
    } on MissingPluginException {
      return const DesktopUpdateSnapshot();
    }
  }

  @override
  Future<void> check() => _call('check');

  @override
  Future<void> download() => _call('download');

  @override
  Future<bool> install() async {
    try {
      return await channel.invokeMethod<bool>('install') ?? false;
    } on MissingPluginException {
      return false;
    }
  }

  Future<void> _call(String method) async {
    try {
      await channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // A host without the native updater simply never offers one.
    }
  }
}

/// What the control beside the profile shows.
sealed class DesktopUpdateState {
  const DesktopUpdateState();
}

final class NoDesktopUpdate extends DesktopUpdateState {
  const NoDesktopUpdate();
}

final class UpdateAvailable extends DesktopUpdateState {
  final String? version;
  const UpdateAvailable(this.version);
}

final class UpdateDownloading extends DesktopUpdateState {
  final String? version;

  /// 0..1, or null until the server has said how large the archive is.
  final double? progress;
  const UpdateDownloading(this.version, this.progress);
}

final class UpdatePreparing extends DesktopUpdateState {
  final String? version;
  const UpdatePreparing(this.version);
}

/// Staged. Pressing restarts into it without downloading again.
final class UpdateReadyToRestart extends DesktopUpdateState {
  final String? version;

  /// The last attempt to restart did not happen; the running app is intact.
  final bool restartFailed;
  const UpdateReadyToRestart(this.version, {this.restartFailed = false});
}

final class UpdateRestarting extends DesktopUpdateState {
  final String? version;
  const UpdateRestarting(this.version);
}

final class UpdateFailed extends DesktopUpdateState {
  final String? version;
  const UpdateFailed(this.version);
}

class DesktopUpdateController extends ChangeNotifier {
  final DesktopUpdater updater;
  final Future<void> Function() beforeRestart;
  StreamSubscription<DesktopUpdateSnapshot>? _subscription;
  DesktopUpdateState _state = const NoDesktopUpdate();
  DesktopUpdateSnapshot _native = const DesktopUpdateSnapshot();

  /// The person pressed Update, so a staged release goes straight on to the
  /// restart. Without it a staged release waits for a press.
  bool _applyWhenReady = false;
  bool _restarting = false;
  bool _restartFailed = false;
  bool _disposed = false;

  DesktopUpdateController({
    required this.updater,
    Future<void> Function()? beforeRestart,
  }) : beforeRestart = beforeRestart ?? _nothing;

  static Future<void> _nothing() async {}

  DesktopUpdateState get state => _state;

  /// Starts following the platform updater and asks it to look once.
  Future<void> start() async {
    _subscription ??= updater.changes.listen(_receive);
    try {
      _receive(await updater.current());
      await updater.check();
    } catch (_) {
      // Discovery is opportunistic; the next check is the retry.
    }
  }

  Future<void> check() async {
    try {
      await updater.check();
    } catch (_) {}
  }

  /// The one action behind the control, whatever it currently says.
  Future<void> update() async {
    switch (_state) {
      case NoDesktopUpdate() ||
          UpdateDownloading() ||
          UpdatePreparing() ||
          UpdateRestarting():
        return;
      case UpdateReadyToRestart()
          when _native.phase == DesktopUpdatePhase.ready:
        _applyWhenReady = true;
        await _restart();
      case UpdateAvailable() || UpdateReadyToRestart() || UpdateFailed():
        _applyWhenReady = true;
        _restartFailed = false;
        // Show the press at once; the platform's first progress replaces it.
        _set(UpdateDownloading(_native.version, null));
        try {
          await updater.download();
        } catch (_) {
          _set(UpdateFailed(_native.version));
        }
    }
  }

  void _receive(DesktopUpdateSnapshot snapshot) {
    if (_disposed) return;
    _native = snapshot;
    final version = snapshot.version;
    switch (snapshot.phase) {
      case DesktopUpdatePhase.idle:
        _applyWhenReady = false;
        _set(const NoDesktopUpdate());
      case DesktopUpdatePhase.available:
        _set(
          snapshot.downloaded
              ? UpdateReadyToRestart(version)
              : UpdateAvailable(version),
        );
      case DesktopUpdatePhase.downloading:
        final expected = snapshot.expected;
        _set(
          UpdateDownloading(
            version,
            expected == null || expected <= 0
                ? null
                : (snapshot.received / expected).clamp(0.0, 1.0).toDouble(),
          ),
        );
      case DesktopUpdatePhase.preparing:
        _set(UpdatePreparing(version));
      case DesktopUpdatePhase.ready:
        if (_applyWhenReady && !_restartFailed) {
          unawaited(_restart());
        } else if (!_restarting) {
          _set(UpdateReadyToRestart(version, restartFailed: _restartFailed));
        }
      case DesktopUpdatePhase.installing:
        _set(UpdateRestarting(version));
      case DesktopUpdatePhase.failed:
        _applyWhenReady = false;
        _set(UpdateFailed(version));
    }
  }

  /// Local state is committed before the platform may end the process. A
  /// checkpoint that fails keeps the app running and the update staged.
  Future<void> _restart() async {
    if (_restarting) return;
    _restarting = true;
    _restartFailed = false;
    final version = _native.version;
    _set(UpdateRestarting(version));
    var installing = false;
    try {
      await beforeRestart();
      installing = await updater.install();
    } catch (_) {
      installing = false;
    } finally {
      _restarting = false;
    }
    // Either way the next press is the person's: if the platform reports the
    // update ready again after being asked to install, the app did not quit.
    _restartFailed = true;
    _applyWhenReady = false;
    if (!installing) _set(UpdateReadyToRestart(version, restartFailed: true));
  }

  void _set(DesktopUpdateState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_subscription?.cancel());
    super.dispose();
  }
}

/// Makes the controller reachable from the sidebar header without threading
/// it through every shell layer. Absent on platforms without desktop updates.
class DesktopUpdateScope extends InheritedNotifier<DesktopUpdateController> {
  const DesktopUpdateScope({
    super.key,
    required DesktopUpdateController controller,
    required super.child,
  }) : super(notifier: controller);

  static DesktopUpdateController? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<DesktopUpdateScope>()
      ?.notifier;
}

/// Follows the application lifecycle: a return from a hidden app looks again,
/// so a newer release replaces an older offer instead of queueing behind it.
class DesktopUpdateFrame extends StatefulWidget {
  final DesktopUpdateController controller;
  final Widget child;
  const DesktopUpdateFrame({
    super.key,
    required this.controller,
    required this.child,
  });

  @override
  State<DesktopUpdateFrame> createState() => _DesktopUpdateFrameState();
}

class _DesktopUpdateFrameState extends State<DesktopUpdateFrame>
    with WidgetsBindingObserver {
  bool _wasHidden = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.controller.start());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden) {
      _wasHidden = true;
    } else if (state == AppLifecycleState.resumed && _wasHidden) {
      _wasHidden = false;
      unawaited(widget.controller.check());
    }
  }

  @override
  Widget build(BuildContext context) =>
      DesktopUpdateScope(controller: widget.controller, child: widget.child);

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

/// The blue control beside the profile. It draws nothing until there is
/// something to do, and never blocks the app while it works.
class DesktopUpdateButton extends StatelessWidget {
  static const blue = Color(0xff075fce);
  static const _labelStyle = TextStyle(
    fontFamily: 'Inter',
    fontSize: 13,
    fontWeight: FontWeight.w600,
    height: 1,
  );

  static double _labelWidth(BuildContext context, String label) => (TextPainter(
    text: TextSpan(text: label, style: _labelStyle),
    textDirection: Directionality.of(context),
    textScaler: MediaQuery.textScalerOf(context),
    maxLines: 1,
  )..layout()).width;

  final DesktopUpdateController controller;
  const DesktopUpdateButton({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    final state = controller.state;
    final (String label, String detail, bool enabled) = switch (state) {
      NoDesktopUpdate() => ('', '', false),
      UpdateAvailable(:final version) => (
        'Update',
        version == null ? 'Install the update' : 'Update to $version',
        true,
      ),
      UpdateDownloading(:final progress) => (
        progress == null
            ? 'Downloading…'
            : 'Downloading ${(progress * 100).floor()}%',
        'Downloading the update. FrockBot stays usable.',
        false,
      ),
      UpdatePreparing() => ('Preparing…', 'Verifying the update', false),
      UpdateRestarting() => (
        'Restarting…',
        'Restarting into the update',
        false,
      ),
      UpdateReadyToRestart(:final restartFailed) => (
        restartFailed ? 'Retry restart' : 'Restart to update',
        restartFailed
            ? 'Couldn’t restart. Your work is saved; try again.'
            : 'The update is ready. FrockBot restarts briefly.',
        true,
      ),
      UpdateFailed() => (
        'Retry update',
        'The update didn’t finish. FrockBot is unchanged; try again.',
        true,
      ),
    };
    if (state is NoDesktopUpdate) return const SizedBox.shrink();
    final progress = switch (state) {
      UpdateDownloading(:final progress) => progress,
      _ => null,
    };
    final busy =
        state is UpdateDownloading ||
        state is UpdatePreparing ||
        state is UpdateRestarting;
    final icon = switch (state) {
      UpdateReadyToRestart() => Icons.restart_alt_rounded,
      UpdateFailed() => Icons.refresh_rounded,
      _ => Icons.arrow_circle_up_rounded,
    };
    return Semantics(
      identifier: ShellIds.updateControl,
      container: true,
      liveRegion: true,
      button: true,
      enabled: enabled,
      label: label,
      value: detail,
      excludeSemantics: true,
      child: Tooltip(
        message: detail,
        child: FilledButton(
          onPressed: enabled ? () => unawaited(controller.update()) : null,
          style: FilledButton.styleFrom(
            backgroundColor: blue,
            foregroundColor: Colors.white,
            disabledBackgroundColor: blue.withValues(alpha: 0.72),
            disabledForegroundColor: Colors.white,
            minimumSize: const Size(0, 32),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.compact,
            alignment: Alignment.center,
            shape: const StadiumBorder(),
            textStyle: _labelStyle,
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final mark = busy
                  ? SizedBox.square(
                      dimension: 12,
                      child: CircularProgressIndicator(
                        value: progress,
                        strokeWidth: 2,
                        color: Colors.white,
                        backgroundColor: Colors.white24,
                      ),
                    )
                  : Icon(icon, size: 16, color: Colors.white);
              // A narrow window leaves the row no width for a sentence, so the
              // control keeps its mark and drops to it rather than ellipsising
              // a half-word; the tooltip and semantics still say the whole
              // thing.
              if (_labelWidth(context, label) + (busy ? 18 : 0) >
                  constraints.maxWidth) {
                return mark;
              }
              return Row(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (busy) ...[mark, const SizedBox(width: 6)],
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      softWrap: false,
                      style: _labelStyle,
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}
