/// The conversation panel: host tabs and the focused Plugin's ViewDocument.
///
/// The bag is many-valued; this region shows one tab. A strip of one tab is
/// omitted. An empty bag is not offered. The cloud holds the selection.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/frock_theme.dart';
import '../view/surface.dart';
import 'client.dart';

const panelCanvasPollV1 = Duration(seconds: 6);

class PanelCanvasController extends ChangeNotifier
    implements ViewSurfaceController {
  final PanelsApi panels;
  final String botId;
  PanelCanvasController(NativeApi api, this.botId) : panels = PanelsApi(api);

  wire.PanelOpenView? opened;
  bool loading = false;
  bool _closed = false;
  bool _busy = false;
  String? _message;
  Timer? _follow;
  int _asked = 0;
  int _landed = 0;

  /// Called when a read finds the pointer moved by someone other than this
  /// client — the Bot's `panel_focus`, or another device — so the shell can
  /// put the region in front of the person, or take it away. This client's
  /// own [setFocus] is not a move: whoever pressed already chose where to be.
  VoidCallback? onFocusMoved;

  List<wire.PanelBagEntry> get bag => opened?.bag ?? const [];
  List<wire.PanelDoor> get doors => opened?.doors ?? const [];
  bool get offered => bag.isNotEmpty;
  bool get regionOpen {
    final focus = opened?.focus.toJson();
    return focus is Map && focus['pluginId'] != null;
  }

  String? get focusedPluginId {
    final focus = opened?.focus.toJson();
    return focus is Map ? focus['pluginId'] as String? : null;
  }

  String? get focusedSurfaceId {
    final focus = opened?.focus.toJson();
    return focus is Map ? focus['surfaceId'] as String? : null;
  }

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  wire.ViewDocument? get document => opened?.document;

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {}

  @override
  wire.ViewDocument? get cacheDocument => document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message ?? opened?.failure;
  @override
  String get surfaceId => document?.surfaceId.value ?? 'conversation-panel';

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    loading = opened == null;
    _message = null;
    // A surface calls this from initState, mid-build for the shell and the Bot
    // page that also listen here, so they hear of it once that build is done.
    scheduleMicrotask(_changed);
    try {
      await _read();
    } catch (_) {
      _message =
          'Couldn’t load this panel. Check your connection and try again.';
    } finally {
      _busy = false;
      loading = false;
      _changed();
    }
  }

  Future<void> poll() async {
    try {
      await _read();
      _message = null;
    } catch (_) {
      // Keep the last successful read while a Turn is running.
    } finally {
      _changed();
    }
  }

  /// The first read is where the pointer already was, not a move. After it, a
  /// new surface is a move, and so is the same surface focused again: the
  /// host stamps the document's revision from the write, so the Bot asking to
  /// show the tab the person closed still reaches them. A read that lands
  /// after a later one is dropped, so a poll that left before this client's
  /// own switch cannot undo it.
  Future<void> _read({bool own = false}) async {
    final ticket = ++_asked;
    final next = await panels.open(botId);
    if (ticket < _landed) return;
    _landed = ticket;
    final before = opened;
    opened = next;
    if (own || before == null || _closed) return;
    final was = before.focus.toJson() as Map;
    final now = next.focus.toJson() as Map;
    final wasRevision = before.document?.revision;
    final nowRevision = next.document?.revision;
    final moved =
        was['pluginId'] != now['pluginId'] ||
        was['surfaceId'] != now['surfaceId'] ||
        (wasRevision != null &&
            nowRevision != null &&
            wasRevision != nowRevision);
    if (moved) onFocusMoved?.call();
  }

  void followTurn(bool running) {
    _follow?.cancel();
    _follow = null;
    if (!running) return;
    _follow = Timer.periodic(panelCanvasPollV1, (_) => unawaited(poll()));
  }

  Future<void> setFocus({required String? pluginId, String? surfaceId}) async {
    _busy = true;
    _changed();
    try {
      await panels.setFocus(botId, pluginId: pluginId, surfaceId: surfaceId);
      await _read(own: true);
      _message = null;
    } catch (_) {
      _message = 'Couldn’t switch this panel. Try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    if (input['kind'] == 'plugin-tool') {
      final answer = await panels.runTool(botId, {
        'schemaVersion': 1,
        'kind': 'plugin-tool',
        'commandId': command['commandId'],
        'pluginId': input['pluginId'],
        'tool': input['tool'],
        'arguments': input['arguments'] ?? '',
      });
      unawaited(load());
      return answer;
    }
    return {'status': 'ignored'};
  }

  void disposeController() {
    _closed = true;
    _follow?.cancel();
    dispose();
  }
}

class PanelCanvas extends StatelessWidget {
  final PanelCanvasController controller;
  final LocalStore store;
  final String userId;
  final VoidCallback? onClose;
  const PanelCanvas({
    super.key,
    required this.controller,
    required this.store,
    required this.userId,
    this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final bag = controller.bag;
        if (!controller.offered && controller.message == null) {
          return const SizedBox.shrink();
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (bag.length > 1)
              identified('conversation-panel-tabs', _tabs(context, bag)),
            Expanded(
              child: controller.loading
                  ? const FrockSkeleton()
                  : ViewSurfacePage(
                      title:
                          controller.bag
                              .where(
                                (tab) =>
                                    tab.pluginId.value ==
                                        controller.focusedPluginId &&
                                    tab.surfaceId.value ==
                                        controller.focusedSurfaceId,
                              )
                              .map((tab) => tab.label)
                              .firstOrNull ??
                          'Panel',
                      controller: controller,
                      store: store,
                      userId: userId,
                      documentId: 'conversation-panel',
                      refreshId: 'conversation-panel-refresh',
                      chrome: false,
                      onClose: onClose,
                    ),
            ),
          ],
        );
      },
    );
  }

  Widget _tabs(BuildContext context, List<wire.PanelBagEntry> bag) {
    final selected = bag.indexWhere(
      (tab) =>
          tab.pluginId.value == controller.focusedPluginId &&
          tab.surfaceId.value == controller.focusedSurfaceId,
    );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
      child: Row(
        children: [
          for (var index = 0; index < bag.length; index += 1)
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: ChoiceChip(
                label: Text(bag[index].label),
                selected: index == selected,
                onSelected: (_) => unawaited(
                  controller.setFocus(
                    pluginId: bag[index].pluginId.value,
                    surfaceId: bag[index].surfaceId.value,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
