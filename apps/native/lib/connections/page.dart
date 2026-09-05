import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../theme/states.dart';
import '../ui/frock_page.dart';
import '../ui/frock_tokens.dart';
import '../ui/frock_widgets.dart';

/// Where the app remembers which service the User walked out to, so the notice
/// on the way back can name it.
const pendingConnectionKey = 'connection.pending';

/// The outcome the service's sign-in leaves on the App Link it returns to:
/// `https://bot.frockbot.com/?connection=composio-ready|pending|failed`.
/// Anything else — another host, a fragment, a second value — is not ours.
String? connectionReturn(Uri uri) {
  if (uri.scheme != 'https' ||
      uri.origin != hostedOrigin ||
      uri.userInfo.isNotEmpty ||
      uri.hasFragment ||
      (uri.path != '/' && uri.path.isNotEmpty)) {
    return null;
  }
  final values = uri.queryParametersAll['connection'];
  if (values == null || values.length != 1) return null;
  return switch (values.single) {
    'composio-ready' => 'ready',
    'composio-pending' => 'pending',
    'composio-failed' => 'failed',
    _ => null,
  };
}

/// A service the User can connect. The catalog's own words, nothing invented.
class ServiceEntry {
  final String id;
  final String name;
  final String? description;
  final String? icon;
  const ServiceEntry({
    required this.id,
    required this.name,
    this.description,
    this.icon,
  });
}

/// The services people reach for first, when the catalog carries no ranking.
const popularServices = [
  'gmail',
  'googlecalendar',
  'slack',
  'notion',
  'github',
  'linear',
];

/// Connect: the User's own accounts and the services they can add, in the app.
/// The browser is opened for one thing only — the service's own sign-in — and
/// the App Link it returns to brings the User straight back here.
class ConnectionsPage extends StatefulWidget {
  final NativeApi api;
  final String userId;

  /// Remembers the service being connected across the trip to the browser.
  final LocalStore? store;

  /// The outcome of a sign-in the User has just come back from.
  final String? outcome;
  final Future<bool> Function(Uri)? openBrowser;
  const ConnectionsPage({
    super.key,
    required this.api,
    required this.userId,
    this.store,
    this.outcome,
    this.openBrowser,
  });
  @override
  State<ConnectionsPage> createState() => _ConnectionsPageState();
}

class _ConnectionsPageState extends State<ConnectionsPage>
    with WidgetsBindingObserver {
  final search = TextEditingController();
  wire.ConnectionsFrame? frame;
  List<ServiceEntry>? services;
  bool loading = false;
  bool busy = false;
  String query = '';
  String? noticeTitle;
  String? notice;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    search.addListener(() {
      if (search.text != query) setState(() => query = search.text);
    });
    unawaited(load());
    if (widget.outcome != null) unawaited(announce(widget.outcome!));
  }

  @override
  void dispose() {
    search.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(load());
  }

  /// The notice a User sees on the way back from a service's sign-in. The name
  /// comes from what was saved on the way out; without it the words still work.
  Future<void> announce(String outcome) async {
    final name = await widget.store?.read(pendingConnectionKey);
    await widget.store?.delete(pendingConnectionKey);
    final service = name == null || name.isEmpty ? 'That service' : name;
    if (!mounted) return;
    setState(() {
      switch (outcome) {
        case 'ready':
          noticeTitle = 'Connected';
          notice = '$service is connected. Any Bot you allow can use it.';
        case 'pending':
          noticeTitle = 'Still finishing';
          notice = '$service is still finishing. Pull to refresh in a moment.';
        default:
          noticeTitle = 'Not connected';
          notice = 'Couldn’t connect $service. Try again.';
      }
    });
  }

  Future<void> load() async {
    if (loading) return;
    setState(() => loading = true);
    try {
      final results = await Future.wait([
        widget.api.request('/api/settings/connections'),
        catalogPayload(),
      ]);
      final next = wire.ConnectionsFrame.fromJson(results[0]);
      if (next.ownerId.value != widget.userId) {
        throw const FormatException('Wrong owner');
      }
      final catalog = readCatalog(results[1]);
      if (mounted) {
        setState(() {
          frame = next;
          services = catalog;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          frame = null;
          services = null;
        });
      }
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  /// A catalog the server cannot serve leaves the accounts readable: this
  /// screen is still the User's own accounts when there is nothing to add.
  Future<Object?> catalogPayload() async {
    try {
      return await widget.api.request('/api/plugins/composio/catalog');
    } catch (_) {
      return null;
    }
  }

  /// `{schemaVersion:1, items:[{id, name, description?, icon?}]}`; a row the
  /// app cannot read is dropped rather than failing the whole screen.
  static List<ServiceEntry>? readCatalog(Object? payload) {
    if (payload is! Map || payload['schemaVersion'] != 1) return null;
    final items = payload['items'];
    if (items is! List) return null;
    final entries = <ServiceEntry>[];
    for (final item in items.take(2000)) {
      if (item is! Map) continue;
      final id = item['id'];
      final name = item['name'];
      if (id is! String || id.isEmpty) continue;
      final description = item['description'];
      final icon = item['icon'];
      entries.add(
        ServiceEntry(
          id: id,
          name: name is String && name.trim().isNotEmpty ? name : id,
          description: description is String && description.trim().isNotEmpty
              ? description
              : null,
          icon: icon is String && icon.startsWith('https://') ? icon : null,
        ),
      );
    }
    return entries;
  }

  Future<void> connect(ServiceEntry service) async {
    if (busy) return;
    setState(() {
      busy = true;
      noticeTitle = null;
      notice = null;
    });
    try {
      await widget.store?.write(pendingConnectionKey, service.name);
      final result = await widget.api.request(
        '/api/plugins/composio/connections',
        body: {
          'schemaVersion': 1,
          'type': 'connection/start',
          'commandId': randomId(),
          'connectionTypeId': 'app',
          'connectorId': service.id,
          'alias': service.name,
        },
      );
      final redirect = result is Map ? result['redirectUrl'] : null;
      if (redirect == null) {
        // Nothing to sign in to: the connection is already live.
        await widget.store?.delete(pendingConnectionKey);
        if (mounted) {
          setState(() {
            noticeTitle = 'Connected';
            notice = '${service.name} is connected.';
          });
        }
        await load();
        return;
      }
      final uri = Uri.parse(redirect as String);
      if (uri.scheme != 'https' || uri.userInfo.isNotEmpty) {
        throw const FormatException('Invalid sign-in link');
      }
      final opened =
          await (widget.openBrowser?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
      if (!opened) throw const FormatException('Browser unavailable');
      if (mounted) {
        setState(() {
          noticeTitle = 'Waiting for ${service.name}';
          notice =
              'Finish signing in to ${service.name} in your browser, then come back.';
        });
      }
    } catch (_) {
      await widget.store?.delete(pendingConnectionKey);
      if (mounted) {
        setState(() {
          noticeTitle = 'Not connected';
          notice = 'Couldn’t start ${service.name}. Try again.';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> remove(Map<String, Object?> account) async {
    final label = account['label']! as String;
    final confirmed = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (context) => _RemoveSheet(label: label),
    );
    if (confirmed != true || busy) return;
    setState(() {
      busy = true;
      noticeTitle = null;
      notice = null;
    });
    try {
      final id = Uri.encodeComponent(account['id']! as String);
      await widget.api.request(
        '/api/plugins/composio/connections/$id/revoke',
        body: {'schemaVersion': 1, 'type': 'connection/revoke'},
      );
      if (mounted) {
        setState(() {
          noticeTitle = 'Removed';
          notice = '$label is no longer connected.';
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          noticeTitle = 'Still connected';
          notice = 'Couldn’t remove $label. Try again.';
        });
      }
    } finally {
      if (mounted) setState(() => busy = false);
      await load();
    }
  }

  static (String, TileTone) statusOf(Object? state) => switch (state) {
    'ready' => ('Connected', TileTone.good),
    'disabled' => ('Paused', TileTone.neutral),
    'authorizing' => ('Finish signing in', TileTone.accent),
    'revoking' => ('Removing', TileTone.warn),
    'reconciliation-required' => ('Needs attention', TileTone.warn),
    _ => ('Needs attention', TileTone.danger),
  };

  bool matches(String text) =>
      query.trim().isEmpty ||
      text.toLowerCase().contains(query.trim().toLowerCase());

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final searching = query.trim().isNotEmpty;
    return FrockPage(
      title: 'Connect',
      padded: false,
      trailing: FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh services',
        onTap: loading ? null : load,
      ),
      child: frame == null
          ? loading
                ? const FrockLoading(label: 'Loading your services')
                : FrockEmptyState(
                    icon: Icons.cloud_off_rounded,
                    title: 'Services couldn’t load',
                    detail: 'Check your connection and try again.',
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
                  6,
                  FrockTokens.edge,
                  FrockTokens.edge,
                ),
                children: [
                  _SearchField(controller: search),
                  if (notice != null) ...[
                    const SizedBox(height: FrockTokens.groupGap),
                    FrockGroup(
                      needsYou: true,
                      children: [
                        Semantics(
                          liveRegion: true,
                          child: FrockNotice(
                            title: noticeTitle ?? 'Connections',
                            body: notice!,
                          ),
                        ),
                      ],
                    ),
                  ],
                  ...sections(searching),
                  const SizedBox(height: 14),
                  Text(
                    'Connections belong to you, not to a Bot. Any Bot you '
                    'allow can use them, and every use shows up as a receipt.',
                    style: t.caption.copyWith(height: 17 / 12),
                  ),
                ],
              ),
            ),
    );
  }

  List<Widget> sections(bool searching) {
    final accounts = [
      for (final account in frame!.accounts)
        if (matches('${account['label']} ${account['service']}')) account,
    ];
    final connectedNames = {
      for (final account in frame!.accounts)
        (account['service']! as String).toLowerCase(),
    };
    final catalog = services;
    final available = [
      for (final service in catalog ?? const <ServiceEntry>[])
        if (!connectedNames.contains(service.name.toLowerCase()) &&
            matches('${service.name} ${service.description ?? ''}'))
          service,
    ];
    final popular = [
      for (final id in popularServices)
        ...available.where((service) => service.id == id),
    ];
    final rest = [
      for (final service in available)
        if (!popular.contains(service)) service,
    ];
    return [
      if (accounts.isNotEmpty) ...[
        const SizedBox(height: FrockTokens.groupGap),
        const FrockEyebrow('Connected'),
        const SizedBox(height: FrockTokens.eyebrowToGroup),
        FrockTileGrid(
          children: [
            for (final account in accounts)
              () {
                final (label, tone) = statusOf(account['state']);
                return FrockServiceTile(
                  key: ValueKey('account-${account['id']}'),
                  name: account['service']! as String,
                  caption: label,
                  tone: tone,
                  dot: true,
                  onTap: busy ? null : () => remove(account),
                  onLongPress: busy ? null : () => remove(account),
                );
              }(),
          ],
        ),
      ],
      if (catalog == null) ...[
        const SizedBox(height: FrockTokens.groupGap),
        const FrockGroup(
          children: [
            FrockRow(
              leading: FrockIconTile(Icons.cloud_off_rounded),
              title: 'Services couldn’t load',
              caption: 'Pull to refresh to try again.',
            ),
          ],
        ),
      ] else if (available.isEmpty) ...[
        const SizedBox(height: FrockTokens.groupGap),
        FrockGroup(
          children: [
            FrockRow(
              leading: const FrockIconTile(Icons.search_rounded),
              title: searching
                  ? 'No services match that'
                  : 'No services available yet',
              caption: searching
                  ? 'Try a shorter word.'
                  : 'Nothing is ready to connect to just yet.',
            ),
          ],
        ),
      ] else ...[
        if (popular.isNotEmpty && !searching) ...[
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Popular'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          FrockTileGrid(
            children: [for (final service in popular) tileFor(service)],
          ),
        ],
        if (rest.isNotEmpty || searching) ...[
          const SizedBox(height: FrockTokens.groupGap),
          FrockEyebrow(searching ? 'Services' : 'All services'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          FrockTileGrid(
            children: [
              for (final service in (searching ? available : rest))
                tileFor(service),
            ],
          ),
        ],
      ],
    ];
  }

  Widget tileFor(ServiceEntry service) => FrockServiceTile(
    key: ValueKey('service-${service.id}'),
    name: service.name,
    caption: service.description,
    iconUrl: service.icon,
    onTap: busy ? null : () => connect(service),
  );
}

class _SearchField extends StatelessWidget {
  final TextEditingController controller;
  const _SearchField({required this.controller});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Container(
      constraints: const BoxConstraints(minHeight: 40),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: t.tile,
        borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
        border: Border.all(color: t.line),
      ),
      child: Row(
        children: [
          Icon(Icons.search_rounded, size: 16, color: t.ink3),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: controller,
              style: t.body,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: EdgeInsets.zero,
                hintText: 'Search services',
                hintStyle: t.body.copyWith(color: t.ink3),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Removing a connection is the one destructive thing on this screen, so it
/// asks, in the words of what will stop working.
class _RemoveSheet extends StatelessWidget {
  final String label;
  const _RemoveSheet({required this.label});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return SafeArea(
      child: Container(
        margin: const EdgeInsets.all(FrockTokens.edge),
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: t.sheet,
          borderRadius: BorderRadius.circular(FrockTokens.radiusSheet),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Remove $label?', style: t.nameStyle),
            const SizedBox(height: 8),
            Text(
              'Your Bots will stop being able to use it. You can connect it '
              'again any time.',
              style: t.body.copyWith(color: t.ink2),
            ),
            const SizedBox(height: 18),
            Row(
              children: [
                Expanded(
                  child: FrockPill(
                    'Keep it',
                    kind: PillKind.tonal,
                    expand: true,
                    onTap: () => Navigator.of(context).pop(false),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FrockPill(
                    'Remove',
                    kind: PillKind.primary,
                    expand: true,
                    onTap: () => Navigator.of(context).pop(true),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
