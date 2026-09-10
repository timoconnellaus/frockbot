import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../client/transport.dart';
import 'canvas.dart';
import 'client.dart';
import 'failure.dart';

class AppletChatScope extends InheritedWidget {
  final NativeApi api;
  const AppletChatScope({super.key, required this.api, required super.child});
  @override
  bool updateShouldNotify(AppletChatScope oldWidget) => api != oldWidget.api;
}

/// Each card holds its own viewer; opening one never changes Session focus.
class AppletChatCard extends StatefulWidget {
  final String appletId;
  const AppletChatCard({super.key, required this.appletId});
  @override
  State<AppletChatCard> createState() => _AppletChatCardState();
}

class _AppletChatCardState extends State<AppletChatCard>
    with AutomaticKeepAliveClientMixin {
  AppletsApi? api;
  AppletViewer? viewer;
  String title = 'Applet';
  String? error;
  Timer? refresh;
  int epoch = 0;
  bool missedWhileHidden = false;
  bool checking = false;
  ScrollPosition? scrolling;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final transport = context
        .dependOnInheritedWidgetOfExactType<AppletChatScope>()
        ?.api;
    if (transport != null && api?.api != transport) {
      api = AppletsApi(transport);
      load();
      refresh?.cancel();
      refresh = Timer.periodic(const Duration(seconds: 30), (_) => _tick());
    }
    final position = Scrollable.maybeOf(context)?.position;
    if (position != scrolling) {
      scrolling?.removeListener(_scrolled);
      scrolling = position;
      position?.addListener(_scrolled);
    }
  }

  /// Being kept alive is not a reason to keep reading. A card the User has
  /// scrolled past holds its frame and its interaction, but a hidden frame
  /// has nothing to show and nobody waiting on it, so the refresh waits with
  /// it and the card catches up the moment it is on screen again.
  void _tick() {
    if (!hidden) {
      load();
      return;
    }
    missedWhileHidden = true;
  }

  /// A kept-alive child is held outside the sliver's laid-out list, which is
  /// exactly what the sliver records on its parent data.
  bool get hidden {
    RenderObject? node = context.findRenderObject();
    while (node != null) {
      final data = node.parentData;
      if (data is SliverMultiBoxAdaptorParentData) return data.keptAlive;
      node = node.parent;
    }
    return false;
  }

  /// The scroll that hid the card is the one that brings it back, so it is
  /// where the card looks. Whether it is hidden is settled by that frame's
  /// layout rather than by the offset the notification carries, so the answer
  /// is read once the frame it belongs to is done.
  void _scrolled() {
    if (!missedWhileHidden || checking) return;
    checking = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      checking = false;
      if (!mounted || !missedWhileHidden || hidden) return;
      missedWhileHidden = false;
      load();
    });
  }

  @override
  void didUpdateWidget(AppletChatCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.appletId != widget.appletId) {
      viewer = null;
      load();
    }
  }

  Future<void> load() async {
    final client = api;
    if (client == null) return;
    final read = ++epoch;
    final id = widget.appletId;
    try {
      final directory = await client.list();
      final applet = directory
          .where((entry) => entry.appletId == id)
          .firstOrNull;
      if (!mounted || read != epoch) return;
      if (applet == null) {
        setState(() {
          viewer = null;
          error = 'This Applet has been deleted or is unavailable.';
        });
        return;
      }
      title = applet.displayName;
      final ui = await client.ui(id);
      if (!mounted || read != epoch) return;
      final generationId = ui.generationId;
      if (generationId == null) {
        setState(() {
          viewer = null;
          error = 'This Applet hasn’t been published yet.';
        });
        return;
      }
      if (!appletViewerStillCurrentV1(
        held: viewer,
        appletId: id,
        generationId: generationId,
      )) {
        final token = await client.token(id);
        if (!mounted || read != epoch) return;
        viewer = AppletViewer(
          appletId: id,
          generationId: generationId,
          uiUrl: ui.uiUrl,
          token: token.token,
          socketUrl: token.socketUrl,
          expiresAt: DateTime.parse(token.expiresAt.value),
        );
      }
      setState(() => error = null);
    } catch (failure) {
      if (!mounted || read != epoch) return;
      // A refresh that could not reach the read says nothing about the Applet
      // itself, so a running frame keeps running; only an answer about this
      // Applet — gone from the directory, or nothing published — takes it down.
      final classified = appletCanvasFailureV1(failure);
      setState(() {
        if (classified.kind == AppletFailureKind.unpublished) viewer = null;
        error = classified.message;
      });
    }
  }

  /// A card is a live Applet, not a picture of one: scrolling it past the
  /// viewport must not dispose the frame and lose an interaction in progress.
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(title, style: Theme.of(context).textTheme.titleMedium),
          ),
          if (viewer != null) ...[
            SizedBox(height: 400, child: AppletViewerFrame(viewer: viewer!)),
            // A refresh that keeps failing leaves the frame up but its credential
            // ageing out, so the card says what went wrong and offers the retry
            // that re-mints it rather than dying silently.
            if (error != null) _failure(error!),
          ] else if (error != null || api == null)
            _failure(error ?? 'Applets are unavailable.')
          else
            const SizedBox(
              height: 100,
              child: Center(child: CircularProgressIndicator()),
            ),
        ],
      ),
    );
  }

  Widget _failure(String message) => Padding(
    padding: const EdgeInsets.all(12),
    child: Column(
      children: [
        Text(message),
        TextButton(onPressed: load, child: const Text('Retry')),
      ],
    ),
  );

  @override
  void dispose() {
    epoch++;
    refresh?.cancel();
    scrolling?.removeListener(_scrolled);
    super.dispose();
  }
}
