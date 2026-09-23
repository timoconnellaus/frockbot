import 'package:flutter/material.dart';

import '../client/transport.dart';
import '../protocol/client_wire.generated.dart' as wire;
import '../shell/semantics.dart';
import '../theme/caret.dart';
import '../view/surface.dart';

/// The receipt a view surface needs for a Plugin control's press, from the
/// Bot's answer to running the tool. The answer carries no command id, and a
/// press whose receipt does not name it is never settled.
Map<String, Object?> pluginToolReceiptV1(Object? commandId, Object? answer) {
  final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
  final ran = receipt['status'] == 'ran' && receipt['isError'] != true;
  return {
    'commandId': commandId,
    'status': ran ? 'applied' : 'rejected',
    if (!ran)
      'failure': receipt['failure'] is String
          ? receipt['failure']
          : receipt['content'] is String
          ? receipt['content']
          : 'This control could not run.',
  };
}

/// Reads one Bot's Plugins document and carries its switches to the Bot.
///
/// What the Bot could run and whether it does, one switch per row, per Bot
/// (ADR 0026). There is no account-wide list: a built-in feature is always
/// the account's, and a model provider is chosen in Models.
class PluginsController extends ViewSurfaceController {
  final NativeApi api;
  final String userId;
  final String botId;
  final VoidCallback? onFeaturesChanged;
  wire.ViewDocument? _document;
  wire.ViewDocument? _all;
  String _query = '';

  /// A row matches on its own name and the lines under it.
  bool _matches(Map node) => [
    node['title'],
    ...(node['children'] as List? ?? const []).whereType<Map>().map(
      (child) => child['text'] ?? '',
    ),
  ].join(' ').toLowerCase().contains(_query);

  /// The document files its rows under a titled section per kind, so a
  /// section is filtered by the rows inside it and dropped when none of them
  /// match; anything else is matched as the row it is.
  Object? _filtered(Object? node) {
    if (node is! Map || node['type'] != 'group') return node;
    final rows = (node['children'] as List? ?? const [])
        .whereType<Map>()
        .where((child) => child['type'] == 'group' && child['title'] != null)
        .toList();
    if (rows.isEmpty) return _matches(node) ? node : null;
    final kept = rows.where(_matches).toList();
    if (kept.isEmpty) return null;
    return {...node.cast<String, Object?>(), 'children': kept};
  }

  void search(String query) {
    _query = query.trim().toLowerCase();
    final raw = _all?.toJson();
    if (raw is! Map) return;
    final root = raw['root'] as Map;
    root['children'] = _query.isEmpty
        ? (root['children'] as List)
        : (root['children'] as List)
              .map(_filtered)
              .where((node) => node != null)
              .toList();
    if (_query.isNotEmpty &&
        !(root['children'] as List).any(
          (node) => (node as Map)['type'] == 'group',
        )) {
      (root['children'] as List).add({
        'type': 'text',
        'text': 'No matches. Try a different name or purpose.',
      });
    }
    _document = wire.ViewDocument.fromJson(raw);
    _changed();
  }

  bool _busy = false;
  bool _closed = false;
  String? _message;

  PluginsController(
    this.api,
    this.userId, {
    required this.botId,
    this.onFeaturesChanged,
  });

  @override
  void adoptCachedDocument(wire.ViewDocument cached) {
    if (_closed || _document != null) return;
    if (cached.surfaceId.value != surfaceId) return;
    _all = cached;
    search(_query);
  }

  @override
  wire.ViewDocument? get document => _document;

  @override
  wire.ViewDocument? get cacheDocument => _all;
  @override
  bool get busy => _busy;
  @override
  String? get message => _message;
  @override
  String get surfaceId => 'bot-plugins';

  String get _path => '/api/bots/${Uri.encodeComponent(botId)}/plugins';

  void _changed() {
    if (!_closed) notifyListeners();
  }

  @override
  Future<void> load() async {
    if (_busy) return;
    _busy = true;
    _message = null;
    _changed();
    try {
      final next = wire.ViewDocument.fromJson(
        await api.request('$_path?as=document'),
      );
      if (next.surfaceId.value != surfaceId) {
        throw const FormatException('Plugins surface mismatch');
      }
      _all = next;
      search(_query);
    } catch (_) {
      _message =
          'Couldn’t load your plugins. Check your connection and try again.';
    } finally {
      _busy = false;
      _changed();
    }
  }

  @override
  Future<Map<String, Object?>> dispatch(Map<String, Object?> command) async {
    final input = ((command['input'] as Map?) ?? const {})
        .cast<String, Object?>();
    if (input['kind'] == 'plugin-tool') {
      // A control on a Plugin's section: the Bot runs the tool it names and
      // the page is read again, so the section shows what changed.
      final answer = await api.request(
        _path,
        body: {
          'schemaVersion': 1,
          'kind': 'plugin-tool',
          'commandId': command['commandId'],
          'pluginId': input['pluginId'],
          'tool': input['tool'],
          'arguments': input['arguments'] ?? '',
        },
      );
      return pluginToolReceiptV1(command['commandId'], answer);
    }
    // A switch: the command names the Plugin and the revision the page read,
    // and the Bot answers applied, conflict or rejected.
    final answer = await api.request(
      _path,
      body: {
        'schemaVersion': 1,
        'kind': 'set-plugin-enabled',
        'commandId': command['commandId'],
        'pluginId': input['pluginId'],
        'enabled': input['enabled'] == true,
        'expectedRevision': input['expectedRevision'] ?? command['revision'],
      },
    );
    final receipt = ((answer as Map?) ?? const {}).cast<String, Object?>();
    if (receipt['status'] == 'applied') onFeaturesChanged?.call();
    return {
      'commandId': command['commandId'],
      'status': receipt['status'] == 'applied' ? 'applied' : 'rejected',
      if (receipt['failure'] is String) 'failure': receipt['failure'],
      if (receipt['status'] == 'conflict')
        'failure': 'This page was out of date. Refreshed — try again.',
    };
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

/// One Bot's Plugins: what it could run, and whether it does.
///
/// Enablement only. Nothing a Package declares — its accounts, its
/// credentials, its settings — is edited here.
class PluginsPage extends StatefulWidget {
  final NativeApi api;
  final LocalStore store;
  final String userId;
  final String botId;
  final VoidCallback? onFeaturesChanged;

  /// Off inside the panel beside the conversation, which names it already.
  final bool chrome;

  const PluginsPage({
    super.key,
    required this.api,
    required this.store,
    required this.userId,
    required this.botId,
    this.onFeaturesChanged,
    this.chrome = true,
  });

  @override
  State<PluginsPage> createState() => PluginsPageState();
}

class PluginsPageState extends State<PluginsPage>
    with AutomaticKeepAliveClientMixin<PluginsPage> {
  @override
  bool get wantKeepAlive => true;

  late PluginsController controller;

  PluginsController _createController() => PluginsController(
    widget.api,
    widget.userId,
    botId: widget.botId,
    onFeaturesChanged: () => widget.onFeaturesChanged?.call(),
  );

  @override
  void initState() {
    super.initState();
    controller = _createController();
  }

  @override
  void didUpdateWidget(PluginsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api == widget.api &&
        oldWidget.userId == widget.userId &&
        oldWidget.botId == widget.botId) {
      return;
    }
    final previous = controller;
    controller = _createController();
    previous.dispose();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return ViewSurfacePage(
      title: 'Plugins',
      switchRows: true,
      chrome: widget.chrome,
      store: widget.store,
      userId: widget.userId,
      documentId: PluginIds.document,
      refreshId: PluginIds.refresh,
      controller: controller,
      banner: (_) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: SteadyCaret(
          child: TextField(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Find a plugin',
            ),
            onChanged: controller.search,
          ),
        ),
      ),
      cacheScope: widget.botId,
    );
  }
}
