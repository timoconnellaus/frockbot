/// The Applet canvas.
///
/// The shell owns the frame: the header, the two states, the transition
/// between them, and every loading, empty and failure branch. The Applet owns
/// only the page inside it, so how finished this feels never depends on what a
/// Bot published.
///
/// There are two states. **Building** is the Applet's
/// source as the Bot writes it, read from the Workspace store — nothing here
/// wakes the Computer. **Ready** is the live Applet, which arrives over the
/// code view once a generation is active. A publish that failed leaves the
/// code view up with the failure inline and a way to try again; it never shows
/// progress that is not happening.
///
/// The canvas is host chrome rather than a projection, and deliberately: the
/// viewer credential it holds is minted per reader and expires in minutes, and
/// a document can be read twice — so it can no more be in one than a pairing
/// code can.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../packages/frame.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../theme/states.dart';
import '../view/embed.dart';
import '../view/host_frame.dart';
import 'client.dart';
import 'failure.dart';
import 'progress.dart';

/// How often the canvas re-reads the Applet while a Turn is working on it.
const appletCanvasPollV1 = Duration(seconds: 6);

/// A read that takes longer than this stops spinning and offers a retry.
const appletCanvasLoadTimeoutV1 = Duration(seconds: 8);

class AppletCanvasController extends ChangeNotifier {
  final AppletsApi applets;
  final String botId;
  AppletCanvasController(NativeApi api, this.botId) : applets = AppletsApi(api);

  List<wire.AppletSummary> directory = const [];
  String? focusedId;
  AppletSource? source;
  AppletBuild? build;
  AppletViewer? viewer;
  AppletCanvasFailure? failure;

  /// Why the Applet *directory* could not be read, which is a different thing
  /// from why the focused Applet's detail could not be: the picker lists the
  /// directory and nothing else, so a token or source read that failed is not
  /// its failure to report.
  AppletCanvasFailure? directoryFailure;
  bool loading = true;
  bool loaded = false;
  bool _closed = false;
  int _attempt = 0;
  int _epoch = 0;
  Timer? _retry;

  wire.AppletSummary? get focused =>
      directory.where((applet) => applet.appletId == focusedId).firstOrNull;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    final epoch = ++_epoch;
    _retry?.cancel();
    // A skeleton is for an empty panel. The canvas re-reads on a cadence while
    // a Turn runs, and showing the loading state on each of those replaced a
    // live Applet — mid-use, mid-scroll — with grey bars twice a minute.
    final first =
        focusedId == null ||
        appletCanvasIsFirstReadV1(
          appletId: focusedId!,
          viewerAppletId: viewer?.appletId,
          sourceAppletId: source?.appletId,
        );
    if (first) {
      loading = true;
      _changed();
    }
    var read = false;
    try {
      var listed = await applets.list();
      if (epoch != _epoch) return;
      directory = listed;
      directoryFailure = null;
      read = true;
      _changed();
      // The directory is the User's and the focus is one Bot's. Only the read
      // above says whether the Applets could be listed; everything past here
      // is about the focused Applet, and fails as one.
      final focus = await applets.focus(botId);
      if (epoch != _epoch) return;
      if (focus != null && !listed.any((entry) => entry.appletId == focus)) {
        // The listing was read before the focus, so an Applet the Turn created
        // and focused in between cannot be in it. The route already clears a
        // focus its own directory read no longer lists, so a focus this listing
        // has never heard of is a stale listing rather than a stale focus.
        listed = await applets.list();
        if (epoch != _epoch) return;
        directory = listed;
      }
      focusedId = listed.any((entry) => entry.appletId == focus) ? focus : null;
      failure = null;
      _attempt = 0;
      await _readFocused(epoch);
      if (epoch != _epoch) return;
      loaded = true;
    } catch (error) {
      if (epoch != _epoch) return;
      failure = appletCanvasFailureV1(error);
      if (!read) directoryFailure = failure;
      _scheduleRetry();
    } finally {
      if (epoch == _epoch) {
        loading = false;
        _changed();
      }
    }
  }

  Future<void> _readFocused(int epoch) async {
    final appletId = focusedId;
    if (appletId == null) {
      source = null;
      build = null;
      viewer = null;
      return;
    }
    // Whatever is held belongs to whichever Applet it was read for. A focus
    // that has moved is a different Applet, and drawing the last one's live
    // page under this one's name is worse than drawing nothing.
    if (viewer?.appletId != appletId) viewer = null;
    if (source?.appletId != appletId) source = null;
    source = await applets.source(botId, appletId);
    build = await applets.build(botId, appletId);
    if (epoch != _epoch) return;
    // An Applet with nothing published has no UI to read, and the route says
    // so with a 404. That is the building state rather than a failed canvas.
    final AppletUi ui;
    try {
      ui = await applets.ui(appletId);
    } on RequestFailure catch (failure) {
      if (failure.status == 404) {
        viewer = null;
        return;
      }
      rethrow;
    }
    final generationId = ui.generationId;
    if (generationId == null) {
      viewer = null;
      return;
    }
    // The published generation is what the open Applet *is*: while it is
    // unchanged and the credential has life left in it, nothing is re-fetched
    // and the frame keeps running.
    if (appletViewerStillCurrentV1(
      held: viewer,
      appletId: appletId,
      generationId: generationId,
    )) {
      return;
    }
    final minted = await applets.token(appletId);
    if (epoch != _epoch) return;
    viewer = AppletViewer(
      appletId: appletId,
      generationId: generationId,
      uiUrl: ui.uiUrl,
      token: minted.token,
      socketUrl: minted.socketUrl,
      expiresAt: DateTime.parse(minted.expiresAt.value),
    );
  }

  /// A network that might come back is retried on a widening backoff; a
  /// refusal the deployment has already settled is not retried at all.
  void _scheduleRetry() {
    final kind = failure;
    if (kind == null || kind.retry != AppletRetry.auto) return;
    if (++_attempt > appletCanvasMaxAutoRetriesV1) return;
    _retry = Timer(appletCanvasRetryDelayV1(_attempt), () => unawaited(load()));
  }

  /// Retry is a re-read: the same durable state, read back the same way.
  Future<void> retry() async {
    _attempt = 0;
    failure = null;
    await load();
  }

  Future<void> setFocus(String? appletId) async {
    try {
      final kept = await applets.setFocus(botId, appletId);
      focusedId = kept;
      // What the focus opens onto is another Applet's, so nothing of the last
      // one survives the change.
      source = null;
      build = null;
      viewer = null;
      _changed();
      await load();
    } catch (error) {
      failure = appletCanvasFailureV1(error);
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    ++_epoch;
    _retry?.cancel();
    super.dispose();
  }
}

/// The `applets` feed a bridge v2 page receives.
///
/// A projection of what the canvas has already read, never a second source of
/// truth: the backend is the authority for the list, the focus and the viewer
/// credential, and a page handed a stale generation simply reconnects when the
/// next feed arrives. The source stays out of it — the host draws the code view
/// itself, and a source tree would overflow the bridge's 64 KB bound.
Map<String, Object?> appletsBridgeStateV2(AppletCanvasController? canvas) {
  final viewer = canvas?.viewer;
  return {
    'focused': canvas?.focused?.toJson(),
    'list': [
      for (final applet in canvas?.directory ?? const []) applet.toJson(),
    ],
    'viewer': viewer == null
        ? null
        : {
            'token': viewer.token,
            'socketUrl': viewer.socketUrl,
            'uiUrl': viewer.uiUrl,
            'generationId': viewer.generationId,
          },
  };
}

/// The live Applet, framed. Also the widget the `applet-viewer` host frame
/// resolves to for any `embed` node under this canvas.
class AppletViewerFrame extends StatelessWidget {
  final AppletViewer viewer;
  const AppletViewerFrame({super.key, required this.viewer});

  @override
  Widget build(BuildContext context) => HostFrame(
    url: viewer.uiUrl,
    label: 'Applet',
    // A new generation, or a new token, is a new document: the credential is
    // delivered on load and never re-sent into a page that has already
    // connected with one that is about to expire.
    identity: '${viewer.generationId}|${viewer.uiUrl}|${viewer.token}',
    messages: [viewer.init(packageThemeTokensV1(context))],
  );
}

class AppletCanvas extends StatefulWidget {
  final AppletCanvasController controller;

  /// The thread, as the progress line reads it. Every Turn's tool activity,
  /// oldest first, because the last thing that happened to the Applet is what
  /// a person wants to know whether or not it happened in the Turn still open.
  final List<TranscriptLine> lines;
  final bool running;
  final VoidCallback? onClose;
  const AppletCanvas({
    super.key,
    required this.controller,
    this.lines = const [],
    this.running = false,
    this.onClose,
  });

  @override
  State<AppletCanvas> createState() => _AppletCanvasState();
}

class _AppletCanvasState extends State<AppletCanvas> {
  /// Which view the header's toggle shows. It follows the Turn — a Turn that
  /// publishes lands on the Applet, a Turn that writes source lands on the
  /// code — until the reader picks a side, and then it is theirs until they
  /// focus something else.
  bool? _chosenApp;
  bool _followedApp = false;
  String? _openedPath;
  String? _followedApplet;
  String _fingerprint = '';
  bool _timedOut = false;
  Timer? _timer;
  Timer? _poll;

  AppletCanvasController get controller => widget.controller;

  @override
  void initState() {
    super.initState();
    controller.addListener(_adopt);
    _adopt();
    _follow();
  }

  @override
  void didUpdateWidget(AppletCanvas old) {
    super.didUpdateWidget(old);
    if (old.running != widget.running) _follow();
  }

  /// A Turn working on the Applet is the only reason to re-read it: the
  /// Workspace has no invalidation of its own, and polling an idle Applet
  /// spends a read a minute on nothing. The Turn settling gets one last read,
  /// which is the one that finds the publish.
  void _follow() {
    _poll?.cancel();
    if (!widget.running) {
      if (controller.loaded) unawaited(controller.load());
      return;
    }
    _poll = Timer.periodic(
      appletCanvasPollV1,
      (_) => unawaited(controller.load()),
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    _poll?.cancel();
    controller.removeListener(_adopt);
    super.dispose();
  }

  void _adopt() {
    if (!mounted) return;
    final appletId = controller.focusedId;
    if (appletId != _followedApplet) {
      _followedApplet = appletId;
      _chosenApp = null;
      _followedApp = false;
      _openedPath = null;
      _fingerprint = '';
    }
    // A generation becoming active is the moment the Applet is worth looking
    // at — and so is opening a panel on an Applet that already has one.
    if (controller.viewer != null) _followedApp = true;
    // A Turn writing source is the moment the code is. The fingerprint is what
    // says a file changed: a watcher on the read itself fired on Turns that
    // wrote nothing and threw the reader off the live Applet mid-use. The
    // first source to arrive is a load, not a write.
    final fingerprint = appletSourceFingerprintV1(controller.source);
    if (_fingerprint.isNotEmpty &&
        fingerprint != _fingerprint &&
        widget.running) {
      _followedApp = false;
    }
    _fingerprint = fingerprint;
    // A spinner that runs forever tells a reader nothing they can act on.
    _timer?.cancel();
    _timedOut = false;
    if (controller.loading) {
      _timer = Timer(appletCanvasLoadTimeoutV1, () {
        if (mounted) setState(() => _timedOut = true);
      });
    }
    setState(() {});
  }

  bool get _showingApp =>
      controller.viewer != null && (_chosenApp ?? _followedApp);

  /// A generation id is `<ISO time>:<hash prefix>`, which is exact and
  /// unreadable. The header says when it went live and keeps the short hash.
  String _generationLabel(String generationId) {
    final separator = generationId.lastIndexOf(':');
    final stamp = separator > 0 ? generationId.substring(0, separator) : '';
    final hash = separator > 0
        ? generationId.substring(separator + 1)
        : generationId;
    final at = DateTime.tryParse(stamp);
    if (at == null) {
      return 'Live · ${hash.substring(0, hash.length < 7 ? hash.length : 7)}';
    }
    final local = at.toLocal();
    final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
    const months = [
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
    final minute = local.minute.toString().padLeft(2, '0');
    final meridiem = local.hour < 12 ? 'am' : 'pm';
    return 'Live since ${months[local.month - 1]} ${local.day}, '
        '$hour:$minute$meridiem';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final applet = controller.focused;
    final viewer = controller.viewer;
    final progress = appletProgressV1(
      applet: applet,
      source: controller.source,
      build: controller.build,
      tools: appletProgressToolsV1(widget.lines),
      running: widget.running,
    );
    final loading = controller.loading && !_timedOut;
    return HostViewFrames(
      frames: {
        if (viewer != null)
          appletViewerFrameV1: (_) => AppletViewerFrame(viewer: viewer),
      },
      child: identified(
        AppletIds.canvas,
        Semantics(
          container: true,
          label: 'Applet ${applet?.displayName ?? ''}',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // The Turn's own signal, across the top of the panel: the canvas
              // says the Bot is working with the same signal the conversation
              // does, rather than inventing a second one.
              SizedBox(
                height: 2,
                child: widget.running
                    ? const LinearProgressIndicator(minHeight: 2)
                    : null,
              ),
              _header(context, applet, viewer),
              if (applet != null &&
                  !loading &&
                  progress != null &&
                  appletIsBeingBuiltV1(progress))
                _progress(context, progress),
              Expanded(
                child: loading
                    ? const FrockLoading(label: 'Reading this Applet')
                    : applet == null
                    ? _empty(context)
                    : Stack(
                        children: [
                          Positioned.fill(child: _code(context)),
                          if (_showingApp)
                            Positioned.fill(
                              child: ColoredBox(
                                color: scheme.surface,
                                child: AppletViewerFrame(viewer: viewer!),
                              ),
                            ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(
    BuildContext context,
    wire.AppletSummary? applet,
    AppletViewer? viewer,
  ) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
    child: Row(
      children: [
        Icon(
          Icons.widgets_outlined,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                applet?.displayName ?? 'Applet',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              if (viewer != null)
                Text(
                  _generationLabel(viewer.generationId),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
            ],
          ),
        ),
        if (viewer != null)
          identified(
            AppletIds.tabs,
            SegmentedButton<bool>(
              showSelectedIcon: false,
              segments: const [
                ButtonSegment(value: true, label: Text('App')),
                ButtonSegment(value: false, label: Text('Code')),
              ],
              selected: {_showingApp},
              onSelectionChanged: (next) =>
                  setState(() => _chosenApp = next.first),
            ),
          ),
        identified(
          AppletIds.close,
          IconButton(
            tooltip: 'Close this Applet',
            onPressed: () => widget.onClose == null
                ? unawaited(controller.setFocus(null))
                : widget.onClose!(),
            icon: const Icon(Icons.close),
          ),
        ),
      ],
    ),
  );

  /// Where the work has got to, pinned under the header while the Applet is
  /// still being built: one line a person can read, the reason it stopped when
  /// it stopped, and the tail of whatever the check or the build printed. It
  /// sits outside the scrolling column deliberately — a person reading the
  /// source still wants to know what is happening to it.
  Widget _progress(BuildContext context, AppletProgress progress) {
    final scheme = Theme.of(context).colorScheme;
    final wrong = progress.failure != null;
    return identified(
      AppletIds.progress,
      Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        color: wrong ? scheme.errorContainer : scheme.surfaceContainerHighest,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                if (progress.working)
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else if (wrong)
                  Icon(Icons.close, size: 14, color: scheme.error),
                if (progress.working || wrong) const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    progress.label,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
              ],
            ),
            if (progress.failure case final String detail) ...[
              const SizedBox(height: 6),
              Text(
                detail,
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: scheme.error),
              ),
            ],
            if (progress.output.isNotEmpty) ...[
              const SizedBox(height: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 180),
                child: SingleChildScrollView(
                  child: SelectableText(
                    progress.output.join('\n'),
                    style: Theme.of(context).textTheme.bodySmall
                        ?.copyWith(fontFamily: 'monospace'),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _empty(BuildContext context) => const Center(
    child: Padding(
      padding: EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.widgets_outlined, size: 32),
          SizedBox(height: 12),
          Text('No Applet here yet'),
          SizedBox(height: 6),
          Text(
            'Ask this Bot to build one — a todo list, a tracker, whatever you '
            'keep in your head. It writes it, publishes it, and it appears here.',
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );

  /// Building: the source as it is written, and the last check.
  Widget _code(BuildContext context) {
    final files = appletSourceFilesV1(controller.source)
      ..sort((left, right) => left.path.compareTo(right.path));
    final path = _openedPath ?? mostRecentlyChangedFileV1(controller.source);
    final open = files.where((file) => file.path == path).firstOrNull;
    return ListView(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
      children: [
        if (controller.failure case final AppletCanvasFailure failure)
          _failure(
            context,
            failure.retry == AppletRetry.auto
                ? '${failure.message} Trying again…'
                : failure.message,
          )
        else if (_timedOut)
          _failure(context, 'This is taking longer than it should.'),
        if (files.isEmpty)
          Text(
            'This Applet has no source yet.',
            style: Theme.of(context).textTheme.bodySmall,
          )
        else
          Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              for (final file in files)
                identified(
                  AppletIds.file(file.path),
                  ChoiceChip(
                    label: Text(file.path),
                    selected: file.path == path,
                    onSelected: (_) => setState(() => _openedPath = file.path),
                  ),
                ),
            ],
          ),
        if (open != null) ...[
          const SizedBox(height: 10),
          identified(
            AppletIds.source,
            SelectableText(
              open.text,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(fontFamily: 'monospace'),
            ),
          ),
        ],
        if (controller.source?.truncated ?? false) ...[
          const SizedBox(height: 10),
          Text(
            'Only the first part of this Applet’s source is shown.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }

  Widget _failure(BuildContext context, String message) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: identified(
      AppletIds.failure,
      Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
          ),
          identified(
            AppletIds.retry,
            TextButton(
              onPressed: () => unawaited(controller.retry()),
              child: const Text('Try again'),
            ),
          ),
        ],
      ),
    ),
  );
}
