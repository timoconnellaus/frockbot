import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../connections/page.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../settings/page.dart';
import '../shell/semantics.dart';
import '../view/surface.dart';
import 'document.dart';

/// Reads the Plugins document and carries one action to the settings route.
class PluginsController extends ViewSurfaceController {
  final NativeApi api;
  final String userId;
  final bool capabilities;

  /// Where a row's "Set up in …" goes. Navigation is not a command, so the
  /// host answers it itself rather than sending it anywhere.
  final void Function(String home, String? packageId)? openHome;
  wire.ViewDocument? _document;
  wire.ViewDocument? _all;
  String _query = '';
  void search(String query) {
    _query = query.trim().toLowerCase();
    final raw = _all?.toJson();
    if (raw is! Map) return;
    final root = raw['root'] as Map;
    root['children'] = (root['children'] as List).where((node) {
      if (node is! Map || node['type'] != 'group' || _query.isEmpty) {
        return true;
      }
      return [
        node['title'],
        ...(node['children'] as List).whereType<Map>().map(
          (child) => child['text'] ?? '',
        ),
      ].join(' ').toLowerCase().contains(_query);
    }).toList();
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
  });

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => capabilities ? 'capabilities' : 'plugins';

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
        await api.request(
          '/api/settings/${capabilities ? 'capabilities' : 'plugins'}?as=document',
        ),
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
    return ((answer as Map?) ?? const {}).cast<String, Object?>();
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
class PluginsPage extends StatelessWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final bool capabilities;

  const PluginsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    this.capabilities = false,
  });

  void _openHome(BuildContext context, String home, String? packageId) {
    final page = switch (home) {
      // A model provider's accounts and a connector Package's are one surface
      // in this client, so both homes land on Connectors.
      'models' => SettingsPage(
        api: api,
        store: store,
        userId: userId,
        home: 'models',
      ),
      'connections' => ConnectionsPage(api: api, store: store, userId: userId),
      'user-settings' => SettingsPage(
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
    final controller = PluginsController(
      api,
      userId,
      capabilities: capabilities,
      openHome: (home, packageId) => _openHome(context, home, packageId),
    );
    return ViewSurfacePage(
      title: capabilities ? 'Bot capabilities' : 'Plugins',
      cardGroups: capabilities,
      store: store,
      userId: userId,
      documentId: PluginIds.document,
      refreshId: PluginIds.refresh,
      controller: controller,
      banner: (_) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search),
            hintText: capabilities ? 'Find a feature' : 'Find a plugin',
          ),
          onChanged: controller.search,
        ),
      ),
    );
  }
}
