/// What one Audit action means.
///
/// The server projects a page of one Bot's audited effects as a `ViewDocument`
/// (`auditDocumentV1`), and this is the other end of that projection. Two of
/// the four kinds are the reader's own query, which the host owns because the
/// host owns the read; one is the rebuild command; and one opens a Turn in the
/// Work view.
library;

const auditActionKindsV1 = <String>{
  'filter-kind',
  'load-more',
  'rebuild',
  'open-run',
};

/// The kind an action names, or nothing when it names none.
String? auditActionKindV1(Map<String, Object?> command) {
  final kind = ((command['input'] as Map?)?['kind']) as String?;
  return auditActionKindsV1.contains(kind) ? kind : null;
}

/// The audit kind a filter selects. Absent means every kind.
String? auditKindV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['auditKind']) as String?;

/// The page cursor a "load more" carries.
String? auditCursorV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['cursor']) as String?;

/// The Turn an action opens.
String? auditRunIdV1(Map<String, Object?> command) =>
    ((command['input'] as Map?)?['runId']) as String?;

/// The audit read one query means, as a path.
String auditPathV1({String? botId, String? kind, String? before}) {
  final query = Uri(
    queryParameters: {
      'botId': ?botId,
      'kind': ?kind,
      'before': ?before,
      'as': 'document',
    },
  ).query;
  return '/api/audit?$query';
}
