/// The settings command one view action means.
///
/// The server projects a `SettingsFrame` as a `ViewDocument` (`settingsDocumentV1`),
/// and this is the other end of that projection: the two conventions it
/// encodes, read back.
///
/// - A field id is `f<section>.<id>`, or `j<section>.<id>` when the value
///   travels JSON-encoded because an action input carries only strings,
///   numbers and booleans.
/// - The action's declared input names the section, and — for a section
///   action — its kind.
///
/// The renderer never learns any of this. It assembles the input the document
/// declared; the settings surface is what turns it back into the command the
/// existing route already takes.
library;

import 'dart:convert';

const manageProviderKindV1 = 'manage-provider';

/// The kind a section action names, when the action is one.
String? viewActionKindV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['kind']) as String?;

Map<String, Object?> settingsChangeCommandV1({
  required Map<String, Object?> command,
  required String userId,
}) {
  final input = ((command['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  final actionId = command['actionId']! as String;
  final sectionId = input['sectionId'];
  if (sectionId is! String) {
    throw const FormatException('This action names no settings section.');
  }
  final values = <String, Object?>{};
  final unset = <String>[];
  if (actionId.startsWith('unset-')) {
    final fieldId = input['fieldId'];
    if (fieldId is! String) {
      throw const FormatException('This action names no setting.');
    }
    unset.add(fieldId);
  } else {
    for (final entry in input.entries) {
      if (entry.key == 'sectionId' || entry.key == 'kind') continue;
      final split = entry.key.indexOf('.');
      if (split < 1) {
        throw const FormatException('This action carries an unknown setting.');
      }
      final id = entry.key.substring(split + 1);
      values[id] = entry.key.startsWith('j')
          ? jsonDecode(entry.value! as String)
          : entry.value;
    }
  }
  return {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'expectedRevision': command['revision'],
    'ownerId': userId,
    'sectionId': sectionId,
    'values': values,
    if (unset.isNotEmpty) 'unset': unset,
  };
}
