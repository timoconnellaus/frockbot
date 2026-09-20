/// Routines: what a Bot does on its own, and what it left behind.
///
/// A host over `ViewDocumentView`, the same as Connectors and Plugins: the
/// server projects the Bot's Routines and the completions nested under each
/// of them as one `ViewDocument` and this carries each action to the route
/// that owns it. The Routine commands land on the command route; navigation
/// the host answers itself. Conversation authors a Routine; this surface is
/// a list and a read-only detail.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../view/surface.dart';
import 'document.dart';
import 'list.dart';
import 'runs.dart';
import 'runs_row.dart';

export 'runs_row.dart';

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

  /// Kept so a caller that still listens for inbox news is not a second
  /// source of the list. Completions have no read status.
  final void Function(int unacknowledged)? onInbox;

  /// Which Routine the detail is showing. Navigation, not a command: it is
  /// asked for on the read and written nowhere. The list page leaves this
  /// unset.
  String? viewing;

  /// Asked when a row wants the detail. The list opens it in this surface;
  /// the detail itself never sees this kind.
  final void Function(String routineId)? onOpenDetail;

  /// Asked when the detail should close — back, or a successful delete.
  final VoidCallback? onCloseDetail;

  /// A webhook key the authority just minted. It came back on a receipt and
  /// exists once, so it is kept here for as long as the person is looking at
  /// it and never asked for again — a rotate is the only way to see one twice.
  Map<String, Object?>? mintedKey;

  /// The detail has decided to leave, so the next pop is not asked about.
  bool closing = false;

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  /// Callers that hit [load] while a read is out wait here, and the out
  /// read loops until [viewing] is what they asked for.
  Completer<void>? _loading;
  bool _reload = false;

  RoutinesController(
    this.api,
    this.botId, {
    this.openRuns,
    this.confirmDelete,
    this.onInbox,
    this.onOpenDetail,
    this.onCloseDetail,
  });

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {
    if (_closed || _document != null || viewing != null) return;
    if (cached.surfaceId.value != surfaceId) return;
    _document = cached;
    _changed();
  }

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

  String get _documentPath =>
      '$_path?as=document${viewing == null ? '' : '&routine=${Uri.encodeQueryComponent(viewing!)}'}';

  @override
  Future<void> load() async {
    if (_loading != null) {
      _reload = true;
      return _loading!.future;
    }
    final loading = Completer<void>();
    _loading = loading;
    _busy = true;
    _message = null;
    _changed();
    try {
      do {
        _reload = false;
        final wantView = viewing;
        try {
          final next = wire.ViewDocument.fromJson(
            await api.request(_documentPath),
          );
          if (_closed) return;
          if (viewing != wantView) {
            _reload = true;
            continue;
          }
          if (next.surfaceId.value != surfaceId) {
            throw const FormatException('Routines surface mismatch');
          }
          _document = next;
        } catch (_) {
          if (_closed) return;
          if (viewing != wantView) {
            _reload = true;
            continue;
          }
          _message =
              'Couldn’t load this Bot’s Routines. Check your connection and try again.';
        }
      } while (_reload && !_closed);
    } finally {
      _busy = false;
      _loading = null;
      if (!loading.isCompleted) loading.complete();
      if (!_closed) _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = routineActionKindV1(command);
    final applied = {'commandId': command['commandId'], 'status': 'applied'};
    if (kind == 'open-runs' || kind == 'open-run') {
      openRuns?.call(routineIdV1(command) ?? '');
      return applied;
    }
    if (kind == 'open-routine') {
      onOpenDetail?.call(routineIdV1(command) ?? '');
      return applied;
    }
    if (kind == 'delete-routine' && confirmDelete != null) {
      if (!await confirmDelete!(routineIdV1(command) ?? '')) {
        return {'commandId': command['commandId'], 'status': 'refused'};
      }
    }
    final answer = await api.request(
      _path,
      body: routineCommandV1(command, botId),
    );
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    if (kind == 'delete-routine' && receipt['status'] == 'applied') {
      _closeDetail();
    }
    if (kind == 'rotate-key') {
      mintedKey = (receipt['hook'] as Map?)?.cast<String, Object?>();
    }
    if (kind == 'revoke-key') mintedKey = null;
    return receipt;
  }

  void _closeDetail() {
    if (closing) return;
    closing = true;
    viewing = null;
    _changed();
    final close = onCloseDetail;
    if (close == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_closed) close();
    });
  }

  void forgetKey() {
    mintedKey = null;
    _changed();
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
  final String? initialRoutineId;

  /// The panel header's title and back, when this surface is the right panel.
  final RoutinesPanelHandle? panel;
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
    this.initialRoutineId,
    this.panel,
  });

  @override
  State<RoutinesView> createState() => _RoutinesViewState();
}

class _RoutinesViewState extends State<RoutinesView> {
  Future<bool> _confirmDelete(String routineId) async {
    if (!mounted) return false;
    return await showDialog<bool>(
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
  }

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

  void _openDetail(String routineId) {
    controller
      ..viewing = routineId
      ..closing = false;
    unawaited(controller.load());
    _syncPanel();
    setState(() {});
  }

  Future<void> _leaveDetail() async {
    controller
      ..viewing = null
      ..closing = false
      ..mintedKey = null;
    await controller.load();
    _syncPanel();
    if (mounted) setState(() {});
  }

  bool get _detail => controller.viewing != null;

  String get _title => _detail ? 'Routine' : 'Routines';

  void _syncPanel() {
    final handle = widget.panel;
    if (handle == null) return;
    if (_detail) {
      handle.showDetail(_title, () async {
        await _leaveDetail();
        return true;
      });
    } else {
      handle.showList();
    }
  }

  late RoutinesController controller;

  RoutinesController _createController() =>
      RoutinesController(
        widget.api,
        widget.botId,
        openRuns: _openRuns,
        confirmDelete: _confirmDelete,
        onInbox: (count) => widget.onInbox?.call(count),
        onOpenDetail: _openDetail,
        onCloseDetail: _leaveDetail,
      )..viewing = widget.initialRoutineId;

  @override
  void initState() {
    super.initState();
    controller = _createController();
    _syncPanel();
  }

  @override
  void didUpdateWidget(RoutinesView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api &&
        oldWidget.botId == widget.botId &&
        oldWidget.initialRoutineId == widget.initialRoutineId &&
        oldWidget.panel == widget.panel) {
      _syncPanel();
      return;
    }
    final previous = controller;
    controller = _createController();
    previous.dispose();
    _syncPanel();
  }

  @override
  void dispose() {
    widget.panel?.showList();
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    return identified(
      RoutineIds.panel,
      ViewSurfacePage(
        title: _title,
        store: widget.store,
        userId: widget.userId,
        documentId: RoutineIds.document,
        refreshId: RoutineIds.refresh,
        onClose: widget.onClose,
        chrome: widget.chrome,
        controller: controller,
        backId: RoutineIds.detailBack,
        allowPop: () => controller.closing,
        onLeave: detail ? _leaveDetail : null,
        rootView: detail ? null : (root) => ViewRoutineList(node: root),
        cacheScope: detail ? null : widget.botId,
        banner: (context) => WebhookKeyCard(controller: controller),
      ),
    );
  }
}

/// The panel header's title and back while the detail is open inside it.
class RoutinesPanelHandle extends ChangeNotifier {
  String? editorTitle;
  Future<bool> Function()? tryLeaveEditor;

  void showDetail(String title, Future<bool> Function() tryLeave) {
    if (editorTitle == title && tryLeaveEditor == tryLeave) return;
    editorTitle = title;
    tryLeaveEditor = tryLeave;
    notifyListeners();
  }

  void showEditor(String title, Future<bool> Function() tryLeave) =>
      showDetail(title, tryLeave);

  void showList() {
    if (editorTitle == null && tryLeaveEditor == null) return;
    editorTitle = null;
    tryLeaveEditor = null;
    notifyListeners();
  }
}

/// The webhook key, the one time it exists.
///
/// The Bot keeps only a digest of it, so this is the only moment anyone can
/// read the key — which is why the card says so before it says anything else,
/// and why dismissing it is a deliberate press rather than a reload.
class WebhookKeyCard extends StatelessWidget {
  final RoutinesController controller;
  const WebhookKeyCard({super.key, required this.controller});

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final mint = controller.mintedKey;
      if (mint == null) return const SizedBox.shrink();
      final token = mint['token'] as String? ?? '';
      final path = mint['path'] as String? ?? '';
      final theme = Theme.of(context);
      return identified(
        RoutineIds.webhookKey,
        Card(
          margin: const EdgeInsets.only(bottom: 12),
          color: theme.colorScheme.secondaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  header: true,
                  child: Text(
                    'Webhook key, version ${mint['keyVersion']}',
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'This is the only time you’ll see this key. Copy it now — you’ll need a new one otherwise.',
                  style: theme.textTheme.bodySmall,
                ),
                const SizedBox(height: 12),
                SelectableText(path, style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
                SelectableText(token, style: theme.textTheme.bodySmall),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 12,
                  children: [
                    identified(
                      RoutineIds.webhookCopy,
                      FilledButton.tonal(
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: token));
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Key copied.')),
                            );
                          }
                        },
                        child: const Text('Copy key'),
                      ),
                    ),
                    identified(
                      RoutineIds.webhookDismiss,
                      TextButton(
                        onPressed: controller.forgetKey,
                        child: const Text('Done'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// The recent firings the Bot page lists, and the count the surface still
/// reports.
///
/// A Routine firing cannot speak: it has no `send_to_user`, and its Turn is
/// filtered out of the visible transcript. Completions have no read status
/// on the surface — the count is kept so a caller that still listens is not
/// a second source of the list.
class RoutineInboxController extends ChangeNotifier {
  final NativeApi api;
  final String botId;
  int unacknowledged = 0;

  /// The firings the Bot page shows, newest first. They come from the same
  /// [load] the badge does — a completion is the only visible trace a Routine
  /// leaves — so one read answers both. [adopt] then moves the count alone,
  /// because the Routines surface hands over a count and not a list.
  List<RoutineRunSummary> runs = const [];
  bool loaded = false;
  bool _closed = false;
  RoutineInboxController(this.api, this.botId);

  String get badge => unacknowledged > 99 ? '99+' : '$unacknowledged';

  Future<void> load() async {
    try {
      final answer = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/routines/inbox',
      );
      final read = answer as Map?;
      final entries = read?['entries'];
      if (entries is List) {
        runs = routineRunSummariesV1(entries);
        loaded = true;
        if (!_closed) notifyListeners();
      }
      final count = read?['unacknowledged'];
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
