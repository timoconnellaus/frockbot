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
  'edit-routine',
  'cancel-edit',
  'save-routine',
  'rotate-key',
  'revoke-key',
};

/// The editor's field ids, as `ROUTINE_EDITOR_FIELDS_V1` writes them. There is
/// one form, so the ids carry no Routine.
const routineEditorFieldsV1 = (
  name: 'routine.name',
  prompt: 'routine.prompt',
  timing: 'routine.timing',
  schedule: 'routine.schedule',
);

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

/// Whether the person has changed the form they were shown.
///
/// A field they have not touched is not a change, even when the controller
/// already holds the seed. Empty and missing are the same answer, so clearing
/// a create field they had typed is back to a form nobody has written.
bool routineEditorIsDirtyV1(
  Map<String, Object?> values,
  Map<String, Object?> seeds,
) {
  for (final id in [
    routineEditorFieldsV1.name,
    routineEditorFieldsV1.prompt,
    routineEditorFieldsV1.timing,
    routineEditorFieldsV1.schedule,
  ]) {
    if (!values.containsKey(id)) continue;
    if (_routineFieldTextV1(values[id]) != _routineFieldTextV1(seeds[id])) {
      return true;
    }
  }
  return false;
}

String _routineFieldTextV1(Object? value) => value == null ? '' : '$value';

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
/// A Routine fires on a schedule, on a webhook, on a Plugin trigger, or on a
/// connected-app event and never on two of them, so exactly one travels. An
/// update carries every field the form holds, which is what a form the person
/// just read and pressed Save on means — the route's partial update is for a
/// Bot changing one thing, not for a person looking at all of them.
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
  final timing = input[routineEditorFieldsV1.timing];
  final webhook = timing == 'webhook';
  final plugin = timing is String && timing.startsWith('plugin:');
  final connection = timing is String && timing.startsWith('connection:');
  if (timing != 'schedule' && !webhook && !plugin && !connection) {
    throw const FormatException('Choose what starts this Routine.');
  }
  final schedule = (input[routineEditorFieldsV1.schedule] as String? ?? '')
      .trim();
  if (!webhook && !plugin && !connection && schedule.isEmpty) {
    throw const FormatException('Give this Routine a schedule.');
  }
  final pluginParts = plugin ? timing.split(':') : const <String>[];
  final pluginId = pluginParts.length == 3 ? pluginParts[1].trim() : '';
  final pluginTrigger = pluginParts.length == 3 ? pluginParts[2].trim() : '';
  if (plugin && (pluginId.isEmpty || pluginTrigger.isEmpty)) {
    throw const FormatException(
      'Name the Plugin and the trigger this Routine fires on.',
    );
  }
  final connectionParts = connection ? timing.split(':') : const <String>[];
  final connectionId = connectionParts.length == 3
      ? connectionParts[1].trim()
      : '';
  final triggerType = connectionParts.length == 3
      ? connectionParts[2].trim()
      : '';
  if (connection && (connectionId.isEmpty || triggerType.isEmpty)) {
    throw const FormatException(
      'Name the app and the event this Routine fires on.',
    );
  }
  final routineId = routineIdV1(command);
  return {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'botId': botId,
    'type': routineId == null ? 'routine/create' : 'routine/update',
    'routineId': ?routineId,
    'name': name,
    'prompt': prompt,
    if (connection)
      'trigger': {
        'kind': 'connection',
        'connectionId': connectionId,
        'triggerType': triggerType,
      }
    else if (plugin)
      'trigger': {
        'kind': 'plugin',
        'pluginId': pluginId,
        'trigger': pluginTrigger,
      }
    else if (webhook)
      'trigger': {'kind': 'webhook'}
    else
      'schedule': schedule,
  };
}
