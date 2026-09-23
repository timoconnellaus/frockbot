/// A control on a Plugin's conversation panel runs its tool and settles, the
/// same as one on the Plugin's card: the press is answered under its own
/// command id, so the panel's buttons are free again afterwards.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/panels/canvas.dart';
import 'package:frockbot_native/view/action.dart';

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
}
