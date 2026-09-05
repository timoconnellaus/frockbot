import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;

/// A projection and a retained command envelope. The User owner decides saves.
class SettingsController extends ChangeNotifier {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String home;
  wire.SettingsFrame? frame;
  wire.SettingsChangeCommand? pending;
  bool busy = false;
  bool _closed = false;
  String? message;
  SettingsController(this.api, this.store, this.userId, this.home);
  String get _key => 'settings-pending.$userId.$home';
  void _changed() {
    if (!_closed) notifyListeners();
  }

  Future<void> load() async {
    if (busy) return;
    busy = true;
    message = null;
    _changed();
    try {
      final saved = await store.read(_key);
      pending = saved == null
          ? null
          : wire.SettingsChangeCommand.fromJson(decodeBoundedJson(saved));
      final next = wire.SettingsFrame.fromJson(
        await api.request('/api/settings/$home'),
      );
      if (next.ownerId.value != userId || next.home != home) {
        throw const FormatException('Settings owner mismatch');
      }
      frame = next;
      if (pending != null) message = 'A save still needs to be confirmed. Check it before making another change.';
    } catch (_) {
      message =
          'Couldn’t load your settings. Check your connection and try again.';
    } finally {
      busy = false;
      _changed();
    }
  }

  Future<wire.SettingsOptionsPage> options(String query, int? cursor) async {
    final revision = frame?.revision;
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
        frame?.revision != revision) {
      throw const FormatException('Model catalog changed');
    }
    return page;
  }

  Future<void> save(
    String sectionId,
    Map<String, Object?> values, {
    List<String> unset = const [],
  }) async {
    if (busy || pending != null || frame == null) return;
    pending = wire.SettingsChangeCommand.fromJson({
      'schemaVersion': 1,
      'commandId': randomId(),
      'expectedRevision': frame!.revision,
      'sectionId': sectionId,
      'ownerId': userId,
      'values': values,
      if (unset.isNotEmpty) 'unset': unset,
    });
    await checkSave();
  }

  Future<void> checkSave() async {
    if (busy || pending == null) return;
    busy = true;
    message = null;
    _changed();
    final command = pending!;
    var applied = false;
    try {
      if (command.ownerId.value != userId) {
        throw const FormatException('Settings owner mismatch');
      }
      // Persist before dispatch, and keep the same id through loss of the reply.
      await store.write(_key, jsonEncode(command.toJson()));
      final receipt =
          wire.SettingsReceipt.fromJson(
                await api.request(
                  '/api/settings/$home',
                  body: command.toJson(),
                ),
              ).value
              as Map;
      if (receipt['commandId'] != command.commandId.value) {
        throw const FormatException('Wrong receipt');
      }
      if (receipt['status'] == 'pending') {
        message = 'Your save is still processing. Check it again in a moment.';
      } else {
        await store.delete(_key);
        pending = null;
        applied = receipt['status'] == 'applied';
        message = applied ? 'Saved.' : 'These settings couldn’t be saved. Refresh Settings and try again.';
      }
    } on RequestFailure catch (failure) {
      if (failure.refused) {
        await store.delete(_key);
        pending = null;
        message = failure.status == 409
            ? 'Settings changed on another device. Refresh to see the latest version.'
            : 'These settings couldn’t be saved. Refresh Settings and try again.';
      } else {
        message = 'Couldn’t confirm the save. Check the save before making another change.';
      }
    } catch (_) {
      message = 'Couldn’t confirm the save. Check the save before making another change.';
    } finally {
      busy = false;
      _changed();
    }
    if (applied && !_closed) {
      await load();
      if (frame != null && message == null) message = 'Saved.';
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
