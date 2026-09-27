/// The Routine command one action on the Routines document means.
///
/// The server projects a Bot's Routines and the completions nested under each
/// of them as one `ViewDocument` (`routinesDocumentV1`), and this is the other
/// end of that projection: every action's declared input names a `kind`,
/// because an action id is opaque to the renderer. The Routine commands the
/// route already takes, and the navigation no route owns.
library;

const routineActionKindsV1 = <String>{
  'set-routine-enabled',
  'run-routine',
  'delete-routine',
  'open-run',
  'open-runs',
  'open-routine',
  'rotate-key',
  'revoke-key',
};

/// The kind an action names, or nothing when it names none.
String? routineActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return routineActionKindsV1.contains(kind) ? kind : null;
}

/// The Routine an action points at, or nothing.
String? routineIdV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['routineId']) as String?;

/// The completion a run-row names, or nothing.
String? routineEntryIdV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['entryId']) as String?;

/// The Routine command an action becomes.
///
/// A Routine carries no `expectedRevision`: it is its own durable record, so an
/// unrelated edit must not make a Routine write conflict. The command id is the
/// idempotency key and the whole of the fencing.
Map<String, Object?> routineCommandV1(
  Map<String, Object?> command,
  String botId,
) {
  final kind = routineActionKindV1(command);
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
  return switch (kind) {
    'set-routine-enabled' => {
      ...meta,
      'type': ((command['input'] as Map?)?['enabled'] == true)
          ? 'routine/resume'
          : 'routine/pause',
    },
    'run-routine' => {...meta, 'type': 'routine/run'},
    'delete-routine' => {...meta, 'type': 'routine/delete'},
    'rotate-key' => {...meta, 'type': 'routine/rotate-key'},
    'revoke-key' => {...meta, 'type': 'routine/revoke-key'},
    _ => throw const FormatException('That action is not a Routine command.'),
  };
}
