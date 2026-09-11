import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
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
}

/// A host over `ViewDocumentView`, with the surface's own chrome.
class ViewSurfacePage extends StatefulWidget {
  final String title;
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

  /// Drawn above the document, by the host, out of what the host knows and the
  /// document does not.
  ///
  /// That is one thing and always the same thing: a secret the authority
  /// minted once, on a receipt — a webhook key, a pairing code. A document can
  /// be read twice, so a value that exists once cannot be in one; it lives
  /// here for as long as the person is looking at it and nowhere else.
  final WidgetBuilder? banner;

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
    this.maxWidth = 680,
    this.onClose,
    this.chrome = true,
    this.banner,
  });

  @override
  State<ViewSurfacePage> createState() => _ViewSurfacePageState();
}

class _ViewSurfacePageState extends State<ViewSurfacePage>
    with WidgetsBindingObserver {
  ViewController? view;
  int? shown;
  bool reloadWanted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_adopt);
    unawaited(widget.controller.load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_adopt);
    view?.removeListener(_afterAction);
    view?.dispose();
    widget.controller.dispose();
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
    if (document == null || document.revision == shown) {
      setState(() {});
      return;
    }
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
    setState(() {
      shown = document.revision;
      view = next;
    });
    unawaited(next.restore());
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

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final document = controller.document;
    final view = this.view;
    final body = SafeArea(
      top: false,
      child: document == null || view == null
          ? controller.busy
                ? FrockLoading(label: 'Loading ${widget.title.toLowerCase()}')
                : FrockEmptyState(
                    icon: Icons.cloud_off_rounded,
                    title: '${widget.title} couldn’t load',
                    detail:
                        controller.message ??
                        'Check your connection and try again.',
                    action: 'Try again',
                    onAction: controller.load,
                  )
          : RefreshIndicator(
              onRefresh: controller.load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  if (widget.banner case final WidgetBuilder draw)
                    Center(
                      child: ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: widget.maxWidth),
                        child: draw(context),
                      ),
                    ),
                  Center(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxWidth: widget.maxWidth),
                      child: identified(
                        widget.documentId,
                        ViewDocumentView(
                          key: ValueKey(
                            '${controller.surfaceId}.${document.revision}',
                          ),
                          document: document,
                          controller: view,
                          fields: widget.fields,
                          cardGroups: widget.cardGroups,
                          gridGroups: widget.gridGroups,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
    );
    if (!widget.chrome) return body;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        automaticallyImplyLeading: widget.onClose == null,
        leading: widget.onClose == null
            ? null
            : identified(
                ShellIds.rightPanelClose,
                IconButton(
                  tooltip: 'Close ${widget.title.toLowerCase()}',
                  onPressed: widget.onClose,
                  icon: const Icon(Icons.close),
                ),
              ),
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
      body: body,
    );
  }
}
