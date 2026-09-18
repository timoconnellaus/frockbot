/// The Bot's approvals, and the durably admitted path a decision takes.
///
/// It used to be read by the approval bubble in the thread. The bubble is gone
/// (ADR 0030 step 7): the decision is drawn by the `approvals` locked Plugin
/// as an A2UI Card, and its `ApprovalActions` is host code. What that host
/// code cannot get from the Card is the *answer* — an Approval settles when
/// somebody decides on another device or the alarm expires it, and the surface
/// does not move — so this is still read, now by the catalog component through
/// `CardApprovalsScope`.
///
/// The card renders the decision the backend reports, never the tap: a card
/// answered elsewhere, or expired, shows what was actually recorded.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../cards/approvals.dart';
import '../client/transport.dart';

/// One approval as the backend reports it.
class ApprovalCard {
  final String approvalId;
  final String decision;
  final String? expiresAt;
  const ApprovalCard(this.approvalId, this.decision, this.expiresAt);
}

/// The Bot's approvals, and the durably admitted path a decision takes.
///
/// The command is written locally before the request leaves, so a decision the
/// person made is not lost to a disconnect, and a replay reads back the one
/// decision that was recorded rather than overwriting it.
class ApprovalsController extends ChangeNotifier implements CardApprovalsV1 {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;
  Map<String, ApprovalCard> cards = const {};
  String? deciding;
  String? error;
  bool _disposed = false;
  ApprovalsController({
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
  });

  String get _key => 'approval-pending.$userId.$botId';

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  CardApprovalStateV1? approvalStateV1(String approvalId) {
    final card = cards[approvalId];
    if (card == null) return null;
    return CardApprovalStateV1(
      decision: card.decision,
      expiresAt: card.expiresAt,
      deciding: deciding == approvalId,
    );
  }

  @override
  Future<void> refreshApprovalsV1() => load();

  /// A deployment with no approvals route, or one that cannot be read, is a
  /// thread with plain cards rather than a broken one.
  Future<void> load() async {
    try {
      final pending = await store.read(_key);
      if (pending != null) {
        final saved = jsonDecode(pending) as Map<String, dynamic>;
        await _submit(
          saved['approvalId'] as String,
          saved['decision'] as String,
        );
      }
      final answer = await api.request(
        '/api/bots/${Uri.encodeComponent(botId)}/approvals',
      );
      if (answer is! Map) return;
      cards = {
        for (final card in (answer['approvals'] as List? ?? const []))
          if (card is Map && card['approvalId'] is String)
            card['approvalId'] as String: ApprovalCard(
              card['approvalId'] as String,
              '${card['decision'] ?? 'pending'}',
              card['expiresAt'] as String?,
            ),
      };
      error = null;
      _changed();
    } catch (_) {
      // The thread still draws the card; it simply cannot say what was
      // recorded against it.
    }
  }

  Future<void> decide(String approvalId, String decision) async {
    if (_disposed || deciding != null) return;
    deciding = approvalId;
    error = null;
    _changed();
    try {
      await store.write(
        _key,
        jsonEncode({'approvalId': approvalId, 'decision': decision}),
      );
      await _submit(approvalId, decision);
    } catch (_) {
      error = 'Couldn’t record that decision. Check it before answering again.';
    } finally {
      deciding = null;
      _changed();
    }
  }

  Future<void> _submit(String approvalId, String decision) async {
    final receipt = await api.request(
      '/api/bots/${Uri.encodeComponent(botId)}'
      '/approvals/${Uri.encodeComponent(approvalId)}',
      body: {'schemaVersion': 1, 'decision': decision},
    );
    await store.delete(_key);
    if (receipt is! Map) return;
    final approval = receipt['approval'];
    if (approval is! Map) return;
    cards = {
      ...cards,
      approvalId: ApprovalCard(
        approvalId,
        '${approval['decision'] ?? decision}',
        approval['expiresAt'] as String?,
      ),
    };
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
