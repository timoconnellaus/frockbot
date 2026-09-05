import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/states.dart';
import '../theme/frock_theme.dart';

/// User-owned Connection status; grants stay on the backend Connectors surface.
class ConnectionsPage extends StatefulWidget {
  final NativeApi api;
  final String userId;
  final Future<bool> Function(Uri)? openBrowser;
  const ConnectionsPage({
    super.key,
    required this.api,
    required this.userId,
    this.openBrowser,
  });
  @override
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage>
    with WidgetsBindingObserver {
  wire.ConnectionsFrame? frame;
  bool loading = false;
  bool opening = false;
  String? message;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(load());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(load());
  }

  Future<void> load() async {
    if (loading) return;
    setState(() {
      loading = true;
      message = null;
    });
    try {
      final next = wire.ConnectionsFrame.fromJson(
        await widget.api.request('/api/settings/connections'),
      );
      if (next.ownerId.value != widget.userId) {
        throw const FormatException('Wrong owner');
      }
      if (mounted) setState(() => frame = next);
    } catch (_) {
      if (mounted) {
        setState(() {
          frame = null;
          message =
              'Couldn’t reach FrockBot. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> manage() async {
    if (opening) return;
    setState(() {
      opening = true;
      message = null;
    });
    try {
      final result = wire.AuthStartView.fromJson(
        await widget.api.request(
          '/api/auth/native/settings',
          body: {'schemaVersion': 1, 'home': 'connections'},
        ),
      );
      final uri = Uri.parse(result.authorizationUrl.value);
      if (uri.origin != hostedOrigin ||
          uri.path != '/native/settings' ||
          uri.userInfo.isNotEmpty ||
          uri.fragment.isNotEmpty) {
        throw const FormatException('Invalid handoff');
      }
      final opened =
          await (widget.openBrowser?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
      if (!opened) throw const FormatException('Browser unavailable');
      if (mounted) {
        setState(
          () => message = 'Finish in your browser, then return here. Your connections will refresh automatically.',
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => message =
              'Couldn’t open Connections. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => opening = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Connectors'),
      actions: [
        IconButton(
          tooltip: 'Refresh connections',
          onPressed: loading ? null : load,
          icon: const Icon(Icons.refresh_rounded),
        ),
      ],
    ),
    body: SafeArea(
      top: false,
      child: frame == null
          ? loading
                ? const FrockLoading(label: 'Loading connections')
                : FrockEmptyState(
                    icon: Icons.cloud_off_rounded,
                    title: 'Connections couldn’t load',
                    detail: message ?? 'Check your connection and try again.',
                    action: 'Try again',
                    onAction: load,
                  )
          : RefreshIndicator(
              onRefresh: load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                children: [
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 680),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const SizedBox(height: 8),
                          Icon(
                            Icons.hub_outlined,
                            size: 40,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                          const SizedBox(height: 20),
                          Text(
                            'Your accounts, together',
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Connect an account or service once and every Bot you own can use it.',
                            style: Theme.of(context).textTheme.bodyLarge,
                          ),
                          const SizedBox(height: 20),
                          FilledButton.icon(
                            onPressed: opening ? null : manage,
                            icon: const Icon(Icons.open_in_browser_rounded),
                            label: Text(
                              opening
                                  ? 'Opening browser…'
                                  : 'Manage connections',
                            ),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            'Add accounts, reconnect or remove access in your browser.',
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                          if (message != null)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 16),
                              child: Semantics(
                                liveRegion: true,
                                child: Text(message!),
                              ),
                            ),
                          const SizedBox(height: 28),
                          Text(
                            'Connected accounts',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 12),
                          if (frame!.accounts.isEmpty)
                            Card(
                              child: Padding(
                                padding: const EdgeInsets.all(20),
                                child: Text(
                                  'No accounts connected yet. Choose Manage connections to find a service.',
                                  style: Theme.of(context).textTheme.bodyLarge,
                                ),
                              ),
                            ),
                          for (final account in frame!.accounts)
                            _ConnectionCard(
                              key: ValueKey(account['id']),
                              account: account,
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
    ),
  );
}

class _ConnectionCard extends StatelessWidget {
  final Map<String, Object?> account;
  const _ConnectionCard({super.key, required this.account});
  @override
  Widget build(BuildContext context) {
    final (icon, status) = switch (account['state']) {
      'ready' => (Icons.check_circle_outline_rounded, 'Available to every Bot'),
      'disabled' => (Icons.pause_circle_outline_rounded, 'Access paused'),
      'authorizing' => (
        Icons.open_in_browser_rounded,
        'Finish connecting in your browser',
      ),
      'revoking' => (Icons.remove_circle_outline_rounded, 'Removing access'),
      'reconciliation-required' => (
        Icons.sync_problem_rounded,
        'Connection needs to be checked',
      ),
      _ => (Icons.error_outline_rounded, 'Connection needs attention'),
    };
    return TweenAnimationBuilder<double>(
      duration: FrockTheme.motion(context),
      tween: Tween(begin: 0, end: 1),
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, 8 * (1 - value)),
          child: child,
        ),
      ),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 3, right: 14),
                child: Icon(icon, color: Theme.of(context).colorScheme.primary),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account['label']! as String,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      account['service']! as String,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      status,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
