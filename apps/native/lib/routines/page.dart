/// Routines: what a Bot does on its own, and what it left behind.
///
/// A host over `ViewDocumentView`, the same as Connectors and Plugins: the
/// server projects the Bot's Routines and the completions nested under each
/// of them as one `ViewDocument` and this carries each action to the route
/// that owns it. The Routine commands land on the command route; navigation
/// the host answers itself.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../view/action.dart';
import '../view/surface.dart';
import 'document.dart';
import 'editor.dart';
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

  /// Which Routine the editor page is seeded from. Navigation, not a command:
  /// it is asked for on the read and written nowhere. The list page leaves
  /// this unset.
  String? editing;

  /// Whether this controller is the new-Routine page. The list page leaves
  /// this unset.
  bool creating = false;

  /// Asked when a row wants the editor. The list opens it in this surface;
  /// the editor itself never sees this kind.
  final void Function(String routineId)? onOpenEditor;

  /// Asked when the editor should close — save, cancel, or delete. The list
  /// page never sees these kinds.
  final VoidCallback? onCloseEditor;

  /// A webhook key the authority just minted. It came back on a receipt and
  /// exists once, so it is kept here for as long as the person is looking at
  /// it and never asked for again — a rotate is the only way to see one twice.
  Map<String, Object?>? mintedKey;

  /// The editor has decided to leave — save, cancel, or delete — so the next
  /// pop is not asked about.
  bool closing = false;

  wire.ViewDocument? _document;
  List<RoutinePluginSourceV1> pluginSources = const [];

  /// Whether the read that answers for [pluginSources] is still out. An empty
  /// list under a read that is still out is not a statement about this Bot's
  /// Plugins, and the editor draws the difference rather than telling someone
  /// their Plugin is gone.
  bool pluginCatalogPending = true;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  /// Which read is the current one. A read that publishes its document stops
  /// being busy while its catalog is still out, so a newer read can start over
  /// it — and the newer read's catalog is the one that counts.
  int _reads = 0;

  RoutinesController(
    this.api,
    this.botId, {
    this.openRuns,
    this.confirmDelete,
    this.onInbox,
    this.onOpenEditor,
    this.onCloseEditor,
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

  Future<Object?> _loadPluginFrame() async {
    try {
      return await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/plugins',
      );
    } catch (_) {
      // A Plugin catalog failure must not hide Routines that are otherwise
      // available. The editor can still offer schedules and webhooks.
      return null;
    }
  }

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    final read = ++_reads;
    pluginCatalogPending = true;
    _changed();
    // The catalog widens what the editor offers and nothing else, so it is
    // asked for beside the document and read whenever it lands: a slow Plugin
    // route must not hold back Routines that are otherwise available.
    final plugins = _loadPluginFrame();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request(
          '$_path?as=document${creating
              ? '&new=1'
              : editing == null
              ? ''
              : '&edit=${Uri.encodeQueryComponent(editing!)}'}',
        ),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Routines surface mismatch');
      }
      _document = next;
    } catch (_) {
      _message = 'Couldn’t load this Bot’s Routines. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
    unawaited(_adoptPluginSources(read, plugins));
  }

  /// The catalog the read that asked for it was owed, applied on arrival.
  Future<void> _adoptPluginSources(int read, Future<Object?> plugins) async {
    final frame = await plugins;
    if (_closed || read != _reads) return;
    pluginSources = routinePluginSourcesV1(frame);
    pluginCatalogPending = false;
    _changed();
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = routineActionKindV1(command);
    final applied = {'commandId': command['commandId'], 'status': 'applied'};
    if (kind == 'open-runs' || kind == 'open-run') {
      openRuns?.call(routineIdV1(command) ?? '');
      return applied;
    }
    // Which page is open is this host's to answer: a row names a Routine and
    // the list pushes the editor; cancel, a no-op save and a successful save
    // or delete pop it. Nothing about that is dispatched anywhere.
    if (kind == 'edit-routine') {
      onOpenEditor?.call(routineIdV1(command) ?? '');
      return applied;
    }
    if (kind == 'cancel-edit') {
      _closeEditor();
      return applied;
    }
    if (kind == 'delete-routine' && confirmDelete != null) {
      if (!await confirmDelete!(routineIdV1(command) ?? '')) {
        return {'commandId': command['commandId'], 'status': 'refused'};
      }
    }
    // Saving a form nobody edited would be refused by the route, which is
    // right of it — an update that changes nothing is not an update. It is not
    // a failure to the person who pressed Save, though, so the editor closes
    // on what is already true and nothing is sent.
    if (kind == 'save-routine' &&
        routineSaveIsNoOpV1(
          command,
          routineEditorSeedsV1(_document?.root.toJson()),
        )) {
      _closeEditor();
      return applied;
    }
    final answer = await api.request(
      _path,
      body: routineCommandV1(command, botId),
    );
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    // A save or a delete answers the form: the editor closes and the list
    // it changed is what the reader is left looking at.
    if ((kind == 'save-routine' || kind == 'delete-routine') &&
        receipt['status'] == 'applied') {
      _closeEditor();
    }
    // The plaintext key is on this receipt and on nothing else, ever.
    if (kind == 'rotate-key') {
      mintedKey = (receipt['hook'] as Map?)?.cast<String, Object?>();
    }
    if (kind == 'revoke-key') mintedKey = null;
    return receipt;
  }

  void _closeEditor() {
    if (closing) return;
    closing = true;
    // The list and the form share this controller, and the surface reloads
    // as soon as the receipt lands. Leave the editor flags now so that read
    // is the list — the post-frame leave would otherwise find `_busy` and
    // drop the one that shows what changed.
    creating = false;
    editing = null;
    _changed();
    final close = onCloseEditor;
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

  /// Open on the empty form. Distinct from [initialRoutineId]: a null id
  /// on the list is the list, not a create.
  final bool openNew;

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
    this.openNew = false,
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

  void _openEditor([String? routineId]) {
    controller
      ..creating = routineId == null
      ..editing = routineId
      ..closing = false;
    unawaited(controller.load());
    _syncPanel();
    setState(() {});
  }

  Future<void> _leaveEditor() async {
    controller
      ..creating = false
      ..editing = null
      ..closing = false
      ..mintedKey = null;
    unawaited(controller.load());
    _syncPanel();
    if (mounted) setState(() {});
  }

  Future<bool> _confirmDiscard() async =>
      await showDialog<bool>(
        context: context,
        builder: (dialog) => identified(
          RoutineIds.confirmDiscard,
          AlertDialog(
            title: const Text('Discard changes?'),
            content: const Text(
              'You have unsaved changes. Leave without keeping them?',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog, false),
                child: const Text('Keep editing'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(dialog, true),
                child: const Text('Discard'),
              ),
            ],
          ),
        ),
      ) ??
      false;

  Future<bool> _canLeave(ViewController view) async {
    if (controller.closing) return true;
    if (!routineEditorIsDirtyV1(
      view.values,
      routineEditorSeedsV1(controller.document?.root.toJson()),
    )) {
      return true;
    }
    return _confirmDiscard();
  }

  ViewController? _view;

  Future<bool> _tryLeaveEditor() async {
    final view = _view;
    if (view == null) {
      _leaveEditor();
      return true;
    }
    if (!await _canLeave(view)) return false;
    _leaveEditor();
    return true;
  }

  bool get _editing => controller.creating || controller.editing != null;

  String get _title => controller.creating
      ? 'New Routine'
      : controller.editing != null
      ? 'Edit Routine'
      : 'Routines';

  void _syncPanel() {
    final handle = widget.panel;
    if (handle == null) return;
    if (_editing) {
      handle.showEditor(_title, _tryLeaveEditor);
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
          onOpenEditor: _openEditor,
          onCloseEditor: _leaveEditor,
        )
        ..creating = widget.openNew && widget.initialRoutineId == null
        ..editing = widget.initialRoutineId;

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
        oldWidget.openNew == widget.openNew &&
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
    final editing = _editing;
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
        backId: RoutineIds.editorBack,
        allowPop: () => controller.closing,
        confirmLeave: editing && (widget.chrome || widget.panel == null)
            ? _canLeave
            : null,
        onLeave: editing ? _leaveEditor : null,
        onView: (view) => _view = view,
        rootView: editing ? null : (root) => ViewRoutineList(node: root),
        banner: (context) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!editing) ...[
              identified(
                RoutineIds.create,
                FilledButton.icon(
                  onPressed: () => _openEditor(),
                  icon: const Icon(Icons.add_rounded),
                  label: const Text('New Routine'),
                ),
              ),
              const SizedBox(height: 12),
            ],
            WebhookKeyCard(controller: controller),
          ],
        ),
        fields: routineEditorFieldBuildersV1(
          () => controller.pluginSources,
          pluginsPending: () => controller.pluginCatalogPending,
        ),
      ),
    );
  }
}

/// The panel header's title and back while the editor is open inside it.
class RoutinesPanelHandle extends ChangeNotifier {
  String? editorTitle;
  Future<bool> Function()? tryLeaveEditor;

  void showEditor(String title, Future<bool> Function() tryLeave) {
    if (editorTitle == title && tryLeaveEditor == tryLeave) return;
    editorTitle = title;
    tryLeaveEditor = tryLeave;
    notifyListeners();
  }

  void showList() {
    if (editorTitle == null && tryLeaveEditor == null) return;
    editorTitle = null;
    tryLeaveEditor = null;
    notifyListeners();
  }
}

/// The editor as its own surface: a new Routine, or the one a row named.
///
/// It is still [RoutinesView] — the form is a document of the same panel,
/// not a second route over the app.
class RoutineEditorPage extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;

  /// Absent is what creating means.
  final String? routineId;
  final void Function(TranscriptLine line)? onOpenRun;
  final void Function(int unacknowledged)? onInbox;
  const RoutineEditorPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    this.routineId,
    this.onOpenRun,
    this.onInbox,
  });

  @override
  Widget build(BuildContext context) => RoutinesView(
    api: api,
    store: store,
    userId: userId,
    botId: botId,
    botName: '',
    initialRoutineId: routineId,
    openNew: routineId == null,
    onOpenRun: onOpenRun,
    onInbox: onInbox,
  );
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
