import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import 'document.dart';

/// Reads the settings document and carries one action to the settings route.
///
/// The retained command envelope is no longer here: `ViewController` owns it
/// for every plugin-described view, and settings is now one of those. What is
/// left is the read, the model catalog page, and the translation from a view
/// action to the settings command the route already takes.
class SettingsController extends ChangeNotifier {
  final NativeApi api;
  final String userId;
  final String home;
  wire.ViewDocument? document;
  bool busy = false;
  bool _closed = false;
  String? message;
  SettingsController(this.api, this.userId, this.home);

  String get surfaceId => 'settings-$home';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    if (busy) return;
    busy = true;
    message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('/api/settings/$home?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Settings surface mismatch');
      }
      document = next;
    } catch (_) {
      message =
          'Couldn’t load your settings. Check your connection and try again.';
    } finally {
      busy = false;
      _changed();
    }
  }

  Future<wire.SettingsOptionsPage> options(String query, int? cursor) async {
    final revision = document?.revision;
    if (revision == null) throw const FormatException('Settings unavailable');
    final page = wire.SettingsOptionsPage.fromJson(
      await api.request(
        '/api/settings/models/options',
        body: wire.SettingsOptionsQuery.fromJson({
          'schemaVersion': 1,
          'source': 'account-models',
          'revision': revision,
          'query': query,
          'cursor': ?cursor,
        }).toJson(),
      ),
    );
    if (page.ownerId.value != userId ||
        page.revision != revision ||
        page.source != 'account-models' ||
        document?.revision != revision) {
      throw const FormatException('Model catalog changed');
    }
    return page;
  }

  /// The settings route is where a view action on this surface lands. The
  /// receipt is returned as it arrived: the command's identity, and what
  /// happened to it, are `ViewController`'s to read.
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final answer = await api.request(
      '/api/settings/$home',
      body: settingsChangeCommandV1(command: command, userId: userId),
    );
    return (answer! as Map).cast<String, Object?>();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
