import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/plugins/document.dart';
import 'package:frockbot_native/plugins/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

/// The shape `pluginsDocumentV1` produces for one row, written by hand so the
/// Flutter side is pinned to the projection's contract.
Map<String, Object?> pluginsDocument({
  int revision = 1,
  String state = 'installed',
}) => {
  'schemaVersion': 1,
  'surfaceId': 'plugins',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {'type': 'text', 'text': '1 installed', 'style': 'status'},
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Ollama Cloud',
        'children': [
          {'type': 'text', 'text': 'Models', 'style': 'label'},
          {
            'type': 'text',
            'text': state == 'installed' ? 'On' : 'Off',
            'style': 'status',
          },
          {
            'type': 'group',
            'orientation': 'row',
            'children': [
              {
                'type': 'action',
                'actionId': 'set-package-enabled',
                'label': state == 'installed' ? 'Turn off' : 'Turn on',
                'input': {
                  'kind': 'set-package-enabled',
                  'packageId': 'provider-ollama-cloud',
                  'enabled': state != 'installed',
                },
              },
            ],
          },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'set-package-enabled',
      'schema': {
        'type': 'object',
        'properties': {
          'kind': {
            'type': 'string',
            'enum': ['set-package-enabled'],
          },
          'packageId': {'type': 'string', 'maxLength': 128},
          'enabled': {'type': 'boolean'},
        },
        'required': ['kind', 'packageId', 'enabled'],
        'additionalProperties': false,
      },
    },
  ],
};

void main() {
  group('the projection read back', () {
    test('enablement becomes the User command the settings route takes', () {
      expect(
        pluginCommandV1({
          'commandId': 'c1',
          'revision': 5,
          'actionId': 'set-package-enabled',
          'input': {
            'kind': 'set-package-enabled',
            'packageId': 'provider-ollama-cloud',
            'enabled': false,
          },
        }),
        {
          'schemaVersion': 1,
          'commandId': 'c1',
          'expectedRevision': 5,
          'packageId': 'provider-ollama-cloud',
          'type': 'user/set-package-enabled',
          'enabled': false,
        },
      );
    });

    test('an install carries the version the catalog named', () {
      expect(
        pluginCommandV1({
          'commandId': 'c2',
          'revision': 5,
          'actionId': 'install-package',
          'input': {
            'kind': 'install-package',
            'packageId': 'provider-ollama-cloud',
            'version': '1.0.0',
          },
        }),
        containsPair('type', 'user/install-package'),
      );
    });

    test('navigation is a kind, and no command', () {
      final command = {
        'commandId': 'c3',
        'actionId': 'open-home',
        'input': {'kind': 'open-home', 'home': 'connections'},
      };
      expect(pluginActionKindV1(command), 'open-home');
      expect(pluginHomeV1(command), 'connections');
    });
  });

  test('search filters visible purposes while preserving authoritative action targets', () async {
    final controller = PluginsController(
      SettingsApi(MemoryStore(), (_, _) async => pluginsDocument()),
      'tim',
    );
    await controller.load();
    controller.search('no such plugin');
    var root = (controller.document!.toJson() as Map)['root'] as Map;
    expect(
      (root['children'] as List).where(
        (node) => (node as Map)['type'] == 'group',
      ),
      isEmpty,
    );
    controller.search('models');
    root = (controller.document!.toJson() as Map)['root'] as Map;
    expect(
      (root['children'] as List).where(
        (node) => (node as Map)['type'] == 'group',
      ),
      hasLength(1),
    );
    controller.dispose();
  });

  for (final width in [375.0, 900.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'capabilities show readable cards and visible controls at $width / $scale',
        (tester) async {
          tester.view.physicalSize = Size(width, 1000);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final store = MemoryStore();
          final document = pluginsDocument();
          final children = ((document['root'] as Map)['children'] as List);
          children.add(<String, Object>{
            ...(children.last as Map).cast<String, Object>(),
            'title':
                'Another feature with a much longer title that needs more room',
          });
          await tester.pumpWidget(
            MaterialApp(
              theme: FrockTheme.theme(Brightness.dark),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: PluginsPage(
                api: SettingsApi(store, (_, _) async => document),
                store: store,
                userId: 'tim',
                capabilities: true,
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.byType(Card), findsNWidgets(2));
          expect(find.byType(Switch), findsNWidgets(2));
          expect(
            tester.getSize(find.byType(Card).first),
            tester.getSize(find.byType(Card).last),
          );
          expect(find.text('Details & controls'), findsNothing);
          final cards = tester.getTopLeft(find.byType(Card).first);
          final second = tester.getTopLeft(find.byType(Card).last);
          if (width >= 900 && scale == 1) {
            expect(second.dy, cards.dy);
            expect(second.dx, greaterThan(cards.dx));
          } else {
            expect(second.dy, greaterThan(cards.dy));
          }
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  testWidgets('capability switch sends one command and reads back', (
    tester,
  ) async {
    final store = MemoryStore();
    final sent = <Map<String, Object?>>[];
    var state = 'installed';
    var revision = 1;
    final api = SettingsApi(store, (path, body) async {
      if (body == null) {
        return pluginsDocument(revision: revision, state: state);
      }
      sent.add((body as Map).cast<String, Object?>());
      state = 'disabled';
      revision = 2;
      return {
        'schemaVersion': 1,
        'commandId': body['commandId'],
        'revision': revision,
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(
          api: api,
          store: store,
          userId: 'tim',
          capabilities: true,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('1 installed'), findsOneWidget);
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(sent.single['type'], 'user/set-package-enabled');
    expect(sent.single['expectedRevision'], 1);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });

  testWidgets('Plugins recovers from offline without raw backend detail', (
    tester,
  ) async {
    var offline = true;
    final store = MemoryStore();
    final api = SettingsApi(store, (_, _) async {
      if (offline) throw const RequestFailure('synthetic backend detail');
      return pluginsDocument();
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: PluginsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic backend'), findsNothing);
    expect(find.text('Plugins couldn’t load'), findsOneWidget);
    offline = false;
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.text('Ollama Cloud'), findsOneWidget);
  });
}
