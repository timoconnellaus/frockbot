/// The audit log: every effect a Bot performed, newest first.
///
/// A host over `ViewDocumentView`, the same as Connectors, Plugins and
/// Routines. It renders durable state and infers nothing — in particular it
/// never invents an outcome the log does not know, because that would be the
/// silent classification the reconciliation rule forbids.
///
/// The filter and the page are the reader's own query, so the host owns them:
/// a filter action re-reads from the newest page, and a page action re-reads
/// from the cursor the document handed it. Choosing a filter — "All" included
/// — is how a reader gets back to the newest page, because a cursor minted
/// under one filter names nothing under another.
library;

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/chat_pane.dart';
import '../shell/semantics.dart';
import '../shell/transcript_model.dart';
import '../view/surface.dart';
import 'document.dart';

class AuditController extends ViewSurfaceController {
  final NativeApi api;

  /// The Bot whose effects are read. Absent reads every Bot this account has.
  String? botId;

  /// Opens a Turn in the Work view. Navigation is not a command, so the host
  /// answers it rather than sending it anywhere.
  final Future<void> Function(String runId, String? targetBotId)? openRun;

  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;
  String? _kind;
  String? _before;

  AuditController(this.api, {this.botId, this.openRun});

  Future<void> filterBot(String? next) async {
    botId = next;
    _before = null;
    await load();
  }

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'audit';

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
        await api.request(
          auditPathV1(botId: botId, kind: _kind, before: _before),
        ),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Audit surface mismatch');
      }
      _document = next;
    } catch (_) {
      _message =
          'Couldn’t load the audit log. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final kind = auditActionKindV1(command);
    if (kind == 'open-run') {
      await openRun?.call(
        auditRunIdV1(command) ?? '',
        (command['input'] as Map?)?['botId'] as String? ?? botId,
      );
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    if (kind == 'filter-kind' || kind == 'load-more') {
      // A change of filter is a new query, so it starts at the newest page:
      // a cursor minted against one filter names nothing under another.
      if (kind == 'filter-kind') {
        _kind = auditKindV1(command);
        _before = null;
      } else {
        _before = auditCursorV1(command);
      }
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    final answer = await api.request(
      '/api/audit/rebuild',
      body: const <String, Object?>{},
    );
    return ((answer as Map?) ?? const {}).cast<String, Object?>();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// The audit log as a page. On the phone it is where the Bot recovery detail
/// used to show part of it; at wide widths it is the same page, pushed.
class AuditPage extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String? botId;
  final String? botName;
  const AuditPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.botId,
    this.botName,
  });

  /// The Turn behind an audited effect, drawn on the same Work view a message
  /// in the thread opens. A run the Bot no longer holds says so rather than
  /// opening an empty surface.
  Future<void> _openRun(
    BuildContext context,
    String runId,
    String? targetBotId,
  ) async {
    if (targetBotId == null || runId.isEmpty) return;
    try {
      final run = await BackendChatTransport(api).lookup(targetBotId, runId);
      if (!context.mounted) return;
      if (run == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('That Turn is no longer on this Bot.')),
        );
        return;
      }
      final line = projectRuns([run]).lastOrNull;
      if (line == null) return;
      await Navigator.of(context)
          .push(MaterialPageRoute<void>(builder: (_) => RunPage(line: line)));
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Couldn’t open that Turn. Try again.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = AuditController(
      api,
      botId: botId,
      openRun: (runId, targetBotId) => _openRun(context, runId, targetBotId),
    );
    return ViewSurfacePage(
      title: botName == null ? 'Activity & history' : 'Activity · $botName',
      store: store,
      userId: userId,
      documentId: AuditIds.document,
      refreshId: AuditIds.refresh,
      controller: controller,
      banner: (_) => _AuditBotFilter(
        api: api,
        selected: botId,
        busy: controller.busy,
        onChanged: controller.filterBot,
      ),
    );
  }
}

class _AuditBotFilter extends StatefulWidget {
  final NativeApi api;
  final String? selected;
  final bool busy;
  final Future<void> Function(String?) onChanged;
  const _AuditBotFilter({
    required this.api,
    this.selected,
    this.busy = false,
    required this.onChanged,
  });
  @override
  State<_AuditBotFilter> createState() => _AuditBotFilterState();
}

class _AuditBotFilterState extends State<_AuditBotFilter> {
  late String selected = widget.selected ?? '';
  late final directory = widget.api
      .request('/api/bots')
      .then(wire.BotDirectory.fromJson);
  @override
  Widget build(BuildContext context) => FutureBuilder<wire.BotDirectory>(
    future: directory,
    builder: (context, result) {
      final bots = result.data?.bots ?? <wire.BotRegistration>[];
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: DropdownButtonFormField<String>(
          initialValue: selected,
          decoration: const InputDecoration(labelText: 'Show activity for'),
          items: [
            const DropdownMenuItem(value: '', child: Text('All Bots')),
            if (selected.isNotEmpty &&
                !bots.any((bot) => bot.botId.value == selected))
              DropdownMenuItem(value: selected, child: Text(selected)),
            for (final bot in bots)
              DropdownMenuItem(
                value: bot.botId.value,
                child: Text(bot.initialName),
              ),
          ],
          onChanged: widget.busy
              ? null
              : (value) async {
                  if (value == null) return;
                  setState(() => selected = value);
                  await widget.onChanged(value.isEmpty ? null : value);
                },
        ),
      );
    },
  );
}
