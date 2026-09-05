import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/states.dart';
import '../ui/frock_page.dart';
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';
import 'controller.dart';

class ActivityPage extends StatefulWidget {
  final ActivityController controller;
  final Future<void> Function(String) openBot;
  const ActivityPage({
    super.key,
    required this.controller,
    required this.openBot,
  });
  @override
  State<ActivityPage> createState() => _ActivityPageState();
}

class _ActivityPageState extends State<ActivityPage>
    with WidgetsBindingObserver {
  ActivityController get controller => widget.controller;
  Timer? timer;
  String? navigationError;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller.addListener(update);
    unawaited(controller.load());
    timer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => unawaited(controller.load()),
    );
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    timer?.cancel();
    if (state == AppLifecycleState.resumed) {
      unawaited(controller.load());
      timer = Timer.periodic(
        const Duration(seconds: 10),
        (_) => unawaited(controller.load()),
      );
    }
  }

  Future<void> open(String botId) async {
    try {
      await widget.openBot(botId);
    } catch (_) {
      if (mounted) {
        setState(
          () => navigationError =
              'That Bot isn’t available. Refresh your Bots and try again.',
        );
      }
    }
  }

  /// When it happened, the way a person says it.
  String stamp(BuildContext context, String iso) {
    final at = DateTime.tryParse(iso)?.toLocal();
    if (at == null) return '';
    final now = DateTime.now();
    final sameDay =
        at.year == now.year && at.month == now.month && at.day == now.day;
    final l10n = MaterialLocalizations.of(context);
    return sameDay
        ? l10n.formatTimeOfDay(TimeOfDay.fromDateTime(at))
        : l10n.formatShortMonthDay(at);
  }

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final busy = controller.saving || controller.pending;
    final unread = controller.unread.values
        .where((view) => view.unread)
        .toList();
    final Widget body;
    if (!controller.loaded && controller.loading) {
      body = const FrockLoading(label: 'Loading your inbox');
    } else if (!controller.loaded && controller.error != null) {
      body = FrockEmptyState(
        title: 'Your inbox is unavailable',
        detail: controller.error!,
        action: 'Try again',
        onAction: controller.load,
        icon: Icons.cloud_off_outlined,
      );
    } else {
      body = RefreshIndicator(
        color: t.accent,
        backgroundColor: t.tile,
        onRefresh: controller.load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(
            FrockTokens.edge,
            8,
            FrockTokens.edge,
            FrockTokens.edge,
          ),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const FrockLead(
              'Open a conversation to follow up, or dismiss an update when you’re done.',
            ),
            if (controller.error != null ||
                navigationError != null ||
                controller.pending) ...[
              FrockGroup(
                needsYou: true,
                children: [
                  FrockNotice(
                    title: controller.pending
                        ? 'Waiting to confirm'
                        : 'Something went wrong',
                    body:
                        navigationError ??
                        controller.error ??
                        'A read-status change is waiting to be confirmed.',
                    actions: [
                      FrockPill(
                        controller.pending ? 'Check read status' : 'Refresh',
                        kind: PillKind.ghost,
                        size: PillSize.sm,
                        color: t.accent,
                        onTap: controller.saving
                            ? null
                            : controller.pending
                            ? controller.retry
                            : controller.load,
                      ),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: FrockTokens.groupGap),
            ],
            const FrockEyebrow('Updates'),
            const SizedBox(height: FrockTokens.eyebrowToGroup),
            if (controller.notices.isEmpty)
              FrockGroup(
                children: [
                  FrockRow(
                    leading: FrockIconTile(
                      Icons.done_all_rounded,
                      key: const ValueKey('caught-up'),
                    ),
                    title: 'You’re all caught up',
                    caption: 'New updates appear here. Your conversations stay in your Bots.',
                  ),
                ],
              )
            else
              FrockGroup(
                children: [
                  for (final notice in controller.notices)
                    FrockNotice(
                      key: ValueKey(
                        '${notice['botId']}:${notice['notificationId']}',
                      ),
                      title: notice['title'] as String,
                      body: notice['body'] as String,
                      stamp: stamp(context, notice['createdAt'] as String),
                      actions: [
                        FrockPill(
                          'Open Bot',
                          icon: Icons.chat_bubble_outline_rounded,
                          size: PillSize.sm,
                          onTap: () => open(notice['botId'] as String),
                        ),
                        FrockPill(
                          'Dismiss',
                          kind: PillKind.ghost,
                          size: PillSize.sm,
                          color: t.ink2,
                          onTap: busy
                              ? null
                              : () => controller.acknowledge(notice),
                        ),
                      ],
                    ),
                ],
              ),
            if (unread.isNotEmpty) ...[
              const SizedBox(height: FrockTokens.groupGap),
              const FrockEyebrow('Unread'),
              const SizedBox(height: FrockTokens.eyebrowToGroup),
              FrockGroup(
                children: [
                  for (final view in unread)
                    FrockRow(
                      key: ValueKey('unread-${view.botId.value}'),
                      leading: const FrockIconTile(
                        Icons.mark_chat_unread_outlined,
                      ),
                      title: controller.botName(view.botId.value),
                      caption: switch (view.lastMessage?['text']) {
                        final String text when text.trim().isNotEmpty =>
                          text.trim(),
                        _ => null,
                      },
                      trailing: view.lastActivityCursor == null
                          ? null
                          : FrockPill(
                              'Read',
                              kind: PillKind.ghost,
                              size: PillSize.sm,
                              color: t.accent,
                              onTap: busy
                                  ? null
                                  : () => controller.mark(
                                      view.botId.value,
                                      read: true,
                                    ),
                            ),
                      chevron: true,
                      onTap: () => open(view.botId.value),
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    }
    return FrockPage(
      title: 'Inbox',
      padded: false,
      trailing: FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh inbox',
        onTap: controller.loading ? null : controller.load,
      ),
      child: body,
    );
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(update);
    super.dispose();
  }
}
