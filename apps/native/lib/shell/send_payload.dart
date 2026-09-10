/// One user-facing send, drawn in the thread on the Bot's side.
///
/// Read-only by design, with one exception. A widget shows the question and
/// its options but does not answer it: answering queues an ordinary Turn, and
/// a control that looks live but is not would be worse than none. An approval
/// card *is* live, because its answer is not a Turn — it is a durable decision
/// recorded against a record the Bot Durable Object already holds.
///
/// The card renders the decision the backend reports, never the tap: a card
/// answered on another device, or expired by the alarm, shows what was
/// actually recorded.
///
/// Anything this client cannot draw — a payload shape newer than this build,
/// or one the decoder refused — becomes a plain line saying so. A Turn's
/// history has to render on a client older than the Bot that produced it.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../applets/chat_card.dart';
import 'markdown.dart';
import 'semantics.dart';
import 'transcript_model.dart';

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
class ApprovalsController extends ChangeNotifier {
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

/// Draws one send.
class SendPayloadView extends StatelessWidget {
  final SendPayloadLine send;
  final ApprovalsController? approvals;
  final void Function(String url)? onOpenLink;

  /// Where a secret is actually provided. A secret never crosses this widget.
  final VoidCallback? onOpenSettings;
  const SendPayloadView({
    super.key,
    required this.send,
    this.approvals,
    this.onOpenLink,
    this.onOpenSettings,
  });

  @override
  Widget build(BuildContext context) {
    final payload = send.payload;
    if (payload == null) return const _Unsupported();
    switch (payload['type']) {
      case 'text':
        return ShellMarkdown(
          text: '${payload['text'] ?? ''}',
          onOpenLink: onOpenLink,
        );
      case 'widget':
        return _Widget(widget: payload['widget']);
      case 'attachment':
        return _Attachment(payload: payload, onOpenLink: onOpenLink);
      case 'approval':
        return _Approval(
          payload: payload,
          approvals: approvals,
          onOpenLink: onOpenLink,
        );
      case 'secret-request':
        return _SecretRequest(payload: payload, onOpenSettings: onOpenSettings);
      case 'applet':
        final appletId = payload['appletId'];
        if (appletId is! String || appletId.isEmpty) {
          return const _Unsupported();
        }
        return AppletChatCard(key: ValueKey(appletId), appletId: appletId);
      case 'agent-card':
        return _Card(
          title: '${payload['title'] ?? payload['agentId']}',
          body: payload['body'] as String?,
        );
      default:
        return const _Unsupported();
    }
  }
}

class _Card extends StatelessWidget {
  final String title;
  final String? body;
  final Widget? head;
  final List<Widget> actions;
  final String? footer;
  const _Card({
    required this.title,
    this.body,
    this.head,
    this.actions = const [],
    this.footer,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (head != null) ...[head!, const SizedBox(height: 8)],
          Text(title, style: theme.textTheme.titleMedium),
          if (body != null && body!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              body!,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Row(children: actions),
          ],
          if (footer != null) ...[
            const SizedBox(height: 8),
            Text(
              footer!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Widget extends StatelessWidget {
  final Object? widget;
  const _Widget({required this.widget});

  @override
  Widget build(BuildContext context) {
    if (widget is! Map) return const _Unsupported();
    final map = widget as Map;
    final options = (map['options'] as List? ?? const []).cast<Object?>();
    final theme = Theme.of(context);
    return Semantics(
      label: 'Question',
      child: _Card(
        title: '${map['prompt'] ?? ''}',
        body: map['helpText'] as String?,
        actions: const [],
        footer: map['allowCustom'] == true
            ? 'Any other answer is accepted too.'
            : null,
        head: options.isEmpty
            ? null
            : Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final option in options)
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        border: Border.all(
                          color: theme.colorScheme.outlineVariant,
                        ),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text('$option', style: theme.textTheme.bodySmall),
                    ),
                ],
              ),
      ),
    );
  }
}

class _Attachment extends StatelessWidget {
  final Map<String, Object?> payload;
  final void Function(String url)? onOpenLink;
  const _Attachment({required this.payload, this.onOpenLink});

  @override
  Widget build(BuildContext context) {
    final url = '${payload['url'] ?? ''}';
    final name = '${payload['name'] ?? url}';
    return TextButton.icon(
      onPressed: onOpenLink == null ? null : () => onOpenLink!(url),
      icon: const Icon(Icons.attachment_outlined, size: 18),
      label: Text(name),
    );
  }
}

class _Approval extends StatelessWidget {
  final Map<String, Object?> payload;
  final ApprovalsController? approvals;
  final void Function(String url)? onOpenLink;
  const _Approval({required this.payload, this.approvals, this.onOpenLink});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final approvalId = '${payload['approvalId'] ?? ''}';
    final risk = '${payload['risk'] ?? 'low'}';
    final record = approvals?.cards[approvalId];
    final decision = record?.decision ?? 'pending';
    final decided = switch (decision) {
      'approved' => 'You approved this.',
      'denied' => 'You denied this.',
      'expired' => 'This expired before anyone answered.',
      _ => null,
    };
    final expiresAt = record?.expiresAt;
    final expiry = decision == 'pending' && expiresAt != null
        ? DateTime.tryParse(expiresAt)
        : null;
    final busy = approvals?.deciding == approvalId;
    return Semantics(
      label: 'Approval request',
      child: _Card(
        head: Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                border: Border.all(
                  color: risk == 'high'
                      ? theme.colorScheme.error
                      : theme.colorScheme.outlineVariant,
                ),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                risk.toUpperCase(),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: risk == 'high'
                      ? theme.colorScheme.error
                      : theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              'Needs your approval',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        title: '${payload['action'] ?? ''}',
        body: decided ?? payload['rationale'] as String?,
        actions: decided != null || approvals == null
            ? const []
            : [
                identified(
                  ShellIds.approve(approvalId),
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => approvals!.decide(approvalId, 'approved'),
                    child: const Text('Approve'),
                  ),
                ),
                const SizedBox(width: 8),
                identified(
                  ShellIds.deny(approvalId),
                  TextButton(
                    onPressed: busy
                        ? null
                        : () => approvals!.decide(approvalId, 'denied'),
                    child: const Text('Deny'),
                  ),
                ),
              ],
        footer:
            approvals?.error ??
            (expiry == null
                ? null
                : 'Expires ${expiry.toLocal().toString().substring(0, 16)}'),
      ),
    );
  }
}

/// A secret is never typed into the thread. The card says what is wanted and
/// sends the person to the one surface that takes it, where the value crosses
/// as an opaque, expiring lease and never touches this client's memory.
class _SecretRequest extends StatelessWidget {
  final Map<String, Object?> payload;
  final VoidCallback? onOpenSettings;
  const _SecretRequest({required this.payload, this.onOpenSettings});

  @override
  Widget build(BuildContext context) => _Card(
    head: const Row(
      children: [
        Icon(Icons.key_outlined, size: 18),
        SizedBox(width: 8),
        Text('Needs a credential'),
      ],
    ),
    title: '${payload['prompt'] ?? ''}',
    body:
        'Stored as ${payload['secretName']}. Secrets are added in Settings, '
        'never in the conversation.',
    actions: onOpenSettings == null
        ? const []
        : [
            FilledButton(
              onPressed: onOpenSettings,
              child: const Text('Open Settings'),
            ),
          ],
  );
}

class _Unsupported extends StatelessWidget {
  const _Unsupported();

  @override
  Widget build(BuildContext context) => Text(
    'This client cannot display that message.',
    style: Theme.of(context).textTheme.bodySmall?.copyWith(
      color: Theme.of(context).colorScheme.onSurfaceVariant,
      fontStyle: FontStyle.italic,
    ),
  );
}
