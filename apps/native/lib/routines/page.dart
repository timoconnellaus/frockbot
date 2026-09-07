/// Routines: what a Bot does on its own, and what it left behind.
///
/// A host over `ViewDocumentView`, the same as Connectors and Plugins: the
/// server projects the Bot's Routines and its completion inbox as one
/// `ViewDocument` and this carries each action to the route that owns it.
/// Three land on the Routine command route, one on the inbox route, and one is
/// navigation the host answers itself.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../view/surface.dart';
import 'document.dart';
import 'runs.dart';

/// Reads the Routines document, and carries each action where it belongs.
class RoutinesController extends ViewSurfaceController {
  final NativeApi api;
  final String botId;

  /// Where "Run log" goes. Navigation is not a command, so the host answers it
  /// rather than sending it anywhere.
  final void Function(String routineId)? openRuns;

  /// Asked before a delete, which takes the Routine, its schedule, its prompt
  /// and its whole run log with it. Answering false refuses the command here,
  /// before anything is dispatched.
  final Future<bool> Function(String routineId)? confirmDelete;

  /// Called with the unacknowledged count each read reports, so the badge and
  /// the sidebar row say the same number this surface does.
  final void Function(int unacknowledged)? onInbox;

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  RoutinesController(
    this.api,
    this.botId, {
    this.openRuns,
    this.confirmDelete,
    this.onInbox,
  });

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'routines';

  String get _path => '/api/bots/${Uri.encodeComponent(botId)}/routines';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('$_path?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Routines surface mismatch');
      }
      _document = next;
      onInbox?.call(unacknowledgedOnScreen.length);
    } catch (_) {
      _message = 'Couldn’t load this Bot’s Routines. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  List<String> get unacknowledgedOnScreen =>
      routineUnacknowledgedOnScreenV1(_document?.root.toJson());

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = routineActionKindV1(command);
    if (kind == 'open-runs') {
      openRuns?.call(routineIdV1(command) ?? '');
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    if (kind == 'delete-routine' && confirmDelete != null) {
      if (!await confirmDelete!(routineIdV1(command) ?? '')) {
        return {'commandId': command['commandId'], 'status': 'refused'};
      }
    }
    final answer = await api.request(
      kind == 'acknowledge-inbox' ? '$_path/inbox' : _path,
      body: kind == 'acknowledge-inbox'
          ? routineInboxCommandV1(command, botId, unacknowledgedOnScreen)
          : routineCommandV1(command, botId),
    );
    return ((answer as Map?) ?? const {}).cast<String, Object?>();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// The Routines surface, as the shell mounts it in the `right-panel` region
/// beside Bot settings, and as a page on the phone.
class RoutinesView extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;
  final String botName;

  /// Opens a Routine's firing in the Work view. On the phone that is a page;
  /// at wide widths it is the right panel — a layout question, not this
  /// surface's.
  final void Function(TranscriptLine line)? onOpenRun;
  final void Function(int unacknowledged)? onInbox;
  final VoidCallback? onClose;

  /// Off inside the right panel, which draws its own header. On as a page.
  final bool chrome;
  const RoutinesView({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    required this.botName,
    this.onOpenRun,
    this.onInbox,
    this.onClose,
    this.chrome = true,
  });

  @override
  State<RoutinesView> createState() => _RoutinesViewState();
}

class _RoutinesViewState extends State<RoutinesView> {
  Future<bool> _confirmDelete(String routineId) async =>
      await showDialog<bool>(
        context: context,
        builder: (dialog) => identified(
          RoutineIds.confirmDelete,
          AlertDialog(
            title: const Text('Delete this Routine?'),
            content: const Text(
              'Its schedule, its prompt and its whole run log go with it. This cannot be undone.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialog, true),
                child: const Text('Delete Routine'),
              ),
            ],
          ),
        ),
      ) ??
      false;

  void _openRuns(String routineId) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RoutineRunsPage(
          api: widget.api,
          botId: widget.botId,
          routineId: routineId,
          onOpenRun: widget.onOpenRun,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => identified(
    RoutineIds.panel,
    ViewSurfacePage(
      title: 'Routines',
      store: widget.store,
      userId: widget.userId,
      documentId: RoutineIds.document,
      refreshId: RoutineIds.refresh,
      onClose: widget.onClose,
      chrome: widget.chrome,
      controller: RoutinesController(
        widget.api,
        widget.botId,
        openRuns: _openRuns,
        confirmDelete: _confirmDelete,
        onInbox: widget.onInbox,
      ),
    ),
  );
}

/// The completions badge, in the Bot header.
///
/// A Routine firing cannot speak: it has no `send_to_user`, and its Turn is
/// filtered out of the visible transcript. So the count here is the only place
/// a completion becomes visible, and pressing it opens the surface that reads
/// them. Acknowledging is a command on that surface, never a side effect of
/// looking at this one.
class RoutineInboxController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  int unacknowledged = 0;
  bool _closed = false;
  RoutineInboxController(this.api, this.botId);

  String get badge => unacknowledged > 99 ? '99+' : '$unacknowledged';

  Future<void> load() async {
    try {
      final answer = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/routines/inbox',
      );
      final count = (answer as Map?)?['unacknowledged'];
      if (count is int) adopt(count);
    } catch (_) {
      // A count that cannot be read is not a count of zero: the badge keeps
      // the last number it knew rather than claiming everything is read.
    }
  }

  /// The count as the Routines surface just read it, so the two never disagree.
  void adopt(int count) {
    if (count == unacknowledged || _closed) return;
    unacknowledged = count;
    notifyListeners();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class RoutineInboxBadge extends StatelessWidget {
  final RoutineInboxController controller;
  final VoidCallback onOpen;
  const RoutineInboxBadge({
    super.key,
    required this.controller,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final count = controller.unacknowledged;
      final label =
          'Routine completions${count > 0 ? ' (${controller.badge} unread)' : ''}';
      return identified(
        RoutineIds.inboxBadge,
        IconButton(
          tooltip: label,
          onPressed: onOpen,
          icon: count > 0
              ? Badge(
                  label: Text(controller.badge),
                  child: const Icon(Icons.history_rounded),
                )
              : const Icon(Icons.history_rounded),
        ),
      );
    },
  );
}
