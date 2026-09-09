import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import 'canvas.dart';
import 'client.dart';

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

class _AppletChatCardState extends State<AppletChatCard> {
  AppletsApi? api;
  AppletViewer? viewer;
  String title = 'Applet';
  String? error;
  Timer? refresh;
  int epoch = 0;

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
      refresh = Timer.periodic(const Duration(seconds: 30), (_) => load());
    }
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
        throw const FormatException('Applet has no published generation');
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
    } catch (_) {
      if (mounted && read == epoch) {
        setState(() {
          viewer = null;
          error =
              'This Applet couldn’t be opened. It may not be published yet.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Card(
    clipBehavior: Clip.antiAlias,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        if (viewer != null)
          SizedBox(height: 400, child: AppletViewerFrame(viewer: viewer!))
        else if (error != null || api == null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                Text(error ?? 'Applets are unavailable.'),
                TextButton(onPressed: load, child: const Text('Retry')),
              ],
            ),
          )
        else
          const SizedBox(
            height: 100,
            child: Center(child: CircularProgressIndicator()),
          ),
      ],
    ),
  );

  @override
  void dispose() {
    epoch++;
    refresh?.cancel();
    super.dispose();
  }
}
