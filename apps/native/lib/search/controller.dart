/// Search across every Bot this account has.
///
/// The backend owns the index and the deep link: this holds a query, debounces
/// it, and renders what `GET /api/search` answers. It builds no link of its
/// own and counts nothing itself — a hit's `deepLink` is the URL the route
/// handed back, and a group's `totalHits` is the route's own number.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';

/// Longest query the route accepts; typing past it is not a refusal.
const searchMaxQueryLengthV1 = 200;

/// Long enough that a fast typist makes one request, short enough that a pause
/// answers before it reads as a hang.
const searchDebounce = Duration(milliseconds: 200);

/// One conversation a query matched, in one Bot.
class SearchHit {
  final String runId;
  final String kind;
  final String at;
  final String snippet;
  const SearchHit({
    required this.runId,
    required this.kind,
    required this.at,
    required this.snippet,
  });

  /// What the row says the hit is, in words rather than in the wire.
  String get kindLabel => switch (kind) {
    'user' => 'You',
    'assistant' => 'Reply',
    'tool' => 'Tool',
    _ => 'Media',
  };

  static SearchHit? decode(Object? value) {
    if (value is! Map) return null;
    final runId = value['runId'];
    if (runId is! String) return null;
    return SearchHit(
      runId: runId,
      kind: value['kind'] as String? ?? 'assistant',
      at: value['at'] as String? ?? '',
      snippet: value['snippet'] as String? ?? '',
    );
  }
}

/// The hits one Bot holds. A Bot the sidebar hides is still searchable, and is
/// labelled rather than dropped.
class SearchGroup {
  final String botId;
  final String botName;
  final bool archived;
  final bool hidden;
  final int totalHits;
  final List<SearchHit> hits;
  const SearchGroup({
    required this.botId,
    required this.botName,
    required this.archived,
    required this.hidden,
    required this.totalHits,
    required this.hits,
  });

  static SearchGroup? decode(Object? value) {
    if (value is! Map) return null;
    final botId = value['botId'];
    if (botId is! String) return null;
    return SearchGroup(
      botId: botId,
      botName: value['botName'] as String? ?? botId,
      archived: value['archived'] == true,
      hidden: value['hidden'] == true,
      totalHits: value['totalHits'] as int? ?? 0,
      hits: [
        for (final hit in (value['hits'] as List? ?? const []))
          ?SearchHit.decode(hit),
      ],
    );
  }
}

class BotSearchController extends ChangeNotifier {
  final NativeApi api;
  BotSearchController(this.api);

  String query = '';
  bool loading = false;
  bool rebuilding = false;
  bool includeArchived = false;
  bool includeTools = false;
  String indexState = 'ready';
  String? error;

  /// Absent until a query has been answered, which is not the same as a query
  /// that matched nothing. Every state this surface can be in is named, because
  /// a blank panel that could mean any of them is the one thing it must not be.
  List<SearchGroup>? groups;
  bool truncated = false;
  String? answeredQuery;

  Timer? _debounce;
  int _generation = 0;
  bool _closed = false;

  int get totalHits =>
      groups?.fold(0, (sum, group) => sum! + group.totalHits) ?? 0;

  void _changed() {
    if (!_closed) notifyListeners();
  }

  void setQuery(String value) {
    query = value.length > searchMaxQueryLengthV1
        ? value.substring(0, searchMaxQueryLengthV1)
        : value;
    _changed();
    _debounce?.cancel();
    _debounce = Timer(searchDebounce, () => unawaited(run()));
  }

  void setIncludeArchived(bool value) {
    includeArchived = value;
    _changed();
    unawaited(run());
  }

  void setIncludeTools(bool value) {
    includeTools = value;
    _changed();
    unawaited(run());
  }

  /// `tool` is indexed and excluded by default: a tool result can carry
  /// credentials-adjacent text, so seeing it is an explicit opt-in.
  List<String> get kinds => includeTools
      ? const ['user', 'assistant', 'tool']
      : const ['user', 'assistant'];

  Future<void> run() async {
    final generation = ++_generation;
    final trimmed = query.trim();
    if (trimmed.isEmpty) {
      groups = null;
      answeredQuery = null;
      loading = false;
      error = null;
      _changed();
      return;
    }
    loading = true;
    error = null;
    _changed();
    try {
      final path = Uri(
        path: '/api/search',
        queryParameters: {
          'q': trimmed,
          'kinds': kinds.join(','),
          if (includeArchived) 'includeArchived': 'true',
        },
      ).toString();
      final answer = await api.request(path);
      // A slower earlier query must never overwrite a newer answer.
      if (generation != _generation) return;
      final results = (answer as Map?) ?? const {};
      groups = [
        for (final group in (results['groups'] as List? ?? const []))
          ?SearchGroup.decode(group),
      ];
      answeredQuery = results['query'] as String? ?? trimmed;
      indexState = results['indexState'] as String? ?? 'ready';
      truncated = ((results['page'] as Map?)?['truncated']) == true;
    } catch (failure) {
      if (generation != _generation) return;
      error = failure is RequestFailure
          ? failure.message
          : 'Search couldn’t run. Check your connection and try again.';
    } finally {
      if (generation == _generation) loading = false;
      _changed();
    }
  }

  /// A rebuild changes no durable fact, only the projection of facts the Bots
  /// already hold.
  Future<void> rebuild() async {
    rebuilding = true;
    indexState = 'rebuilding';
    error = null;
    _changed();
    try {
      final receipt = await api.request('/api/search/rebuild', body: const {});
      indexState = ((receipt as Map?)?['indexState'] as String?) ?? 'ready';
      await run();
    } catch (_) {
      error = 'Couldn’t rebuild the search index. Please try again.';
    } finally {
      rebuilding = false;
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    _debounce?.cancel();
    super.dispose();
  }
}
