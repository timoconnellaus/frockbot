import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../connections/page.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../settings/page.dart';
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../view/surface.dart';
import 'document.dart';

/// Reads the Plugins document and carries one action to the settings route.
///
/// With a [botId] the page is that Bot's: what it could run and whether it
/// does, one switch per row, per Bot (ADR 0026). Without one it is the
/// account's list — what is installed — and the account-wide switches for
/// built-in features when [capabilities] is set.
class PluginsController extends ViewSurfaceController {
  final NativeApi api;
  final String userId;
  final bool capabilities;
  final bool marketplace;
  final String? botId;
  final VoidCallback? onFeaturesChanged;

  /// Where a row's "Set up in …" goes. Navigation is not a command, so the
  /// host answers it itself rather than sending it anywhere.
  final void Function(String home, String? packageId)? openHome;
  wire.ViewDocument? _document;
  wire.ViewDocument? _all;
  String _query = '';

  /// A row matches on its own name and the lines under it.
  bool _matches(Map node) => [
    node['title'],
    ...(node['children'] as List? ?? const []).whereType<Map>().map(
      (child) => child['text'] ?? '',
    ),
  ].join(' ').toLowerCase().contains(_query);

  /// A Bot's Plugins document files its rows under a titled section per kind,
  /// so a section is filtered by the rows inside it and dropped when none of
  /// them match; a flat document is matched as the row it is.
  Object? _filtered(Object? node) {
    if (node is! Map || node['type'] != 'group') return node;
    final rows = (node['children'] as List? ?? const [])
        .whereType<Map>()
        .where((child) => child['type'] == 'group' && child['title'] != null)
        .toList();
    if (rows.isEmpty) return _matches(node) ? node : null;
    final kept = rows.where(_matches).toList();
    if (kept.isEmpty) return null;
    return {...node.cast<String, Object?>(), 'children': kept};
  }

  void search(String query) {
    _query = query.trim().toLowerCase();
    final raw = _all?.toJson();
    if (raw is! Map) return;
    final root = raw['root'] as Map;
    root['children'] = _query.isEmpty
        ? (root['children'] as List)
        : (root['children'] as List)
              .map(_filtered)
              .where((node) => node != null)
              .toList();
    if (_query.isNotEmpty &&
        !(root['children'] as List).any(
          (node) => (node as Map)['type'] == 'group',
        )) {
      (root['children'] as List).add({
        'type': 'text',
        'text': 'No matches. Try a different name or purpose.',
      });
    }
    _document = wire.ViewDocument.fromJson(raw);
    _changed();
  }

  bool _busy = false;
  bool _closed = false;
  String? _message;

  PluginsController(
    this.api,
    this.userId, {
    this.openHome,
    this.capabilities = false,
    this.marketplace = false,
    this.botId,
    this.onFeaturesChanged,
  });

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => botId != null
      ? 'bot-plugins'
      : marketplace
      ? 'marketplace-plugins'
      : capabilities
      ? 'capabilities'
      : 'plugins';

  String get _path => botId != null
      ? '/api/bots/${Uri.encodeComponent(botId!)}/plugins'
      : marketplace
      ? '/api/settings/marketplace/plugins'
      : '/api/settings/${capabilities ? 'capabilities' : 'plugins'}';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('$_path?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Plugins surface mismatch');
      }
      _all = next;
      search(_query);
    } catch (_) {
      _message =
          'Couldn’t load your plugins. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    if (botId != null) {
      final input = ((command['input'] as Map?) ?? const {})
          .cast<String, Object?>();
      if (input['kind'] == 'plugin-tool') {
        // A control on a Plugin's section: the Bot runs the tool it names
        // and the page is read again, so the section shows what changed.
        final answer = await api.request(
          _path,
          body: {
            'schemaVersion': 1,
            'kind': 'plugin-tool',
            'commandId': command['commandId'],
            'pluginId': input['pluginId'],
            'tool': input['tool'],
            'arguments': input['arguments'] ?? '',
          },
        );
        final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
        final ran = receipt['status'] == 'ran' && receipt['isError'] != true;
        return {
          'commandId': command['commandId'],
          'status': ran ? 'applied' : 'rejected',
          if (!ran)
            'failure': receipt['failure'] is String
                ? receipt['failure']
                : receipt['content'] is String
                ? receipt['content']
                : 'This control could not run.',
        };
      }
      // A Bot's switch: the command names the Plugin and the revision the
      // page read, and the Bot answers applied, conflict or rejected.
      final answer = await api.request(
        _path,
        body: {
          'schemaVersion': 1,
          'kind': 'set-plugin-enabled',
          'commandId': command['commandId'],
          'pluginId': input['pluginId'],
          'enabled': input['enabled'] == true,
          'expectedRevision': input['expectedRevision'] ?? command['revision'],
        },
      );
      final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
      if (receipt['status'] == 'applied') onFeaturesChanged?.call();
      return {
        'commandId': command['commandId'],
        'status': receipt['status'] == 'applied' ? 'applied' : 'rejected',
        if (receipt['failure'] is String) 'failure': receipt['failure'],
        if (receipt['status'] == 'conflict')
          'failure': 'This page was out of date. Refreshed — try again.',
      };
    }
    if (pluginActionKindV1(command) == 'open-home') {
      openHome?.call(
        pluginHomeV1(command) ?? 'none',
        (command['input'] as Map?)?['packageId'] as String?,
      );
      return {'commandId': command['commandId'], 'status': 'applied'};
    }
    final answer = await api.request(
      '/api/settings',
      body: pluginCommandV1(command),
    );
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    if (receipt['status'] == 'applied') onFeaturesChanged?.call();
    return receipt;
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// Plugins: what a User has, and whether it is on.
///
/// Enablement only, as on the web. Nothing a Package declares — its accounts,
/// its credentials, its settings — is edited here: each lives on the surface
/// that owns what it configures, and a row offers the way there.
class PluginsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final bool capabilities;
  final bool marketplace;

  /// The Bot whose Plugins this page shows; absent, the account's list.
  final String? botId;
  final VoidCallback? onFeaturesChanged;
  final String? botName;

  /// Off inside the panel beside the conversation, which names it already.
  final bool chrome;

  const PluginsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.capabilities = false,
    this.marketplace = false,
    this.botId,
    this.onFeaturesChanged,
    this.botName,
    this.chrome = true,
  });

  @override
  State<PluginsPage> createState() => PluginsPageState();
}

class PluginsPageState extends State<PluginsPage>
    with AutomaticKeepAliveClientMixin<PluginsPage> {
  NativeApi get api => widget.api;
  LocalStore get store => widget.store;
  String get userId => widget.userId;
  bool get capabilities => widget.capabilities;
  bool get marketplace => widget.marketplace;
  String? get botId => widget.botId;
  String? get botName => widget.botName;

  @override
  bool get wantKeepAlive => true;

  late PluginsController controller;

  PluginsController _createController() => PluginsController(
    api,
    userId,
    capabilities: capabilities,
    marketplace: marketplace,
    botId: botId,
    onFeaturesChanged: () => widget.onFeaturesChanged?.call(),
    openHome: (home, packageId) => _openHome(context, home, packageId),
  );

  @override
  void initState() {
    super.initState();
    controller = _createController();
  }

  @override
  void didUpdateWidget(PluginsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api &&
        oldWidget.userId == widget.userId &&
        oldWidget.capabilities == widget.capabilities &&
        oldWidget.marketplace == widget.marketplace &&
        oldWidget.botId == widget.botId) {
      return;
    }
    final previous = controller;
    controller = _createController();
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void _openHome(BuildContext context, String home, String? packageId) {
    final page = switch (home) {
      // A model provider's accounts and a connector Package's are one surface
      // in this client, so both homes land on Connectors.
      'models' => SettingsPage(
        onFeaturesChanged: widget.onFeaturesChanged,
        api: api,
        store: store,
        userId: userId,
        home: 'models',
      ),
      'connections' => ConnectionsPage(
        api: api,
        store: store,
        userId: userId,
        onFeaturesChanged: widget.onFeaturesChanged,
      ),
      'user-settings' => SettingsPage(
        onFeaturesChanged: widget.onFeaturesChanged,
        api: api,
        store: store,
        userId: userId,
        section: packageId == null ? null : 'package.$packageId',
        title: 'Feature settings',
      ),
      _ => null,
    };
    if (page == null) return;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return ViewSurfacePage(
      title: botId != null
          ? 'Plugins'
          : marketplace
          ? 'Plugins'
          : capabilities
          ? 'Account features'
          : 'Plugins',
      cardGroups: capabilities && botId == null,
      gridGroups: marketplace && botId == null,
      switchRows: botId != null,
      chrome: widget.chrome,
      store: store,
      userId: userId,
      documentId: marketplace
          ? PluginIds.marketplaceDocument
          : PluginIds.document,
      refreshId: PluginIds.refresh,
      controller: controller,
      banner: (_) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: SteadyCaret(
          child: TextField(
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: capabilities && botId == null
                  ? 'Find a feature'
                  : 'Find a plugin',
            ),
            onChanged: controller.search,
          ),
        ),
      ),
    );
  }
}
