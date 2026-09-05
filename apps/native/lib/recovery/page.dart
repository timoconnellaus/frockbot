import 'dart:async';

import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/frock_theme.dart';
import '../theme/states.dart';
import 'controller.dart';

class BotRecoveryPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final Future<void> Function()? changed;
  const BotRecoveryPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.changed,
  });
  @override
  State<BotRecoveryPage> createState() => _BotRecoveryPageState();
}

class _BotRecoveryPageState extends State<BotRecoveryPage>
    with WidgetsBindingObserver {
  late final controller = BotRecoveryController(
    widget.api,
    widget.store,
    widget.userId,
  );
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller.addListener(update);
    unawaited(controller.load());
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(controller.load());
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Manage Bots'),
      actions: [
        IconButton(
          tooltip: 'Refresh Bots',
          onPressed: controller.loading ? null : controller.load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: Builder(
            builder: (context) {
              if (!controller.loaded && controller.loading) {
                return const FrockLoading(label: 'Loading your Bots');
              }
              if (!controller.loaded && controller.error != null) {
                return FrockEmptyState(
                  title: 'Your Bots are unavailable',
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
                      'Your Bots, in your control',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Inspect activity and setup history, or put a Bot away for later.',
                    ),
                    RecoveryNotice(
                      controller: controller,
                      onChanged: widget.changed,
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'Active Bots',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    if (controller.active.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'No active Bots. Restore an archived Bot to pick up where you left off.',
                        ),
                      ),
                    for (final bot in controller.active) row(bot, false),
                    const SizedBox(height: 24),
                    Text(
                      'Archived Bots',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    if (controller.archived.isEmpty)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'No archived Bots. Archiving keeps a Bot’s history ready for its return.',
                        ),
                      ),
                    for (final bot in controller.archived) row(bot, true),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    ),
  );
  Widget row(wire.BotRegistration bot, bool archived) => Card(
    child: ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
      leading: const SheepAvatar(),
      title: Text(bot.initialName),
      subtitle: Text(
        archived
            ? 'Archived · history preserved'
            : 'Activity, setup and recovery',
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => BotRecoveryDetail(
            controller: controller,
            bot: bot,
            onChanged: widget.changed,
          ),
        ),
      ),
    ),
  );
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    controller.removeListener(update);
    controller.dispose();
    super.dispose();
  }
}

class RecoveryNotice extends StatelessWidget {
  final BotRecoveryController controller;
  final Future<void> Function()? onChanged;
  const RecoveryNotice({super.key, required this.controller, this.onChanged});
  @override
  Widget build(BuildContext context) {
    final text =
        controller.error ??
        controller.message ??
        (controller.pending ? 'A change is waiting to be confirmed.' : null);
    if (text == null) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(text),
            if (controller.pending)
              TextButton(
                onPressed: controller.saving
                    ? null
                    : () async {
                        await controller.retry();
                        await onChanged?.call();
                      },
                child: const Text('Check change status'),
              ),
          ],
        ),
      ),
    );
  }
}

class BotRecoveryDetail extends StatefulWidget {
  final BotRecoveryController controller;
  final wire.BotRegistration bot;
  final Future<void> Function()? onChanged;
  final int initialTab;
  const BotRecoveryDetail({
    super.key,
    required this.controller,
    required this.bot,
    this.onChanged,
    this.initialTab = 0,
  });
  @override
  State<BotRecoveryDetail> createState() => _BotRecoveryDetailState();
}

class _BotRecoveryDetailState extends State<BotRecoveryDetail> {
  BotRecoveryController get controller => widget.controller;
  String get botId => widget.bot.botId.value;
  @override
  void initState() {
    super.initState();
    controller.addListener(update);
    unawaited(controller.loadDetails(botId));
  }

  void update() {
    if (mounted) setState(() {});
  }

  Future<bool> confirm(String title, String detail, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: SingleChildScrollView(child: Text(detail)),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ??
      false;
  Future<void> change(String type) async {
    final deleting = type == 'bot/delete';
    final restoring = type == 'bot/restore';
    if (!await confirm(
      '${deleting
          ? 'Delete'
          : restoring
          ? 'Restore'
          : 'Archive'} ${widget.bot.initialName}?',
      deleting
          ? 'This removes its conversation and Applets. It cannot be undone.'
          : restoring
          ? 'Bring this Bot back to your active list. Its history will still be there.'
          : 'This Bot will leave your active list and stop accepting new messages. Its history is preserved, and you can restore it later.',
      deleting
          ? 'Delete Bot'
          : restoring
          ? 'Restore Bot'
          : 'Archive Bot',
    )) {
      return;
    }
    await controller.change(botId, type);
    await widget.onChanged?.call();
    if (mounted &&
        deleting &&
        !controller.pending &&
        !controller.bots.any((bot) => bot.botId.value == botId)) {
      Navigator.pop(context);
    }
  }

  @override
  Widget build(BuildContext context) {
    final archived = controller.lifecycles[botId]?.status == 'archived';
    final locked = controller.saving || controller.pending;
    Widget section(List<Widget> children) => RefreshIndicator(
      onRefresh: () => controller.loadDetails(botId),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(20),
        children: [
          RecoveryNotice(controller: controller, onChanged: widget.onChanged),
          ...children,
        ],
      ),
    );
    final notices = <Widget>[
      if (controller.detailsLoading)
        const FrockLoading(label: 'Loading Bot details'),
      if (controller.detailError != null)
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(controller.detailError!),
                TextButton(
                  onPressed: () => controller.loadDetails(botId),
                  child: const Text('Try again'),
                ),
              ],
            ),
          ),
        ),
    ];
    return DefaultTabController(
      length: 3,
      initialIndex: widget.initialTab,
      animationDuration: MediaQuery.disableAnimationsOf(context)
          ? Duration.zero
          : const Duration(milliseconds: 220),
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.bot.initialName),
          bottom: const TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [
              Tab(text: 'Overview'),
              Tab(text: 'Activity'),
              Tab(text: 'Setup'),
            ],
          ),
        ),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: TabBarView(
                children: [
                  section([
                    Text(
                      'You stay in control',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Manage this Bot without losing track of what it did.',
                    ),
                    const SizedBox(height: 20),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              archived
                                  ? 'Ready when you are'
                                  : 'Put this Bot away for later',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              archived
                                  ? 'Its history is preserved. Restore it to continue.'
                                  : 'Archiving keeps its history and can be undone.',
                            ),
                            const SizedBox(height: 12),
                            OutlinedButton.icon(
                              onPressed: locked
                                  ? null
                                  : () => change(
                                      archived ? 'bot/restore' : 'bot/archive',
                                    ),
                              icon: Icon(
                                archived
                                    ? Icons.unarchive_outlined
                                    : Icons.archive_outlined,
                              ),
                              label: Text(
                                archived ? 'Restore Bot' : 'Archive Bot',
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Delete Bot',
                              style: Theme.of(context).textTheme.titleMedium,
                            ),
                            const SizedBox(height: 8),
                            const Text(
                              'Permanently remove its conversation and Applets. This cannot be undone.',
                            ),
                            const SizedBox(height: 12),
                            OutlinedButton.icon(
                              style: OutlinedButton.styleFrom(
                                foregroundColor: Theme.of(context)
                                    .colorScheme
                                    .error,
                              ),
                              onPressed: locked
                                  ? null
                                  : () => change('bot/delete'),
                              icon: const Icon(Icons.delete_outline),
                              label: const Text('Delete Bot'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ]),
                  section([
                    ...notices,
                    Text(
                      'Recorded activity',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 8),
                    if (controller.auditState != 'ready')
                      const Text(
                        'Some activity is still being indexed. Refresh to check again.',
                      ),
                    if (controller.audit.isEmpty &&
                        !controller.detailsLoading &&
                        controller.detailError == null)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'No recorded effects yet. Actions will appear here as your Bot works.',
                        ),
                      ),
                    for (final entry in controller.audit)
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                entry['preview'] as String,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              Text(
                                '${switch (entry['outcome']) {
                                  'ok' => 'Completed',
                                  'error' => 'Failed',
                                  'refused' => 'Refused',
                                  'interrupted' => 'Interrupted',
                                  _ => 'Outcome unknown',
                                }} · ${entry['toolName']}',
                              ),
                              Text(
                                MaterialLocalizations.of(context)
                                    .formatShortDate(
                                      DateTime.parse(entry['at'] as String)
                                          .toLocal(),
                                    ),
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              if (entry['outcome'] == 'unknown')
                                const Text(
                                  'Its outcome is uncertain. Inspect the affected service before repeating the action.',
                                ),
                              ExpansionTile(
                                expansionAnimationStyle:
                                    MediaQuery.disableAnimationsOf(context)
                                    ? AnimationStyle.noAnimation
                                    : null,
                                tilePadding: EdgeInsets.zero,
                                title: const Text('Details'),
                                children: [
                                  SelectableText(
                                    'Target: ${entry['target']}\nEffect: ${entry['effectId']}\nArgument digest: ${entry['argumentDigest']}',
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    if (controller.auditCursor != null)
                      TextButton(
                        onPressed: controller.detailsLoading
                            ? null
                            : () => controller.loadDetails(
                                botId,
                                moreAudit: true,
                              ),
                        child: const Text('Earlier activity'),
                      ),
                  ]),
                  section([
                    ...notices,
                    Text(
                      'Setup history',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    for (final generation
                        in ((controller.history?['botId'] == botId
                                    ? controller.history!['generations']
                                    : null)
                                as List? ??
                            []))
                      setupCard(generation as Map),
                    if (controller.history?['cursor'] != null)
                      TextButton(
                        onPressed: controller.detailsLoading
                            ? null
                            : () => controller.loadDetails(
                                botId,
                                moreHistory: true,
                              ),
                        child: const Text('Earlier setups'),
                      ),
                    const SizedBox(height: 24),

                    if (controller.history != null &&
                        (controller.history!['generations'] as List).isEmpty)
                      const Text(
                        'No setup changes yet. Recorded changes will appear here.',
                      ),
                  ]),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget setupCard(Map generation) {
    final current = generation['isCurrent'] == true;
    final status = switch (generation['status']) {
      'active' => 'Active',
      'pending' => 'Waiting for its next Turn',
      'failed' => 'Couldn’t activate',
      'quarantined' => 'Needs attention',
      _ => 'Previous setup',
    };
    return Card(
      child: ExpansionTile(
        expansionAnimationStyle: MediaQuery.disableAnimationsOf(context)
            ? AnimationStyle.noAnimation
            : null,
        title: Text(current ? 'Current setup' : status),
        subtitle: Text(
          '${MaterialLocalizations.of(context).formatShortDate(DateTime.parse(generation['createdAt'] as String).toLocal())} · $status',
        ),
        childrenPadding: const EdgeInsets.all(16),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final member in generation['members'] as List)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${member['packageId']} · ${member['version']}'),
                  if (member['source'] != null)
                    ExpansionTile(
                      expansionAnimationStyle:
                          MediaQuery.disableAnimationsOf(context)
                          ? AnimationStyle.noAnimation
                          : null,
                      title: const Text('Inspect authored code'),
                      children: [SelectableText(member['source'] as String)],
                    ),
                ],
              ),
            ),
          if ((generation['failures'] as List).isNotEmpty)
            const Text(
              'This setup has failed a backend check. The last working setup stays available.',
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    controller.removeListener(update);
    super.dispose();
  }
}
