import 'dart:convert';

/// What the host will render of a plugin-described view.
///
/// A document past any of these is refused whole. A partial render would be a
/// lie about what the plugin said, and the plugin is untrusted code.
const maxViewBytesV1 = 262144;
const maxViewNodesV1 = 512;
const maxViewDepthV1 = 16;

class ViewBudgetFailure implements Exception {
  final String message;
  const ViewBudgetFailure(this.message);
  @override
  String toString() => message;
}

/// Refuses a document past the byte, node-count or depth budget. The schema has
/// already proved the shape; this bounds what the shape is allowed to cost.
void checkViewBudgetsV1(Map<String, Object?> document) {
  if (utf8.encode(jsonEncode(document)).length > maxViewBytesV1) {
    throw const ViewBudgetFailure('This view is larger than the host renders.');
  }
  var nodes = 0;
  void walk(Map<String, Object?> node, int depth) {
    if (++nodes > maxViewNodesV1) {
      throw const ViewBudgetFailure(
        'This view has more parts than the host renders.',
      );
    }
    if (depth > maxViewDepthV1) {
      throw const ViewBudgetFailure(
        'This view is nested deeper than the host renders.',
      );
    }
    switch (node['type']) {
      case 'group':
        for (final child in node['children'] as List) {
          walk((child as Map).cast<String, Object?>(), depth + 1);
        }
      case 'list':
        for (final row in node['rows'] as List) {
          walk(
            ((row as Map)['node'] as Map).cast<String, Object?>(),
            depth + 1,
          );
        }
    }
  }

  walk((document['root'] as Map).cast<String, Object?>(), 1);
}
