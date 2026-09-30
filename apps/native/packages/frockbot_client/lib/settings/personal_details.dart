import 'dart:async';

import 'package:flutter/material.dart';

import '../client/document_cache.dart';
import '../client/transport.dart';
import '../shell/desktop_layout.dart';
import '../shell/lifecycle.dart';
import '../shell/semantics.dart';
import '../theme/states.dart';
import '../view/action.dart';
import '../view/document.dart';
import 'controller.dart';

/// Personal details — name, email and time zone — rendered by the host's one
/// renderer. Everything else about the account is in Setup (`setup/page.dart`).
///
/// The server projects the settings frame it already produces as a
/// `ViewDocument`, so this page is a host over `ViewDocumentView` rather than
/// a second renderer of typed fields: the widgets, the budgets and the
/// retained command envelope are the ones every plugin-described view gets.
/// What is left here is the surface's own chrome and the route an action
/// lands on.
class PersonalDetailsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final VoidCallback? onFeaturesChanged;
  const PersonalDetailsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.onFeaturesChanged,
  });
  @override
  State<PersonalDetailsPage> createState() => _PersonalDetailsPageState();
}

/// The one section of the application settings this page shows.
const _home = 'application';

class _PersonalDetailsPageState extends State<PersonalDetailsPage>
    with WidgetsBindingObserver {
  late final SettingsController state = SettingsController(
    widget.api,
    widget.userId,
    _home,
  );
  ViewController? view;
  int? shown;
  bool reloadWanted = false;
  String? saved;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _seedFromMemory();
    state.addListener(_adopt);
    unawaited(_open());
  }

  void _seedFromMemory() {
    if (state.document != null) return;
    final cached = peekViewDocumentCache(widget.userId, state.surfaceId, _home);
    if (cached == null) return;
    state.adoptCachedDocument(cached);
    final document = state.document;
    if (document == null || view != null) return;
    view = ViewController(
      store: widget.store,
      userId: widget.userId,
      surfaceId: state.surfaceId,
      revision: document.revision,
      dispatch: _dispatch,
    );
    view!.addListener(_afterAction);
    shown = document.revision;
    unawaited(view!.restore());
  }

  Future<void> _open() async {
    if (state.document == null) {
      final cached = await readViewDocumentCache(
        widget.store,
        widget.userId,
        state.surfaceId,
        _home,
      );
      if (cached != null && mounted && state.document == null) {
        state.adoptCachedDocument(cached);
      }
    }
    if (mounted) await state.load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    state.removeListener(_adopt);
    view?.removeListener(_afterAction);
    view?.dispose();
    state.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState phase) {
    if (!appIsAwayV1(phase)) unawaited(state.load());
  }

  /// One controller per revision: a save moves the revision on, and the values
  /// a person had typed against the previous one are no longer answers to it.
  void _adopt() {
    final document = state.document;
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
      surfaceId: state.surfaceId,
      revision: document.revision,
      dispatch: _dispatch,
    );
    next.addListener(_afterAction);
    setState(() {
      shown = document.revision;
      view = next;
    });
    unawaited(next.restore());
    if (!state.busy) {
      unawaited(
        writeViewDocumentCache(
          widget.store,
          widget.userId,
          state.surfaceId,
          _home,
          document,
        ),
      );
    }
  }

  /// A change the owner accepted moves the revision, so the document is read
  /// again — but only once the command that moved it has finished being
  /// confirmed, so the controller is never replaced under its own dispatch.
  void _afterAction() {
    if (!mounted) return;
    setState(() {});
    if (!reloadWanted || view!.busy || view!.pending != null) return;
    reloadWanted = false;
    unawaited(state.load());
  }

  Future<Map<String, Object?>> _dispatch(Map<String, Object?> command) async {
    final receipt = await state.dispatch(command);
    if (receipt['status'] == 'applied') {
      reloadWanted = true;
      saved = 'Saved.';
      widget.onFeaturesChanged?.call();
    }
    return receipt;
  }

  @override
  Widget build(BuildContext context) {
    final document = state.document;
    final controller = view;
    return Scaffold(
      appBar: DesktopHeader(
        child: AppBar(
          title: const Text('Personal details'),
          actions: [
            identified(
              SettingsIds.refresh,
              IconButton(
                tooltip: 'Refresh settings',
                onPressed: state.busy ? null : state.load,
                icon: const Icon(Icons.refresh_rounded),
              ),
            ),
          ],
        ),
      ),
      body: SafeArea(
        top: false,
        child: document == null || controller == null
            ? state.busy
                  ? const FrockLoading(label: 'Loading settings')
                  : FrockEmptyState(
                      icon: Icons.cloud_off_rounded,
                      title: 'Settings couldn’t load',
                      detail:
                          state.message ??
                          'Check your connection and try again.',
                      action: 'Try again',
                      onAction: state.load,
                    )
            : RefreshIndicator(
                onRefresh: state.load,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                  children: [
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 680),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (state.busy)
                              const Padding(
                                padding: EdgeInsets.only(bottom: 12),
                                child: LinearProgressIndicator(minHeight: 2),
                              ),
                            if (saved != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Semantics(
                                  liveRegion: true,
                                  child: Text(saved!),
                                ),
                              ),
                            identified(
                              SettingsIds.document,
                              ViewDocumentView(
                                key: ValueKey(
                                  '${state.surfaceId}.${document.revision}',
                                ),
                                document: document,
                                controller: controller,
                              ),
                            ),
                          ],
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
