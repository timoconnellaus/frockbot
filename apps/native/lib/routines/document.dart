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
  'edit-routine',
  'cancel-edit',
  'save-routine',
  'rotate-key',
  'revoke-key',
};

/// The editor's field ids, as `ROUTINE_EDITOR_FIELDS_V1` writes them. There is
/// one form on the surface, so the ids carry no Routine.
const routineEditorFieldsV1 = (
  name: 'routine.name',
  prompt: 'routine.prompt',
  timing: 'routine.timing',
  schedule: 'routine.schedule',
  timezone: 'routine.timezone',
);

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

/// What the editor's fields were seeded with, by field id.
///
/// The projection puts the Routine's own values in the form, so this is what
/// the person was shown before they touched it — which is what tells an edit
/// apart from a Save on a form nobody changed.
Map<String, Object?> routineEditorSeedsV1(Object? root) {
  final seeds = <String, Object?>{};
  void walk(Object? value) {
    if (value is! Map) return;
    final node = value.cast<String, Object?>();
    if (node['type'] == 'field') {
      final field = (node['field']! as Map).cast<String, Object?>();
      seeds[field['id']! as String] = field['value'];
    }
    for (final child in (node['children'] as List? ?? const [])) {
      walk(child);
    }
    for (final row in (node['rows'] as List? ?? const [])) {
      walk((row as Map)['node']);
    }
  }

  walk(root);
  return seeds;
}

/// Whether a save would ask the route to change nothing.
///
/// The route refuses such an update, and rightly — an update that changes
/// nothing is not an update — but that refusal is not something to show a
/// person who pressed Save on a form they had opened and left alone.
bool routineSaveIsNoOpV1(
  Map<String, Object?> command,
  Map<String, Object?> seeds,
) {
  if (routineIdV1(command) == null) return false;
  final input = ((command['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  for (final id in [
    routineEditorFieldsV1.name,
    routineEditorFieldsV1.prompt,
    routineEditorFieldsV1.timing,
    routineEditorFieldsV1.schedule,
    routineEditorFieldsV1.timezone,
  ]) {
    if (input.containsKey(id) && input[id] != seeds[id]) return false;
  }
  return true;
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
  final kind = routineActionKindV1(command);
  if (kind == 'save-routine') return _saveCommandV1(command, botId);
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

/// One press, two verbs: a `routineId` names the Routine to update, and its
/// absence is what creating means.
///
/// A Routine fires on a schedule or on a webhook and never on both, so exactly
/// one of the two travels. An update carries every field the form holds, which
/// is what a form the person just read and pressed Save on means — the route's
/// partial update is for a Bot changing one thing, not for a person looking at
/// all of them.
Map<String, Object?> _saveCommandV1(
  Map<String, Object?> command,
  String botId,
) {
  final input = ((command['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  final name = (input[routineEditorFieldsV1.name] as String? ?? '').trim();
  final prompt = input[routineEditorFieldsV1.prompt] as String? ?? '';
  if (name.isEmpty) throw const FormatException('Give this Routine a name.');
  if (prompt.trim().isEmpty) {
    throw const FormatException('Say what this Routine should do.');
  }
  final webhook = input[routineEditorFieldsV1.timing] == 'webhook';
  final schedule = (input[routineEditorFieldsV1.schedule] as String? ?? '')
      .trim();
  if (!webhook && schedule.isEmpty) {
    throw const FormatException('Give this Routine a schedule.');
  }
  final timezone = (input[routineEditorFieldsV1.timezone] as String? ?? '')
      .trim();
  final routineId = routineIdV1(command);
  return {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'botId': botId,
    'type': routineId == null ? 'routine/create' : 'routine/update',
    'routineId': ?routineId,
    'name': name,
    'prompt': prompt,
    if (webhook) 'trigger': {'kind': 'webhook'} else 'schedule': schedule,
    if (timezone.isNotEmpty) 'timezone': timezone,
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
