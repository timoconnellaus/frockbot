/// Account search combines the server's index with the Bot directory and
/// read-only Routine lists. Selecting a result is navigation, never execution.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/transport.dart';

const searchMaxQueryLengthV1 = 200;
const searchDebounce = Duration(milliseconds: 200);

enum SearchCategory {
  all('All'),
  messages('Messages'),
  bots('Bots'),
  groups('Groups'),
  files('Files'),
  links('Links'),
  routines('Routines'),
  actions('Actions');

  final String label;
  const SearchCategory(this.label);
  String labelFor({required bool phone}) =>
      phone && this == groups ? 'Group Chats' : label;
}

class SearchSelection {
  final String? botId;
  final String? runId;
  final String? routineId;
  final String? actionId;
  const SearchSelection({
    this.botId,
    this.runId,
    this.routineId,
    this.actionId,
  });
}

class SearchBot {
  final String id;
  final String name;
  final String description;
  final String? background;
  final bool unread;
  final bool archived;
  final bool hidden;
  const SearchBot({
    required this.id,
    required this.name,
    this.description = '',
    this.background,
    this.unread = false,
    this.archived = false,
    this.hidden = false,
  });
}

class SearchAction {
  final String id;
  final String title;
  final String subtitle;
  const SearchAction(this.id, this.title, this.subtitle);
}

class SearchEntry {
  final String key;
  final String title;
  final String subtitle;
  final SearchCategory category;
  final SearchSelection selection;
  final SearchBot? bot;
  const SearchEntry({
    required this.key,
    required this.title,
    required this.subtitle,
    required this.category,
    required this.selection,
    this.bot,
  });
}

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

  String get kindLabel => switch (kind) {
    'user' => 'You',
    'assistant' => 'Reply',
    'tool' => 'Tool',
    'link' => 'Link',
    _ => 'File',
  };

  static SearchHit? decode(Object? value) {
    if (value is! Map || value['runId'] is! String) return null;
    return SearchHit(
      runId: value['runId'] as String,
      kind: value['kind'] as String? ?? 'assistant',
      at: value['at'] as String? ?? '',
      snippet: value['snippet'] as String? ?? '',
    );
  }
}

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
    if (value is! Map || value['botId'] is! String) return null;
    return SearchGroup(
      botId: value['botId'] as String,
      botName: value['botName'] as String? ?? value['botId'] as String,
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
  final List<SearchBot> bots;
  final List<SearchAction> actions;
  BotSearchController(
    this.api, {
    this.bots = const [],
    this.actions = const [],
  });

  String query = '';
  SearchCategory category = SearchCategory.all;
  bool loading = false;
  bool rebuilding = false;
  bool routinesLoading = false;
  bool includeArchived = false;
  bool includeTools = false;
  String indexState = 'ready';
  String? error;
  List<SearchGroup>? groups;
  bool truncated = false;
  String? answeredQuery;
  final Map<String, List<SearchEntry>> _routines = {};
  final Set<String> _routineFailures = {};
  Future<void>? _routineRead;
  Timer? _debounce;
  int _generation = 0;
  bool _closed = false;

  int get totalHits =>
      groups?.fold(0, (sum, group) => sum! + group.totalHits) ?? 0;
  bool get wantsRoutines =>
      category == SearchCategory.routines ||
      (category == SearchCategory.all && query.trim().isNotEmpty);
  bool get wantsIndex => switch (category) {
    SearchCategory.all => query.trim().isNotEmpty,
    SearchCategory.messages ||
    SearchCategory.files ||
    SearchCategory.links => true,
    _ => false,
  };
  bool get busy => loading || (wantsRoutines && routinesLoading);
  int get failedRoutineBots => _routineFailures
      .where(
        (id) => bots.any(
          (bot) => bot.id == id && (includeArchived || !bot.archived),
        ),
      )
      .length;

  List<String> get kinds => switch (category) {
    SearchCategory.files => const ['media'],
    SearchCategory.links => const ['link'],
    SearchCategory.all => [
      'user',
      'assistant',
      'media',
      'link',
      if (includeTools) 'tool',
    ],
    _ => ['user', 'assistant', if (includeTools) 'tool'],
  };

  List<SearchEntry> get entries {
    final text = query.trim().toLowerCase();
    bool matches(String value) => value.toLowerCase().contains(text);
    final available = bots.where((bot) => includeArchived || !bot.archived);
    return [
      if (category == SearchCategory.all || category == SearchCategory.bots)
        for (final bot in available)
          if (matches('${bot.name} ${bot.description}'))
            SearchEntry(
              key: 'bot:${bot.id}',
              title: bot.name,
              subtitle: [
                if (bot.archived) 'Archived' else if (bot.hidden) 'Hidden',
                if (bot.description.isNotEmpty) bot.description,
              ].join(' · '),
              category: SearchCategory.bots,
              selection: SearchSelection(botId: bot.id),
              bot: bot,
            ),
      if (wantsIndex)
        for (final group in groups ?? const <SearchGroup>[])
          for (var index = 0; index < group.hits.length; index++)
            _hitEntry(group, group.hits[index], index),
      if (wantsRoutines)
        for (final bot in available)
          for (final routine in _routines[bot.id] ?? const <SearchEntry>[])
            if (matches('${routine.title} ${routine.subtitle}')) routine,
      if (category == SearchCategory.actions ||
          (category == SearchCategory.all && text.isNotEmpty))
        for (final action in actions)
          if (matches('${action.title} ${action.subtitle}'))
            SearchEntry(
              key: 'action:${action.id}',
              title: action.title,
              subtitle: action.subtitle,
              category: SearchCategory.actions,
              selection: SearchSelection(actionId: action.id),
            ),
    ];
  }

  SearchEntry _hitEntry(SearchGroup group, SearchHit hit, int index) =>
      SearchEntry(
        key: '${group.botId}:${hit.runId}:${hit.kind}:$index',
        title: hit.snippet,
        subtitle: [
          group.botName,
          if (group.archived) 'Archived' else if (group.hidden) 'Hidden',
          hit.kindLabel,
          if (hit.at.isNotEmpty) _date(hit.at),
        ].join(' · '),
        category: switch (hit.kind) {
          'media' => SearchCategory.files,
          'link' => SearchCategory.links,
          _ => SearchCategory.messages,
        },
        selection: SearchSelection(botId: group.botId, runId: hit.runId),
        bot: bots.where((bot) => bot.id == group.botId).firstOrNull,
      );

  void _changed() {
    if (!_closed) notifyListeners();
  }

  // Invalidate on the keystroke, before the debounce: an in-flight old read
  // must never become selectable while the field already contains new text.
  void _invalidate() {
    _generation++;
    _debounce?.cancel();
    groups = null;
    answeredQuery = null;
    error = null;
    truncated = false;
    loading = wantsIndex;
    _changed();
  }

  void setQuery(String value) {
    query = value.length > searchMaxQueryLengthV1
        ? value.substring(0, searchMaxQueryLengthV1)
        : value;
    _invalidate();
    _debounce = Timer(searchDebounce, () => unawaited(run()));
  }

  void setCategory(SearchCategory value) {
    if (category == value) return;
    category = value;
    _invalidate();
    unawaited(run());
  }

  void setIncludeArchived(bool value) {
    includeArchived = value;
    _invalidate();
    unawaited(run());
  }

  void setIncludeTools(bool value) {
    includeTools = value;
    _invalidate();
    unawaited(run());
  }

  Future<void> run() async {
    if (_closed) return;
    _debounce?.cancel();
    final generation = ++_generation;
    final trimmed = query.trim();
    if (wantsRoutines) unawaited(loadRoutines());
    if (!wantsIndex) {
      loading = false;
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
      if (_closed || generation != _generation) return;
      if (answer is! Map || answer['groups'] is! List) {
        throw const FormatException('Invalid search response');
      }
      groups = [
        for (final group in answer['groups'] as List)
          ?SearchGroup.decode(group),
      ];
      answeredQuery = trimmed;
      indexState = answer['indexState'] as String? ?? 'ready';
      truncated = ((answer['page'] as Map?)?['truncated']) == true;
    } catch (failure) {
      if (_closed || generation != _generation) return;
      error = failure is RequestFailure
          ? failure.message
          : 'Check your connection and try again.';
    } finally {
      if (generation == _generation) loading = false;
      _changed();
    }
  }

  Future<void> loadRoutines({bool retry = false}) async {
    if (_closed) return;
    if (_routineRead != null) {
      await _routineRead;
      if (!_closed && wantsRoutines) await loadRoutines(retry: retry);
      return;
    }
    final pending = bots
        .where(
          (bot) =>
              (includeArchived || !bot.archived) &&
              !_routines.containsKey(bot.id) &&
              (retry || !_routineFailures.contains(bot.id)),
        )
        .toList();
    if (pending.isEmpty) return;
    routinesLoading = true;
    _changed();
    var next = 0;
    Future<void> worker() async {
      while (!_closed && next < pending.length) {
        final bot = pending[next++];
        try {
          final answer = await api.request(
            '/api/bots/${Uri.encodeComponent(bot.id)}/routines',
          );
          if (answer is! Map || answer['routines'] is! List) {
            throw const FormatException('Invalid routines response');
          }
          _routines[bot.id] = [
            for (final value in answer['routines'] as List)
              if (value is Map &&
                  value['routineId'] is String &&
                  value['name'] is String)
                SearchEntry(
                  key: 'routine:${bot.id}:${value['routineId']}',
                  title: value['name'] as String,
                  subtitle:
                      '${_schedule(value)}${value['timezone'] is String ? ' · ${value['timezone']}' : ''} · ${bot.name}${value['enabled'] == false ? ' · Paused' : ''}',
                  category: SearchCategory.routines,
                  selection: SearchSelection(
                    botId: bot.id,
                    routineId: value['routineId'] as String,
                  ),
                  bot: bot,
                ),
          ];
          _routineFailures.remove(bot.id);
        } catch (_) {
          _routineFailures.add(bot.id);
        }
        _changed();
      }
    }

    _routineRead = Future.wait([for (var i = 0; i < 3; i++) worker()]);
    try {
      await _routineRead;
    } finally {
      _routineRead = null;
      routinesLoading = false;
      _changed();
    }
  }

  Future<void> rebuild() async {
    final before = indexState;
    rebuilding = true;
    indexState = 'rebuilding';
    error = null;
    _changed();
    try {
      final receipt = await api.request('/api/search/rebuild', body: const {});
      if (_closed) return;
      indexState = ((receipt as Map?)?['indexState'] as String?) ?? 'ready';
      await run();
    } catch (_) {
      indexState = before;
      error = 'Couldn’t rebuild the search index. Please try again.';
    } finally {
      rebuilding = false;
      _changed();
    }
  }

  @override
  void dispose() {
    _closed = true;
    _generation++;
    _debounce?.cancel();
    super.dispose();
  }
}

String _date(String at) {
  final parsed = DateTime.tryParse(at)?.toLocal();
  return parsed == null ? at : '${parsed.day}/${parsed.month}/${parsed.year}';
}

String _schedule(Map routine) {
  final trigger = routine['trigger'];
  if (trigger is Map) {
    return trigger['kind'] == 'webhook'
        ? 'When a webhook fires'
        : 'On ${trigger['trigger'] ?? 'a Plugin trigger'}';
  }
  final schedule = routine['schedule'] as String? ?? '';
  // The common daily and weekday cases read naturally. More complex schedules
  // retain the server's expression, so their meaning is never guessed.
  final parts = schedule.trim().split(RegExp(r'\s+'));
  if (parts.length == 5 && parts[2] == '*' && parts[3] == '*') {
    final minute = int.tryParse(parts[0]);
    final hour = int.tryParse(parts[1]);
    if (minute != null &&
        hour != null &&
        (parts[4] == '*' || parts[4] == '1-5')) {
      final time =
          '${hour % 12 == 0 ? 12 : hour % 12}:${minute.toString().padLeft(2, '0')} ${hour < 12 ? 'AM' : 'PM'}';
      return '${parts[4] == '*' ? 'Daily' : 'Weekdays'} at $time';
    }
  }
  return schedule.isEmpty ? 'Scheduled' : schedule;
}
