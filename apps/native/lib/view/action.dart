import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';

/// What the host sends when a person presses an `action` node. The route that
/// carries it lands with the surfaces that use it; the retention below is the
/// part the client owns either way.
typedef ViewActionDispatch = Future<Map<String, Object?>> Function(
  Map<String, Object?> command,
);

/// The input an action submits: what the node declared, overlaid with the
/// current value of every `field` node the action's schema names. A key the
/// schema does not declare never travels, and a missing required key refuses
/// before dispatch rather than after.
Map<String, Object?> viewActionInputV1(
  Map<String, Object?> node,
  Map<String, Object?> schema,
  Map<String, Object?> values,
) {
  final properties = (schema['properties'] as Map).cast<String, Object?>();
  final declared = ((node['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  // A null is not an answer. It is what a field that was never set holds, and
  // dropping it here is what lets a required key refuse by name rather than by
  // failing a type check the person cannot read.
  final input = <String, Object?>{
    for (final entry in declared.entries)
      if (properties.containsKey(entry.key) && entry.value != null)
        entry.key: entry.value,
    for (final entry in values.entries)
      if (properties.containsKey(entry.key) && entry.value != null)
        entry.key: entry.value,
  };
  for (final name in (schema['required'] as List).cast<String>()) {
    if (!input.containsKey(name)) {
      throw const FormatException('This action still needs an answer.');
    }
  }
  for (final entry in input.entries) {
    final value = (properties[entry.key] as Map).cast<String, Object?>();
    if (!_matches(value, entry.value)) {
      throw const FormatException('That value is not one this action takes.');
    }
  }
  return Map.unmodifiable(input);
}

bool _matches(Map<String, Object?> schema, Object? value) {
  switch (schema['type']) {
    case 'string':
      if (value is! String) return false;
      final options = schema['enum'] as List?;
      if (options != null) return options.contains(value);
      return value.runes.length <= (schema['maxLength'] as num);
    case 'boolean':
      return value is bool;
    case 'number':
      return value is num &&
          value.isFinite &&
          value >= (schema['minimum'] as num) &&
          value <= (schema['maximum'] as num);
  }
  return false;
}

/// Field values and one retained command envelope, on the settings surface's
/// terms: persist the command id before dispatch, keep it through a lost reply,
/// and let the person check it rather than mint a second one.
class ViewController extends ChangeNotifier {
  final LocalStore store;
  final String userId;
  final String surfaceId;
  final int revision;
  final ViewActionDispatch dispatch;
  final values = <String, Object?>{};

  /// Field ids holding a credential. A secret is not part of the document, so
  /// it is dropped the moment the command that carried it has been answered
  /// rather than kept around for a second press.
  final secrets = <String>{};
  Map<String, Object?>? pending;
  bool busy = false;
  String? message;
  bool _closed = false;

  ViewController({
    required this.store,
    required this.userId,
    required this.surfaceId,
    required this.revision,
    required this.dispatch,
  });

  String get _key => 'view-pending.$userId.$surfaceId';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  void change(String id, Object? value) {
    values[id] = value;
    _changed();
  }

  /// Restores a command whose reply never arrived, so the next press checks
  /// that one instead of starting a second.
  Future<void> restore() async {
    final saved = await store.read(_key);
    if (saved == null || _closed) return;
    pending = (decodeBoundedJson(saved) as Map).cast<String, Object?>();
    message = 'An action still needs to be confirmed. Check it before trying another.';
    _changed();
  }

  Future<void> submit(
    Map<String, Object?> node,
    Map<String, Object?> schema,
  ) async {
    if (busy || pending != null) return;
    try {
      pending = {
        'commandId': randomId(),
        'surfaceId': surfaceId,
        'revision': revision,
        'actionId': node['actionId'],
        'input': viewActionInputV1(node, schema, values),
      };
    } on FormatException catch (failure) {
      message = failure.message;
      _changed();
      return;
    }
    await check();
  }

  /// Dispatches the retained command, under its own id, however many times it
  /// takes to learn what happened to it.
  Future<void> check() async {
    if (busy || pending == null) return;
    busy = true;
    message = null;
    _changed();
    final command = pending!;
    try {
      await store.write(_key, jsonEncode(command));
      final receipt = await dispatch(command);
      if (receipt['commandId'] != command['commandId']) {
        throw const FormatException('Wrong receipt');
      }
      if (receipt['status'] == 'pending') {
        message = 'That action is still running. Check it again in a moment.';
      } else {
        await store.delete(_key);
        pending = null;
        for (final id in secrets) {
          values.remove(id);
        }
        message = receipt['status'] == 'applied'
            ? 'Done.'
            : 'That action couldn’t be completed. Refresh and try again.';
      }
    } on RequestFailure catch (failure) {
      if (failure.refused) {
        await store.delete(_key);
        pending = null;
        message = 'That action couldn’t be completed. Refresh and try again.';
      } else {
        message =
            'Couldn’t confirm that action. Check it before trying another.';
      }
    } catch (_) {
      message = 'Couldn’t confirm that action. Check it before trying another.';
    } finally {
      busy = false;
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}
