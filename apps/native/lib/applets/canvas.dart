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
  /// directory and nothing else, so a source read that failed is not its
  /// failure to report.
  AppletCanvasFailure? directoryFailure;
  bool loading = true;
  bool loaded = false;

  /// Whether the reader is looking at the code. The source and the last build
  /// are the code view's content and nothing else's, so they are read when
  /// this is true or when there is no live Applet to look at instead — and
  /// never before the viewer is known.
  bool codeView = false;
  bool _closed = false;
  int _attempt = 0;
  int _epoch = 0;
  Timer? _retry;

  /// The re-mint before the held credential expires. A Turn's polling used to
  /// be the only thing that re-read the viewer; an idle Applet's token then
  /// lapsed, and its next reconnect was refused.
  Timer? _refresh;

  /// Set when the re-mint is due, so the next open answer's credential is
  /// adopted whatever the held one's expiry reads.
  bool _credentialDue = false;

  wire.AppletSummary? get focused =>
      directory.where((applet) => applet.appletId == focusedId).firstOrNull;

  /// Whether the code view has anything to draw yet for the focused Applet.
  bool get codeRead => source != null && source?.appletId == focusedId;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  /// The full read: the open route first, so the frame has its page and its
  /// credential before anything else is asked for, then the code when the
  /// code is what is on screen.
  Future<void> load() => _load(code: null);

  /// The read a running Turn repeats: the open route alone. The building
  /// state is the one exception — an Applet with nothing published has only
  /// its code to show, so the code is read behind the open answer.
  Future<void> poll() => _load(code: false);

  /// The code, on demand: the reader opened the Code tab.
  Future<void> readCode() async {
    final epoch = _epoch;
    try {
      await _readCode(epoch);
    } catch (error) {
      if (epoch != _epoch) return;
      failure = appletCanvasFailureV1(error);
    } finally {
      if (epoch == _epoch) _changed();
    }
  }

  /// `code` says whether the code view's reads follow the open read: `null`
  /// lets the view decide, `false` reads them only for an unpublished Applet.
  Future<void> _load({required bool? code}) async {
    final epoch = ++_epoch;
    _retry?.cancel();
    appletOpenClockV1
      ..reset()
      ..start();
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
      await _open(epoch);
      if (epoch != _epoch) return;
      read = true;
      // The viewer is set and the frame is loading. Everything past here is
      // the code view's, and waits on nothing the frame needs.
      if (focusedId != null && (viewer == null || (code ?? codeView))) {
        await _readCode(epoch);
        if (epoch != _epoch) return;
      }
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

  /// The one request the frame waits on.
  Future<void> _open(int epoch) async {
    final opened = await applets.open(botId);
    if (epoch != _epoch) return;
    appletTimingV1('open-endpoint');
    directory = opened.applets;
    directoryFailure = null;
    failure = null;
    _attempt = 0;
    final focus = opened.focused;
    focusedId = focus?.appletId;
    if (focus == null) {
      source = null;
      build = null;
      viewer = null;
      _refresh?.cancel();
      _changed();
      return;
    }
    // Whatever is held belongs to whichever Applet it was read for. A focus
    // that has moved is a different Applet, and drawing the last one's live
    // page under this one's name is worse than drawing nothing.
    if (viewer?.appletId != focus.appletId) viewer = null;
    if (source?.appletId != focus.appletId) {
      source = null;
      build = null;
    }
    final generationId = focus.generationId?.value;
    if (generationId == null) {
      // Nothing published: the building state, and the code is the content.
      viewer = null;
      _refresh?.cancel();
      _changed();
      return;
    }
    // The published generation is what the open Applet *is*: while it is
    // unchanged and the credential has life left in it, the frame keeps
    // running on what it has.
    if (_credentialDue ||
        !appletViewerStillCurrentV1(
          held: viewer,
          appletId: focus.appletId,
          generationId: generationId,
        )) {
      viewer = AppletViewer.fromOpen(focus);
      _credentialDue = false;
      appletTimingV1('viewer-set', detail: generationId);
    }
    _scheduleRefresh();
    _changed();
  }

  /// One open read, this close to the held credential's expiry: the answer
  /// carries a fresh token, and the running frame is handed it as a refresh.
  void _scheduleRefresh() {
    _refresh?.cancel();
    final held = viewer;
    if (held == null) return;
    final wait = held.refreshAt.difference(DateTime.now());
    _refresh = Timer(wait.isNegative ? Duration.zero : wait, () {
      _credentialDue = true;
      unawaited(poll());
    });
  }

  Future<void> _readCode(int epoch) async {
    final appletId = focusedId;
    if (appletId == null) return;
    final results = await Future.wait([
      applets.source(botId, appletId),
      applets.build(botId, appletId),
    ]);
    if (epoch != _epoch || focusedId != appletId) return;
    source = results[0] as AppletSource;
    build = results[1] as AppletBuild;
    appletTimingV1('code-read');
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

  /// Moves the canvas onto the chosen Applet before the write that records it.
  ///
  /// The picker already decided which Applet this is, so drawing it now shows
  /// the choice rather than guessing at an answer. The backend answers with
  /// what it *kept*, which need not be what was asked, so [setFocus]
  /// reconciles against that answer and the caller compares the two.
  void predictFocus(String? appletId) {
    if (focusedId == appletId) return;
    focusedId = appletId;
    // What the focus opens onto is another Applet's, so nothing of the last
    // one survives the change.
    source = null;
    build = null;
    viewer = null;
    _changed();
  }

  /// Records the focus, then reads the open route: the frame for the new
  /// Applet is loading before its code is asked for, and a picker tap is one
  /// write and one read.
  Future<void> setFocus(String? appletId) async {
    final before = focusedId;
    predictFocus(appletId);
    try {
      focusedId = await applets.setFocus(botId, appletId);
      _changed();
      await load();
    } catch (error) {
      predictFocus(before);
      failure = appletCanvasFailureV1(error);
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    ++_epoch;
    _retry?.cancel();
    _refresh?.cancel();
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
///
/// A generation and a page are a document; a credential is not. The frame is
/// built once per document and handed the credential it loaded with in
/// `init`; a credential minted later reaches the same running page as a
/// `refresh`, and the page reconnects in place. Before this the token was
/// part of the frame's identity, and the re-mint three minutes before expiry
/// rebuilt the document and its socket about every twelve minutes.
class AppletViewerFrame extends StatefulWidget {
  final AppletViewer viewer;
  const AppletViewerFrame({super.key, required this.viewer});

  @override
  State<AppletViewerFrame> createState() => _AppletViewerFrameState();
}

class _AppletViewerFrameState extends State<AppletViewerFrame> {
  /// The credential the document loaded with. `init` keeps carrying it, so a
  /// list of messages the frame re-reads on a change names the `init` as
  /// unchanged and delivers only the `refresh` behind it.
  late AppletViewer _loaded = widget.viewer;

  @override
  void didUpdateWidget(AppletViewerFrame old) {
    super.didUpdateWidget(old);
    // A new document starts from the credential it is given.
    if (old.viewer.documentIdentity != widget.viewer.documentIdentity) {
      _loaded = widget.viewer;
    }
  }

  @override
  Widget build(BuildContext context) {
    final tokens = packageThemeTokensV1(context);
    final viewer = widget.viewer;
    return HostFrame(
      url: viewer.uiUrl,
      label: 'Applet',
      identity: viewer.documentIdentity,
      messages: appletFrameMessagesV1(
        loaded: _loaded,
        current: viewer,
        themeTokens: tokens,
      ),
      // The frame's own hops, only while the log is on: the page is listened
      // to for nothing at all otherwise.
      onLoaded: appletTimingLogV1 ? () => appletTimingV1('frame-loaded') : null,
      onMessage: appletTimingLogV1 ? _pageTiming : null,
    );
  }

  /// What the page reports of its open path: `socket-open`, `hello`,
  /// `ready` and `first-render`, on the host's clock.
  static void _pageTiming(Map<String, Object?> message) {
    if (message['type'] != 'applet/timing') return;
    final hop = message['hop'];
    if (hop is String && RegExp(r'^[a-z-]{1,32}$').hasMatch(hop)) {
      appletTimingV1('page-$hop');
    }
  }
}

/// The messages a live Applet's frame is given: the `init` it loaded with,
/// and behind it the `refresh` carrying the current credential once that has
/// moved on. The host frame delivers only what changed, so a running page
/// sees the refresh and not its init again.
List<Map<String, Object?>> appletFrameMessagesV1({
  required AppletViewer loaded,
  required AppletViewer current,
  required Map<String, String> themeTokens,
}) => [
  loaded.init(themeTokens),
  if (current.token != loaded.token) current.refresh(themeTokens),
];

class AppletCanvas extends StatefulWidget {
  final AppletCanvasController controller;

  /// The key the live frame is built under, when the shell holds one. A
  /// phone pre-mounts the frame off stage from the moment the Bot is adopted
  /// and moves it into the canvas page when that is pushed; the key is what
  /// makes the move a move rather than a second document.
  final Key? frameKey;

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
    this.frameKey,
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
  /// spends a read a minute on nothing. While it runs, the poll is the open
  /// route alone — a live Applet's source is the code view's, not the
  /// frame's. The Turn settling gets one full read, which is the one that
  /// finds the publish.
  void _follow() {
    _poll?.cancel();
    if (!widget.running) {
      if (controller.loaded) unawaited(controller.load());
      return;
    }
    _poll = Timer.periodic(
      appletCanvasPollV1,
      (_) => unawaited(controller.poll()),
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
                                child: AppletViewerFrame(
                                  key: widget.frameKey,
                                  viewer: viewer!,
                                ),
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
              onSelectionChanged: (next) {
                setState(() => _chosenApp = next.first);
                // The code is read when it is looked at, never ahead of the
                // frame.
                controller.codeView = !next.first;
                if (!next.first && !controller.codeRead) {
                  unawaited(controller.readCode());
                }
              },
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
