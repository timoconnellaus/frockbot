/// The chat between one Bot and one counterpart, read from the cloud.
///
/// The thread's own page is the newest slice of a Bot's history, and an
/// exchange that happened before it is not on it. This reads the filtered
/// pages the cloud serves for a counterpart, oldest last, and lets the view
/// ask for more; the live Turns the thread already holds are merged in by
/// the caller, so an exchange in flight updates without a round trip.
library;

import 'package:flutter/foundation.dart';

import '../shell/transcript_model.dart';
import 'transport.dart';

class ExchangeController extends ChangeNotifier {
  final ExchangeTransport transport;
  final String botId;
  final ExchangeCounterpart counterpart;
  ExchangeController({
    required this.transport,
    required this.botId,
    required this.counterpart,
  });

  final Map<String, Map<String, dynamic>> _runs = {};
  List<Map<String, dynamic>> get runs => _runs.values.toList();
  String? before;
  bool loading = false;
  bool loaded = false;
  String? error;
  bool _disposed = false;

  /// The counterpart as the wire spells it.
  String get wireCounterpart =>
      counterpart.isVoice ? 'voice' : 'bot:${counterpart.botId}';

  Future<void> load({bool older = false}) async {
    if (loading) return;
    if (older && before == null) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final page = await transport.exchanges(
        botId,
        wireCounterpart,
        before: older ? before : null,
      );
      if (_disposed) return;
      for (final run in page['runs'] as List) {
        final record = Map<String, dynamic>.from(run as Map);
        _runs[record['runId'] as String] = record;
      }
      final cursor = (page['page'] as Map)['nextCursor'] as String?;
      if (older || !loaded) before = cursor;
      loaded = true;
    } catch (failure) {
      if (_disposed) return;
      error = 'Couldn’t load this chat.';
    } finally {
      if (!_disposed) {
        loading = false;
        notifyListeners();
      }
    }
  }

  /// Every exchange with the counterpart across the pages read so far and
  /// the live Turns handed in, one entry per exchange, oldest first.
  List<Exchange> exchanges(List<Map<String, dynamic>> live) {
    final merged = <String, Map<String, dynamic>>{..._runs};
    for (final run in live) {
      merged[run['runId'] as String] = run;
    }
    return projectExchanges(merged.values.toList(), counterpart);
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
