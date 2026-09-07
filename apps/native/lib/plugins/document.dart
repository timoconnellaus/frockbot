/// The User configuration command one Plugins action means.
///
/// The server projects a `PluginsFrame` as a `ViewDocument`
/// (`pluginsDocumentV1`), and this is the other end of that projection: every
/// action's declared input names a `kind`, because an action id is opaque to
/// the renderer. Two of the three kinds are commands the settings route
/// already takes; the third is navigation, which no route owns.
library;

const pluginActionKindsV1 = <String>{
  'install-package',
  'set-package-enabled',
  'open-home',
};

/// The kind an action names, or nothing when it names none.
String? pluginActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return pluginActionKindsV1.contains(kind) ? kind : null;
}

/// The surface an `open-home` action points at, in this client's own words.
String? pluginHomeV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['home']) as String?;

/// The User configuration command an enablement action becomes.
Map<String, Object?> pluginCommandV1(Map<String, Object?> command) {
  final input = ((command['input'] as Map?) ?? const {})
      .cast<String, Object?>();
  final packageId = input['packageId'];
  if (packageId is! String) {
    throw const FormatException('This action names no plugin.');
  }
  final meta = {
    'schemaVersion': 1,
    'commandId': command['commandId'],
    'expectedRevision': command['revision'],
    'packageId': packageId,
  };
  if (pluginActionKindV1(command) == 'install-package') {
    final version = input['version'];
    if (version is! String) {
      throw const FormatException('This action names no version.');
    }
    return {...meta, 'type': 'user/install-package', 'version': version};
  }
  return {
    ...meta,
    'type': 'user/set-package-enabled',
    'enabled': input['enabled'] == true,
  };
}
