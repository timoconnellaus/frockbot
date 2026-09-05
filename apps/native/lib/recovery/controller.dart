import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

class BotRecoveryController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  BotRecoveryController(this.api, this.store, this.userId);
  List<wire.BotRegistration> bots = [];
  Map<String, wire.BotLifecycle> lifecycles = {};
  Map<String, dynamic>? history;
  List<Map<String, dynamic>> audit = [];
  String? auditCursor;
  String auditState = 'ready';
  String? error;
  String? detailError;
  String? message;
  bool loading = false, loaded = false, saving = false, detailsLoading = false;
  bool _disposed = false;
  Map<String, dynamic>? _pending;
  bool get pending => _pending != null;
  String? get pendingBot => _pending?['botId'] as String?;
  String get _key => 'bot-recovery.$userId';
  List<wire.BotRegistration> get active => bots
      .where((b) => lifecycles[b.botId.value]?.status != 'archived')
      .toList();
  List<wire.BotRegistration> get archived => bots
      .where((b) => lifecycles[b.botId.value]?.status == 'archived')
      .toList();
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() async {
    if (_disposed || loading || saving) return;
    loading = true;
    _notify();
    try {
      final saved = await store.read(_key);
      if (saved != null) {
        final value = jsonDecode(saved) as Map<String, dynamic>;
        wire.BotLifecycleCommand.fromJson(value);
        _pending = value;
      }
      final directory = wire.BotDirectory.fromJson(
        await api.request('/api/bots'),
      );
      final states = wire.BotLifecycleDirectory.fromJson(
        await api.request('/api/bots/lifecycles'),
      );
      if (_disposed) return;
      bots = directory.bots;
      lifecycles = {
        for (final state in states.lifecycles) state.botId.value: state,
      };
      loaded = true;
      error = null;
    } catch (_) {
      error = 'Couldn’t reach FrockBot. Check your connection and try again.';
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> change(String botId, String type) async {
    if (_disposed || saving || pending) return;
    final command = wire.BotLifecycleCommand.fromJson({
      'schemaVersion': 1,
      'type': type,
      'commandId': randomId(),
      'botId': botId,
    });
    _pending = Map<String, dynamic>.from(command.toJson() as Map);
    await retry();
  }

  Future<void> retry() async {
    if (_disposed || saving || _pending == null) return;
    saving = true;
    message = null;
    _notify();
    final command = _pending!;
    final botId = command['botId'] as String;
    var applied = false;
    try {
      await store.write(_key, jsonEncode(command));
      if (_disposed) return;
      final raw = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/lifecycle',
        body: command,
      );
      final receipt = Map<String, dynamic>.from(
        wire.BotLifecycleReceipt.fromJson(raw).toJson() as Map,
      );
      if (receipt['commandId'] != command['commandId'] ||
          (receipt['botId'] != botId ||
              (receipt['lifecycle'] as Map)['botId'] != botId)) {
        throw const FormatException('Mismatched receipt');
      }
      if (receipt['status'] == 'pending') {
        message = 'This change is still finishing. Check its status shortly.';
        return;
      }
      await store.delete(_key);
      _pending = null;
      if (receipt['status'] == 'rejected') {
        error = 'That change couldn’t be completed. Refresh your Bots and try again.';
        return;
      }
      applied = true;
      error = null;
      message = switch (command['type']) {
        'bot/archive' => 'Bot archived. You can restore it from Archived Bots.',
        'bot/restore' => 'Bot restored.',
        'bot/delete' => 'Bot deleted.',
        _ => 'Change recorded.',
      };
    } catch (_) {
      error = 'Couldn’t confirm that change. Check its status before trying another action.';
    } finally {
      saving = false;
      _notify();
    }
    if (applied && !_disposed) {
      await load();
    }
  }

  Future<void> loadDetails(
    String botId, {
    bool moreAudit = false,
    bool moreHistory = false,
  }) async {
    if (_disposed || detailsLoading) return;
    detailsLoading = true;
    detailError = null;
    if (history?['botId'] != botId) {
      history = null;
      audit = [];
      auditCursor = null;
    }
    _notify();
    if (!moreAudit) {
      try {
        final cursor = moreHistory ? (history?['cursor'] as String?) : null;
        final query = Uri(queryParameters: {'limit': '10', 'cursor': ?cursor})
            .query;
        final next = Map<String, dynamic>.from(
          wire.SetupHistory.fromJson(
                await api.request(
                  '/api/bots/${Uri.encodeComponent(botId)}/composition/generations?$query',
                ),
              ).toJson()
              as Map,
        );
        if (next['botId'] != botId ||
            (next['generations'] as List).any((g) => g['botId'] != botId) ||
            (cursor != null && next['cursor'] == cursor)) {
          throw const FormatException('Mismatched setup');
        }
        if (!_disposed) history = next;
      } catch (_) {
        detailError = 'Couldn’t load this Bot’s setup. Check your connection and try again.';
      }
    }
    if (!moreHistory) {
      try {
        final cursor = moreAudit ? auditCursor : null;
        final query = Uri(
          queryParameters: {'botId': botId, 'limit': '30', 'before': ?cursor},
        ).query;
        final page = Map<String, dynamic>.from(
          wire.AuditPage.fromJson(await api.request('/api/audit?$query'))
                  .toJson()
              as Map,
        );
        final nextCursor = (page['page'] as Map)['nextCursor'] as String?;
        if ((page['entries'] as List).any((e) => e['botId'] != botId) ||
            (cursor != null && nextCursor == cursor)) {
          throw const FormatException('Mismatched audit');
        }
        if (!_disposed) {
          final entries = (page['entries'] as List).map(
            (e) => Map<String, dynamic>.from(e as Map),
          );
          audit = {
            for (final e in entries) '${e['runId']}:${e['occurrenceId']}': e,
          }.values.toList();
          auditCursor = nextCursor;
          auditState = page['indexState'] as String;
        }
      } catch (_) {
        detailError = history?['botId'] == botId
            ? 'Couldn’t load recorded activity. Your setup history is still available.'
            : 'Couldn’t load this Bot’s activity. Check your connection and try again.';
      }
    }
    detailsLoading = false;
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
