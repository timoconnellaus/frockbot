import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';
import '../theme/states.dart';
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

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Inbox'),
      actions: [
        IconButton(
          tooltip: 'Refresh inbox',
          onPressed: controller.loading ? null : controller.load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: Builder(
            builder: (context) {
              if (!controller.loaded && controller.loading) {
                return const FrockLoading(label: 'Loading your inbox');
              }
              if (!controller.loaded && controller.error != null) {
                return FrockEmptyState(
                  title: 'Your inbox is unavailable',
                  detail: controller.error!,
                  action: 'Try again',
                  onAction: controller.load,
                  icon: Icons.cloud_off_outlined,
                );
              }
              return RefreshIndicator(
                onRefresh: controller.load,
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    Text(
                      'Updates from your Bots',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Open a conversation to follow up, or dismiss an update when you’re done.',
                    ),
                    if (controller.error != null ||
                        navigationError != null ||
                        controller.pending)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                navigationError ?? controller.error ?? 'A read-status change is waiting to be confirmed.',
                              ),
                              TextButton(
                                onPressed: controller.saving
                                    ? null
                                    : controller.pending
                                    ? controller.retry
                                    : controller.load,
                                child: Text(
                                  controller.pending
                                      ? 'Check read status'
                                      : 'Refresh',
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    const SizedBox(height: 20),
                    if (controller.notices.isEmpty)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(
                                Icons.done_all,
                                color: Theme.of(context).colorScheme.primary,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                'You’re all caught up',
                                style: Theme.of(context).textTheme.titleLarge,
                              ),
                              const SizedBox(height: 8),
                              const Text(
                                'New updates will appear here. Your conversations stay in your Bots.',
                              ),
                            ],
                          ),
                        ),
                      ),
                    for (final notice in controller.notices)
                      TweenAnimationBuilder<double>(
                        key: ValueKey(
                          '${notice['botId']}:${notice['notificationId']}',
                        ),
                        tween: Tween(begin: 0, end: 1),
                        duration: FrockTheme.motion(context),
                        builder: (context, value, child) => Opacity(
                          opacity: value,
                          child: Transform.translate(
                            offset: Offset(0, (1 - value) * 8),
                            child: child,
                          ),
                        ),
                        child: Card(
                          child: Padding(
                            padding: const EdgeInsets.all(20),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  notice['title'] as String,
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                                const SizedBox(height: 8),
                                Text(notice['body'] as String),
                                const SizedBox(height: 12),
                                Text(
                                  MaterialLocalizations.of(context)
                                      .formatShortDate(
                                        DateTime.parse(
                                          notice['createdAt'] as String,
                                        ).toLocal(),
                                      ),
                                  style: Theme.of(context).textTheme.bodySmall,
                                ),
                                const SizedBox(height: 8),
                                Wrap(
                                  spacing: 12,
                                  children: [
                                    TextButton.icon(
                                      onPressed: () =>
                                          open(notice['botId'] as String),
                                      icon: const Icon(
                                        Icons.chat_bubble_outline,
                                      ),
                                      label: const Text('Open Bot'),
                                    ),
                                    TextButton(
                                      onPressed:
                                          controller.saving ||
                                              controller.pending
                                          ? null
                                          : () =>
                                                controller.acknowledge(notice),
                                      child: const Text('Dismiss update'),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    if (controller.unread.values.any(
                      (view) => view.unread,
                    )) ...[
                      const SizedBox(height: 24),
                      Text(
                        'Unread conversations',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      for (final view in controller.unread.values.where(
                        (view) => view.unread,
                      ))
                        Card(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  controller.botName(view.botId.value),
                                  style: Theme.of(context)
                                      .textTheme
                                      .titleMedium,
                                ),
                                if (view.lastMessage != null)
                                  Text(
                                    (view.lastMessage as Map)['text'] as String,
                                  ),
                                Wrap(
                                  spacing: 12,
                                  children: [
                                    TextButton(
                                      onPressed: () => open(view.botId.value),
                                      child: const Text('Open Bot'),
                                    ),
                                    if (view.lastActivityCursor != null)
                                      TextButton(
                                        onPressed:
                                            controller.saving ||
                                                controller.pending
                                            ? null
                                            : () => controller.mark(
                                                view.botId.value,
                                                read: true,
                                              ),
                                        child: const Text('Mark as read'),
                                      ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              );
            },
          ),
        ),
      ),
    ),
  );
  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(update);
    super.dispose();
  }
}
