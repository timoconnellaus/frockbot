import 'dart:async';

import 'package:flutter/material.dart';

import '../client/document_cache.dart';
import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/desktop_layout.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import 'action.dart';
import 'document.dart';
import 'embed.dart';

/// What a page over `ViewDocumentView` needs from whoever owns the read.
///
/// A surface is a document, whether it is busy, why it could not be shown, and
/// where one action lands. Everything else — the controller per revision, the
/// pull to refresh, the empty state, the chrome — is the same on every such
/// page, and is written once below.
abstract class ViewSurfaceController extends ChangeNotifier {
  wire.ViewDocument? get document;
  bool get busy;
  String? get message;
  String get surfaceId;
  Future<void> load();
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command);

  /// Last known document from disk. The host paints it as last known, then
  /// [load] replaces it if the revision moved. Default ignores.
  void adoptCachedDocument(wire.ViewDocument cached) {}
}

/// A host over `ViewDocumentView`, with the surface's own chrome.
class ViewSurfacePage extends StatefulWidget {
  final String title;

  /// Borrowed from the page that created it. The owner replaces and disposes
  /// it; this surface only listens while it is mounted.
  final ViewSurfaceController controller;
  final LocalStore store;
  final String userId;
  final String documentId;
  final String refreshId;
  final Map<String, ViewFieldBuilder> fields;
  final bool cardGroups;

  /// Whether the root's titled groups are drawn as a grid of cards, which is
  /// the Marketplace on a desktop: the list a phone scrolls, laid out wide.
  final bool gridGroups;

  /// Whether the root's titled groups are drawn as labelled cards of switch
  /// rows, one card per section the document names.
  final bool switchRows;

  /// How wide the document is allowed to be. A column of settings reads best
  /// narrow; a grid of cards needs the room.
  final double maxWidth;

  /// Set where the surface is a region rather than a page — the right panel
  /// has no back gesture, so the way out is a control the panel draws.
  final VoidCallback? onClose;

  /// Off where the surface is drawn inside chrome that already names it: the
  /// right panel has its own header, and two titles saying "Routines" is one
  /// too many. The refresh comes with the title, so it goes too — the panel's
  /// pull-to-refresh is still the way to read again.
  final bool chrome;

  /// Asked before the route pops. Return false to stay. The AppBar back and
  /// the system back both go through this; a save or cancel that already
  /// decided to leave does not.
  final Future<bool> Function(ViewController view)? confirmLeave;

  /// When true, a pop this page did not ask about — a save, a cancel — is
  /// allowed through. Read on each build, so a flag the owner flips is enough.
  final bool Function()? allowPop;

  /// The identifier on the back control [confirmLeave] installs.
  final String? backId;

  /// When set, a confirmed leave calls this instead of popping the route.
  /// The editor lives inside the same surface as the list, so back closes
  /// the form and does not leave Routines.
  final Future<void> Function()? onLeave;

  /// Draws the document's root as a host list rather than the shared
  /// switch-row cards. Used by Routines so a row is a door and its
  /// completions sit under it.
  final Widget Function(Map<String, Object?> root)? rootView;

  /// The controller the surface is showing, so a host that owns the back
  /// — the right-panel header — can ask it about a dirty leave.
  final ValueChanged<ViewController?>? onView;

  /// Drawn above the document, by the host, out of what the host knows and the
  /// document does not.
  ///
  /// That is one thing and always the same thing: a secret the authority
  /// minted once, on a receipt — a webhook key, a pairing code. A document can
  /// be read twice, so a value that exists once cannot be in one; it lives
  /// here for as long as the person is looking at it and nowhere else.
  ///
  /// Shown in the tap frame, including while the list is still loading.
  final WidgetBuilder? banner;

  /// When set, the last list document is restored before the network answers
  /// and written after a successful read. Editor and create documents stay
  /// off this path: a form is navigation, not a list someone can return to.
  final String? cacheScope;

  const ViewSurfacePage({
    super.key,
    required this.title,
    required this.controller,
    required this.store,
    required this.userId,
    required this.documentId,
    required this.refreshId,
    this.fields = const {},
    this.cardGroups = false,
    this.gridGroups = false,
    this.switchRows = false,
    this.maxWidth = 680,
    this.onClose,
    this.chrome = true,
    this.banner,
    this.confirmLeave,
    this.allowPop,
    this.backId,
    this.onLeave,
    this.rootView,
    this.onView,
    this.cacheScope,
  });

  @override
  State<ViewSurfacePage> createState() => _ViewSurfacePageState();
}

class _ViewSurfacePageState extends State<ViewSurfacePage>
    with WidgetsBindingObserver {
  ViewController? view;
  int? shown;
  bool reloadWanted = false;
  bool _allowPop = false;

  /// Whether a read was in flight when this page was last told something.
  bool reading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _seedFromMemory();
    widget.controller.addListener(_adopt);
    unawaited(_open());
  }

  @override
  void didUpdateWidget(ViewSurfacePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;
    oldWidget.controller.removeListener(_adopt);
    view?.removeListener(_afterAction);
    view?.dispose();
    view = null;
    shown = null;
    reading = false;
    reloadWanted = false;
    widget.controller.addListener(_adopt);
    _seedFromMemory();
    unawaited(_open());
  }

  /// Last known still in this process, before the first frame. Disk is asked
  /// on [_open] only when this process has not seen the list yet.
  void _seedFromMemory() {
    final scope = widget.cacheScope;
    if (scope == null) return;
    if (widget.controller.document == null) {
      final cached = peekViewDocumentCache(
        widget.userId,
        widget.controller.surfaceId,
        scope,
      );
      if (cached == null ||
          cached.surfaceId.value != widget.controller.surfaceId) {
        return;
      }
      widget.controller.adoptCachedDocument(cached);
    }
    final document = widget.controller.document;
    if (document == null || view != null) return;
    _bindDocument(document);
    reading = widget.controller.busy;
  }

  void _bindDocument(wire.ViewDocument document) {
    view?.removeListener(_afterAction);
    view?.dispose();
    final next = ViewController(
      store: widget.store,
      userId: widget.userId,
      surfaceId: widget.controller.surfaceId,
      revision: document.revision,
      dispatch: _dispatch,
    );
    next.addListener(_afterAction);
    shown = document.revision;
    view = next;
    widget.onView?.call(next);
    unawaited(next.restore());
    final scope = widget.cacheScope;
    if (scope != null && !widget.controller.busy) {
      unawaited(
        writeViewDocumentCache(
          widget.store,
          widget.userId,
          widget.controller.surfaceId,
          scope,
          document,
        ),
      );
    }
  }

  /// Restore last known, then refresh. The cache is last known, not live: a
  /// switch drawn from it may move when the read lands.
  Future<void> _open() async {
    final scope = widget.cacheScope;
    if (scope != null && widget.controller.document == null) {
      final cached = await readViewDocumentCache(
        widget.store,
        widget.userId,
        widget.controller.surfaceId,
        scope,
      );
      if (cached != null &&
          mounted &&
          widget.controller.document == null &&
          cached.surfaceId.value == widget.controller.surfaceId) {
        widget.controller.adoptCachedDocument(cached);
      }
    }
    if (!mounted) return;
    await widget.controller.load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_adopt);
    view?.removeListener(_afterAction);
    view?.dispose();
    widget.onView?.call(null);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (phase == AppLifecycleState.resumed) {
      unawaited(widget.controller.load());
    }
  }

  /// One controller per revision: a change moves the revision on, and the
  /// values a person had typed against the previous one — a credential above
  /// all — are no longer answers to it.
  void _adopt() {
    final document = widget.controller.document;
    if (!mounted) return;
    // A read that lands is the authority speaking, so what this client drew
    // for itself while its command was in flight stops being drawn. Usually
    // the revision moves and the new controller carries no predictions at
    // all; this is the case where it did not move, and a prediction must not
    // outlive the read that answered it.
    if (reading && !widget.controller.busy) view?.predicted.clear();
    reading = widget.controller.busy;
    if (document == null || document.revision == shown) {
      setState(() {});
      return;
    }
    _bindDocument(document);
    setState(() {});
  }

  /// A change the owner accepted moves the revision, so the document is read
  /// again — but only once the command that moved it has finished being
  /// confirmed, so the controller is never replaced under its own dispatch.
  void _afterAction() {
    if (!mounted) return;
    setState(() {});
    if (!reloadWanted || view!.busy || view!.pending != null) return;
    reloadWanted = false;
    unawaited(widget.controller.load());
  }

  Future<Map<String, Object?>> _dispatch(Map<String, Object?> command) async {
    final receipt = await widget.controller.dispatch(command);
    // Anything the owner acted on can have moved the revision, refused or
    // applied: the document is the authority on what happened, so it is read
    // again either way.
    reloadWanted = true;
    return receipt;
  }

  bool get _canPopNow =>
      widget.confirmLeave == null ||
      _allowPop ||
      (widget.allowPop?.call() ?? false);

  Future<void> _requestLeave() async {
    final view = this.view;
    if (view != null && widget.confirmLeave != null) {
      if (!await widget.confirmLeave!(view)) return;
    }
    if (!mounted) return;
    final leave = widget.onLeave;
    if (leave != null) {
      await leave();
      return;
    }
    setState(() => _allowPop = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && Navigator.of(context).canPop()) {
        Navigator.of(context).pop();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final document = controller.document;
    final view = this.view;
    final chrome = <Widget>[
      if (!widget.chrome && widget.confirmLeave != null)
        Align(
          alignment: Alignment.centerLeft,
          child: identified(
            widget.backId ?? 'view-back',
            IconButton(
              tooltip: 'Back',
              onPressed: _requestLeave,
              icon: const Icon(Icons.arrow_back),
            ),
          ),
        ),
      if (widget.banner case final WidgetBuilder draw)
        Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: widget.maxWidth),
            child: draw(context),
          ),
        ),
    ];
    final Widget pane;
    if (document == null || view == null) {
      pane = controller.busy
          ? FrockLoading(label: 'Loading ${widget.title.toLowerCase()}')
          : FrockEmptyState(
              icon: Icons.cloud_off_rounded,
              title: '${widget.title} couldn’t load',
              detail:
                  controller.message ?? 'Check your connection and try again.',
              action: 'Try again',
              onAction: controller.load,
            );
    } else {
      pane = identified(
        widget.documentId,
        ViewDocumentView(
          key: ValueKey('${controller.surfaceId}.${document.revision}'),
          document: document,
          controller: view,
          fields: widget.fields,
          cardGroups: widget.cardGroups,
          gridGroups: widget.gridGroups,
          switchRows: widget.switchRows,
          rootView: widget.rootView,
        ),
      );
    }
    final body = SafeArea(
      top: false,
      child: document != null && view != null
          ? RefreshIndicator(
              onRefresh: controller.load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  ...chrome,
                  if (controller.busy)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 12),
                      child: LinearProgressIndicator(minHeight: 2),
                    ),
                  Center(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxWidth: widget.maxWidth),
                      child: pane,
                    ),
                  ),
                ],
              ),
            )
          : ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
              children: [
                ...chrome,
                Center(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxWidth: widget.maxWidth),
                    child: pane,
                  ),
                ),
              ],
            ),
    );
    if (!widget.chrome) return body;
    final back = widget.confirmLeave != null
        ? identified(
            widget.backId ?? 'view-back',
            IconButton(
              tooltip: 'Back',
              onPressed: _requestLeave,
              icon: const Icon(Icons.arrow_back),
            ),
          )
        : widget.onClose == null
        ? null
        : identified(
            ShellIds.rightPanelClose,
            IconButton(
              tooltip: 'Close ${widget.title.toLowerCase()}',
              onPressed: widget.onClose,
              icon: const Icon(Icons.close),
            ),
          );
    return PopScope(
      canPop: _canPopNow,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_requestLeave());
      },
      child: Scaffold(
        appBar: DesktopHeader(
          child: AppBar(
            title: Text(widget.title),
            automaticallyImplyLeading: back == null && widget.onClose == null,
            leading: back,
            actions: [
              identified(
                widget.refreshId,
                IconButton(
                  tooltip: 'Refresh ${widget.title.toLowerCase()}',
                  onPressed: controller.busy ? null : controller.load,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ),
            ],
          ),
        ),
        body: body,
      ),
    );
  }
}
