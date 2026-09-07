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

  /// Where a row's "Set up in …" goes. Navigation is not a command, so the
  /// host answers it itself rather than sending it anywhere.
  final void Function(String home)? openHome;
  wire.ViewDocument? _document;
  bool _busy = false;
  bool _closed = false;
  String? _message;

  PluginsController(this.api, this.userId, {this.openHome});

  @override
  wire.ViewDocument? get document => _document;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'plugins';

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
        await api.request('/api/settings/plugins?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Plugins surface mismatch');
      }
      _document = next;
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
      openHome?.call(pluginHomeV1(command) ?? 'none');
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

  const PluginsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
  });

  void _openHome(BuildContext context, String home) {
    final page = switch (home) {
      // A model provider's accounts and a connector Package's are one surface
      // in this client, so both homes land on Connectors.
      'models' ||
      'connections' => ConnectionsPage(api: api, store: store, userId: userId),
      'user-settings' => SettingsPage(api: api, store: store, userId: userId),
      _ => null,
    };
    if (page == null) return;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) => ViewSurfacePage(
    title: 'Plugins',
    store: store,
    userId: userId,
    documentId: PluginIds.document,
    refreshId: PluginIds.refresh,
    controller: PluginsController(
      api,
      userId,
      openHome: (home) => _openHome(context, home),
    ),
  );
}
