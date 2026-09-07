/// The Routine command one action on the Routines document means.
///
/// The server projects a Bot's Routines and its completion inbox as one
/// `ViewDocument` (`routinesDocumentV1`), and this is the other end of that
/// projection: every action's declared input names a `kind`, because an action
/// id is opaque to the renderer. Three kinds are Routine commands the route
/// already takes, one is the inbox command on a route of its own, and the
/// fifth is navigation, which no route owns.
library;

const routineActionKindsV1 = <String>{
  'set-routine-enabled',
  'run-routine',
  'delete-routine',
  'acknowledge-inbox',
  'open-runs',
};

/// The kind an action names, or nothing when it names none.
String? routineActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return routineActionKindsV1.contains(kind) ? kind : null;
}

/// The Routine an action points at, or nothing.
String? routineIdV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['routineId']) as String?;

/// The inbox entry an acknowledgement names. Absent is "Mark all read", which
/// means the entries the reader could see and not every entry the object holds.
String? routineEntryIdV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['entryId']) as String?;

/// The inbox entries a document offers an acknowledgement for — which is
/// exactly what its reader can see.
///
/// "Mark all read" means these and no more: an empty `entryIds` on the wire
/// acknowledges everything the object holds, including a firing that landed a
/// second ago and has never been on screen.
List<String> routineUnacknowledgedOnScreenV1(Object? root) {
  final entries = <String>[];
  void walk(Object? value) {
    if (value is! Map) return;
    final node = value.cast<String, Object?>();
    if (node['type'] == 'action' && node['actionId'] == 'acknowledge-inbox') {
      final entryId = ((node['input'] as Map?)?['entryId']) as String?;
      if (entryId != null) entries.add(entryId);
    }
    for (final child in (node['children'] as List? ?? const [])) {
      walk(child);
    }
    for (final row in (node['rows'] as List? ?? const [])) {
      walk((row as Map)['node']);
    }
  }

  walk(root);
  return entries;
}

/// The Routine command an action becomes.
///
/// A Routine carries no `expectedRevision`: it is its own durable record, so an
/// unrelated edit must not make a Routine write conflict. The command id is the
/// idempotency key and the whole of the fencing.
Map<String, Object?> routineCommandV1(
  Map<String, Object?> command,
  String botId,
) {
  final routineId = routineIdV1(command);
  if (routineId == null) {
    throw const FormatException('This action names no Routine.');
  }
  final meta = {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'botId': botId,
    'routineId': routineId,
  };
  return switch (routineActionKindV1(command)) {
    'set-routine-enabled' => {
      ...meta,
      'type': ((command['input'] as Map?)?['enabled'] == true)
          ? 'routine/resume'
          : 'routine/pause',
    },
    'run-routine' => {...meta, 'type': 'routine/run'},
    'delete-routine' => {...meta, 'type': 'routine/delete'},
    _ => throw const FormatException('That action is not a Routine command.'),
  };
}

/// The inbox command an acknowledgement becomes. An empty list acknowledges
/// every entry, so the host never sends one: `entryIds` is what it read.
Map<String, Object?> routineInboxCommandV1(
  Map<String, Object?> command,
  String botId,
  List<String> onScreen,
) {
  final entryId = routineEntryIdV1(command);
  final entryIds = entryId == null ? onScreen : <String>[entryId];
  if (entryIds.isEmpty) {
    throw const FormatException('There is nothing here to mark read.');
  }
  return {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'botId': botId,
    'type': 'routine/acknowledge-inbox',
    'entryIds': entryIds,
  };
}
