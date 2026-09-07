
import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../flock/lifecycle.dart';
import '../protocol/client_wire.generated.dart' as wire;

class BotRecoveryController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;

  /// Archiving, restoring and deleting are the Flock's, and there is one
  /// retained command for the account however it was issued — from here, or
  /// from the danger zone in Bot settings.
  final BotLifecycleCommands lifecycle;
  BotRecoveryController(this.api, this.store, this.userId)
    : lifecycle = BotLifecycleCommands(api, store, userId) {
    lifecycle.addListener(_notify);
  }
  List<wire.BotRegistration> bots = [];
  Map<String, wire.BotLifecycle> lifecycles = {};
  Map<String, dynamic>? history;
  List<Map<String, dynamic>> audit = [];
  String? auditCursor;
  String auditState = 'ready';
  String? _error;
  String? detailError;
  bool loading = false, loaded = false, detailsLoading = false;
  bool _disposed = false;

  /// A refused change outranks a stale read failure: it is the thing the
  /// person just did and is waiting to hear about.
  String? get error => lifecycle.error ?? _error;
  String? get message => lifecycle.message;
  bool get saving => lifecycle.saving;
  bool get pending => lifecycle.pending;
  String? get pendingBot => lifecycle.pendingBot;
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
      await lifecycle.restore();
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
      _error = null;
    } catch (_) {
      _error = 'Couldn’t reach FrockBot. Check your connection and try again.';
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> change(String botId, String type) async {
    if (_disposed) return;
    if (await lifecycle.change(botId, type) && !_disposed) await load();
  }

  Future<void> retry() async {
    if (_disposed) return;
    if (await lifecycle.retry() && !_disposed) await load();
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
    lifecycle.removeListener(_notify);
    lifecycle.dispose();
    super.dispose();
  }
}
