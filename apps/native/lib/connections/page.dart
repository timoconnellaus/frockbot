import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/states.dart';
import '../theme/frock_theme.dart';
import '../ui/frock_page.dart';
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';

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
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: 'Connectors',
      padded: false,
      trailing: FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh connections',
        onTap: loading ? null : load,
      ),
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
              color: t.accent,
              backgroundColor: t.tile,
              onRefresh: load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(
                  FrockTokens.edge,
                  8,
                  FrockTokens.edge,
                  FrockTokens.edge,
                ),
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text('Your accounts, together', style: t.nameStyle),
                  ),
                  const FrockLead(
                    'Connect an account or service once and every Bot you own can use it.',
                  ),
                  FrockGroup(
                    children: [
                      FrockRow(
                        key: const ValueKey('manage-connections'),
                        leading: const FrockIconTile(
                          Icons.open_in_browser_rounded,
                        ),
                        title: opening
                            ? 'Opening browser…'
                            : 'Manage connections',
                        caption: 'Add accounts, reconnect or remove access in your browser.',
                        chevron: true,
                        onTap: opening ? null : manage,
                      ),
                    ],
                  ),
                  if (message != null) ...[
                    const SizedBox(height: FrockTokens.groupGap),
                    FrockGroup(
                      needsYou: true,
                      children: [
                        Semantics(
                          liveRegion: true,
                          child: FrockNotice(
                            title: 'Connections',
                            body: message!,
                          ),
                        ),
                      ],
                    ),
                  ],
                  const SizedBox(height: FrockTokens.groupGap),
                  const FrockEyebrow('Connected accounts'),
                  const SizedBox(height: FrockTokens.eyebrowToGroup),
                  FrockGroup(
                    children: [
                      if (frame!.accounts.isEmpty)
                        const FrockRow(
                          leading: FrockIconTile(Icons.hub_outlined),
                          title: 'No accounts connected yet',
                          caption:
                              'Choose Manage connections to find a service.',
                        ),
                      for (final account in frame!.accounts)
                        _ConnectionRow(
                          key: ValueKey(account['id']),
                          account: account,
                        ),
                    ],
                  ),
                ],
              ),
            ),
    );
  }
}

class _ConnectionRow extends StatelessWidget {
  final Map<String, Object?> account;
  const _ConnectionRow({super.key, required this.account});
  @override
  Widget build(BuildContext context) {
    final (icon, tone, status) = switch (account['state']) {
      'ready' => (
        Icons.check_circle_outline_rounded,
        TileTone.good,
        'Available to every Bot',
      ),
      'disabled' => (
        Icons.pause_circle_outline_rounded,
        TileTone.neutral,
        'Access paused',
      ),
      'authorizing' => (
        Icons.open_in_browser_rounded,
        TileTone.accent,
        'Finish connecting in your browser',
      ),
      'revoking' => (
        Icons.remove_circle_outline_rounded,
        TileTone.warn,
        'Removing access',
      ),
      'reconciliation-required' => (
        Icons.sync_problem_rounded,
        TileTone.warn,
        'Connection needs to be checked',
      ),
      _ => (
        Icons.error_outline_rounded,
        TileTone.danger,
        'Connection needs attention',
      ),
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
      child: FrockRow(
        leading: FrockIconTile(icon, tone: tone),
        title: account['label']! as String,
        caption: status,
        trailing: FrockChip(account['service']! as String),
      ),
    );
  }
}
