/// A control on a Plugin's conversation panel runs its tool and settles, the
/// same as one on the Plugin's card: the press is answered under its own
/// command id, so the panel's buttons are free again afterwards. And the
/// pointer moving under this client — the Bot's `panel_focus` — is told to
/// the shell, so the region follows it.
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/panels/canvas.dart';
import 'package:frockbot_native/view/action.dart';

import 'document_cache_test.dart' show listDocument;
import 'widget_test.dart' show MemoryStore;

class PanelToolApi extends NativeApi {
  PanelToolApi(super.store);

  final posted = <Map<String, Object?>>[];
  Map<String, Object?> answer = const {
    'status': 'ran',
    'content': 'Hello, World! (2 kept)',
    'isError': false,
  };

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/bots/bob/plugins' && body != null) {
      posted.add((body as Map).cast<String, Object?>());
      return answer;
    }
    if (path == '/api/bots/bob/panels/open') {
      return {
        'schemaVersion': 1,
        'bag': <Object>[],
        'focus': {'pluginId': null},
        'doors': <Object>[],
      };
    }
    throw FormatException('outside this fixture: $path');
  }
}

/// One `panels/open` read: the Hello tab, focused at [revision] or closed.
Map<String, Object?> panelView({bool focused = true, int revision = 1}) => {
  'schemaVersion': 1,
  'bag': [
    {
      'pluginId': 'hello-panel',
      'displayName': 'Hello',
      'surfaceId': 'hello',
      'label': 'Hello',
    },
  ],
  'focus': focused
      ? {'pluginId': 'hello-panel', 'surfaceId': 'hello'}
      : {'pluginId': null},
  if (focused)
    'document': listDocument(
      surfaceId: 'panel.hello-panel.hello',
      revision: revision,
      title: 'Hello',
    ),
  'doors': <Object>[],
};

class PanelFocusApi extends NativeApi {
  PanelFocusApi(super.store);

  Map<String, Object?> view = panelView(focused: false);
  final focused = <Object?>[];

  /// Holds the next read's answer — taken when it was asked — until released.
  Completer<void>? hold;

  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) async {
    if (path == '/api/bots/bob/panels/open') {
      final answer = view;
      final held = hold;
      hold = null;
      if (held != null) await held.future;
      return answer;
    }
    if (path == '/api/bots/bob/panels/focus') {
      focused.add(body);
      view = panelView(revision: 7);
      return {'status': 'applied'};
    }
    throw FormatException('outside this fixture: $path');
  }
}

const sayHello = <String, Object?>{
  'type': 'action',
  'actionId': 'plugin-tool',
  'label': 'Say hello',
  'input': {
    'kind': 'plugin-tool',
    'pluginId': 'hello-panel',
    'tool': 'say_hello',
    'arguments': '{"name":"World"}',
  },
};

const pluginToolSchema = <String, Object?>{
  'type': 'object',
  'properties': {
    'kind': {
      'type': 'string',
      'enum': ['plugin-tool'],
    },
    'pluginId': {'type': 'string', 'maxLength': 128},
    'tool': {'type': 'string', 'maxLength': 128},
    'arguments': {'type': 'string', 'maxLength': 8000},
  },
  'required': ['kind', 'pluginId', 'tool', 'arguments'],
  'additionalProperties': false,
};

void main() {
  late MemoryStore store;
  late PanelToolApi api;
  late PanelCanvasController canvas;
  late ViewController view;

  setUp(() {
    store = MemoryStore();
    api = PanelToolApi(store);
    canvas = PanelCanvasController(api, 'bob');
    view = ViewController(
      store: store,
      userId: 'tim',
      surfaceId: 'panel.hello-panel.hello',
      revision: 1,
      dispatch: canvas.dispatch,
    );
  });

  test('a tool that ran settles the press', () async {
    await view.submit(sayHello, pluginToolSchema);

    expect(api.posted.single['tool'], 'say_hello');
    expect(api.posted.single['arguments'], '{"name":"World"}');
    expect(view.message, 'Done.');
    expect(view.pending, isNull);
    expect(store.values, isEmpty);
  });

  test('a tool that failed settles the press as refused', () async {
    api.answer = const {
      'status': 'ran',
      'content': 'the storage grant is not open',
      'isError': true,
    };

    await view.submit(sayHello, pluginToolSchema);

    expect(
      view.message,
      'That action couldn’t be completed. Refresh and try again.',
    );
    expect(view.pending, isNull);
    expect(store.values, isEmpty);
  });

  group('the pointer moving', () {
    late PanelFocusApi focusApi;
    late PanelCanvasController panel;
    late int moves;

    setUp(() {
      focusApi = PanelFocusApi(store);
      panel = PanelCanvasController(focusApi, 'bob');
      moves = 0;
      panel.onFocusMoved = () => moves += 1;
    });

    tearDown(() => panel.disposeController());

    test('the first read is where it already was', () async {
      focusApi.view = panelView(revision: 3);
      await panel.load();
      expect(panel.regionOpen, isTrue);
      expect(moves, 0);
    });

    test(
      'the Bot focusing a surface is a move, and a re-read is not',
      () async {
        await panel.load();
        focusApi.view = panelView(revision: 3);
        await panel.poll();
        expect(panel.regionOpen, isTrue);
        expect(moves, 1);
        await panel.load();
        expect(moves, 1);
      },
    );

    test('the Bot focusing the same surface again is a move', () async {
      focusApi.view = panelView(revision: 3);
      await panel.load();
      focusApi.view = panelView(revision: 4);
      await panel.poll();
      expect(moves, 1);
    });

    test('the Bot closing the pointer is a move', () async {
      focusApi.view = panelView(revision: 3);
      await panel.load();
      focusApi.view = panelView(focused: false);
      await panel.poll();
      expect(panel.regionOpen, isFalse);
      expect(moves, 1);
    });

    test(
      'a poll that left before this client switched cannot undo it',
      () async {
        await panel.load();
        final release = focusApi.hold = Completer<void>();
        final stale = panel.poll();
        await panel.setFocus(pluginId: 'hello-panel', surfaceId: 'hello');
        release.complete();
        await stale;
        expect(panel.regionOpen, isTrue);
        expect(moves, 0);
      },
    );

    test('this client choosing a tab is not a move', () async {
      await panel.load();
      await panel.setFocus(pluginId: 'hello-panel', surfaceId: 'hello');
      expect(focusApi.focused, hasLength(1));
      expect(panel.regionOpen, isTrue);
      await panel.load();
      expect(moves, 0);
    });
  });
}
