/// The mobile update lifecycle and the one piece of UI it earns.
///
/// Shorebird can fetch a patch while this Dart isolate is already running, so
/// the patch only becomes the running program after the platform starts a new
/// engine. The restart service below deliberately uses native restart paths;
/// rebuilding this widget tree would leave plugins and the old engine alive.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:restart_app/restart_app.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';

import '../shell/lifecycle.dart';
import '../shell/semantics.dart';

enum MobileUpdateStatus { upToDate, outdated, restartRequired, unavailable }

/// The two external operations update readiness depends on. Tests drive this
/// seam without loading Shorebird's native updater or restarting their host.
abstract interface class MobileUpdateService {
  Future<MobileUpdateStatus> check();

  /// Fetches the available patch and reports whether one is now staged on
  /// disk for the next engine. Shorebird treats an already-running automatic
  /// download as a benign no-op, so returning normally is not by itself proof
  /// that a patch is waiting.
  Future<bool> download();

  Future<bool> restart();
}

class ShorebirdMobileUpdateService implements MobileUpdateService {
  ShorebirdUpdater? _updater;
  ShorebirdMobileUpdateService();

  ShorebirdUpdater get updater => _updater ??= ShorebirdUpdater();

  bool get _mobile =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  @override
  Future<MobileUpdateStatus> check() async {
    if (!_mobile || !updater.isAvailable) return MobileUpdateStatus.unavailable;
    return switch (await updater.checkForUpdate()) {
      UpdateStatus.upToDate => MobileUpdateStatus.upToDate,
      UpdateStatus.outdated => MobileUpdateStatus.outdated,
      UpdateStatus.restartRequired => MobileUpdateStatus.restartRequired,
      UpdateStatus.unavailable => MobileUpdateStatus.unavailable,
    };
  }

  @override
  Future<bool> download() async {
    await updater.update();
    final (current, next) = await (
      updater.readCurrentPatch(),
      updater.readNextPatch(),
    ).wait;
    return current?.number != next?.number;
  }

  @override
  Future<bool> restart() async {
    if (!_mobile) return false;
    final mode = defaultTargetPlatform == TargetPlatform.android
        ? RestartMode.process
        : RestartMode.flutterEngine;
    return (await Restart.restartApp(mode: mode)).success;
  }
}

class MobileUpdateController extends ChangeNotifier {
  final MobileUpdateService service;
  final Future<void> Function() beforeRestart;
  Future<void>? _checking;
  bool _disposed = false;
  bool restartRequired = false;
  bool restarting = false;
  bool restartFailed = false;

  MobileUpdateController({
    required this.service,
    Future<void> Function()? beforeRestart,
  }) : beforeRestart = beforeRestart ?? _nothing;

  static Future<void> _nothing() async {}

  /// Checks once at a time. The header only appears once a patch is actually
  /// staged on disk, which the download reports directly rather than being
  /// re-derived by a second network request that could fail afterwards and
  /// incorrectly hide the action.
  Future<void> check() {
    final running = _checking;
    if (running != null) return running;
    if (restartRequired) return Future.value();
    final next = _check();
    _checking = next;
    return next.whenComplete(() {
      if (identical(_checking, next)) _checking = null;
    });
  }

  Future<void> _check() async {
    try {
      final status = await service.check();
      final ready = switch (status) {
        MobileUpdateStatus.restartRequired => true,
        MobileUpdateStatus.outdated => await service.download(),
        MobileUpdateStatus.upToDate || MobileUpdateStatus.unavailable => false,
      };
      if (ready && !_disposed) {
        restartRequired = true;
        notifyListeners();
      }
    } catch (_) {
      // Update discovery is opportunistic. The next resume is the retry, and
      // the running app remains fully usable in the meantime.
    }
  }

  Future<void> restart() async {
    if (!restartRequired || restarting) return;
    restarting = true;
    restartFailed = false;
    notifyListeners();
    try {
      await beforeRestart();
      restartFailed = !await service.restart();
    } catch (_) {
      restartFailed = true;
    } finally {
      restarting = false;
      if (!_disposed) notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Keeps update checks beside the application lifecycle and draws the banner
/// above every route, including sign-in. An inactive app is still visible;
/// only returning from a genuinely hidden/paused state repeats the check.
class UpdateReadyFrame extends StatefulWidget {
  final MobileUpdateController controller;
  final Widget child;
  const UpdateReadyFrame({
    super.key,
    required this.controller,
    required this.child,
  });

  @override
  State<UpdateReadyFrame> createState() => _UpdateReadyFrameState();
}

class _UpdateReadyFrameState extends State<UpdateReadyFrame>
    with WidgetsBindingObserver {
  bool _wasAway = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_changed);
    _checkAfterFrame(widget.controller);
  }

  /// The first probe reaches Shorebird's native updater, which can block on
  /// the automatic updater thread's config lock, so it never runs inside a
  /// build.
  void _checkAfterFrame(MobileUpdateController controller) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(controller.check());
    });
  }

  @override
  void didUpdateWidget(UpdateReadyFrame oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_changed);
    widget.controller.addListener(_changed);
    _checkAfterFrame(widget.controller);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (appIsAwayV1(state)) {
      _wasAway = true;
    } else if (state == AppLifecycleState.resumed && _wasAway) {
      _wasAway = false;
      unawaited(widget.controller.check());
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.controller.restartRequired) return widget.child;
    return Column(
      children: [
        _UpdateReadyHeader(controller: widget.controller),
        Expanded(
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            child: widget.child,
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_changed);
    super.dispose();
  }
}

class _UpdateReadyHeader extends StatelessWidget {
  static const blue = Color(0xff075fce);
  final MobileUpdateController controller;
  const _UpdateReadyHeader({required this.controller});

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return Semantics(
      identifier: ShellIds.updateReady,
      container: true,
      liveRegion: true,
      label: 'Update ready',
      child: ColoredBox(
        color: blue,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, top + 6, 12, 6),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              LayoutBuilder(
                builder: (context, constraints) {
                  final buttonWidth = (constraints.maxWidth * 0.46).clamp(
                    104.0,
                    190.0,
                  );
                  return Row(
                    mainAxisSize: MainAxisSize.max,
                    children: [
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: buttonWidth),
                        child: Semantics(
                          identifier: ShellIds.updateRestart,
                          child: FilledButton(
                            onPressed: controller.restarting
                                ? null
                                : () => unawaited(controller.restart()),
                            style: FilledButton.styleFrom(
                              minimumSize: const Size(48, 48),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                              ),
                              backgroundColor: Colors.white,
                              foregroundColor: blue,
                              disabledBackgroundColor: Colors.white70,
                              disabledForegroundColor: blue,
                            ),
                            child: const Text(
                              'Restart now',
                              textAlign: TextAlign.center,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Your bots keep working',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: Colors.white.withValues(alpha: 0.82),
                                height: 1.25,
                              ),
                        ),
                      ),
                    ],
                  );
                },
              ),
              if (controller.restartFailed)
                Semantics(
                  liveRegion: true,
                  child: const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text(
                      'Couldn’t restart. Try again.',
                      style: TextStyle(color: Colors.white),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
