import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/settings/controller.dart';
import 'package:frockbot_native/settings/document.dart';
import 'package:frockbot_native/settings/model_picker.dart';
import 'package:frockbot_native/settings/page.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/frock_theme.dart';

import 'widget_test.dart' show MemoryStore;

/// The shape `settingsDocumentV1` produces for the profile section, written by
/// hand so the Flutter side is pinned to the projection's contract rather than
/// to whatever the server happens to emit today.
Map<String, Object?> document({int revision = 1, Object? model}) => {
  'schemaVersion': 1,
  'surfaceId': 'settings-application',
  'revision': revision,
  'root': {
    'type': 'group',
    'orientation': 'column',
    'children': [
      {
        'type': 'group',
        'orientation': 'column',
        'title': 'Your profile',
        'children': [
          {
            'type': 'field',
            'field': {
              'id': 'f0.name',
              'label': 'Name',
              'kind': 'text',
              'value': 'Tim',
              'editable': true,
              'required': true,
              'maxLength': 100,
            },
          },
          {
            'type': 'field',
            'field': {
              'id': 'j0.account-model',
              'label': 'Model',
              'kind': 'select',
              'value': model == null ? 'null' : '"$model"',
              'editable': true,
              'choiceSource': 'account-models',
              'choices': [
                {'label': 'Frock AI · Auto', 'value': 'null'},
              ],
            },
          },
          {
            'type': 'action',
            'actionId': 'save-0',
            'label': 'Save profile',
            'style': 'primary',
            'input': {'sectionId': 'profile'},
          },
        ],
      },
    ],
  },
  'actions': [
    {
      'id': 'save-0',
      'schema': {
        'type': 'object',
        'properties': {
          'sectionId': {'type': 'string', 'maxLength': 256},
          'f0.name': {'type': 'string', 'maxLength': 100},
          'j0.account-model': {'type': 'string', 'maxLength': 8000},
        },
        'required': ['sectionId', 'f0.name'],
        'additionalProperties': false,
      },
    },
  ],
};

class SettingsApi extends NativeApi {
  final Future<Object?> Function(String, Object?) handler;
  SettingsApi(super.store, this.handler);
  @override
  Future<Object?> request(
    String path, {
    Object? body,
    int limit = 512000,
    bool authenticated = true,
  }) => handler(path, body);
}

void main() {
  group('the projection read back', () {
    test('a save names its section and strips the projected field ids', () {
      expect(
        settingsChangeCommandV1(
          userId: 'tim',
          command: {
            'commandId': 'c1',
            'surfaceId': 'settings-application',
            'revision': 4,
            'actionId': 'save-0',
            'input': {
              'sectionId': 'profile',
              'f0.name': 'Timothy',
              'j0.account-model': '{"connectionId":"work"}',
            },
          },
        ),
        {
          'schemaVersion': 1,
          'commandId': 'c1',
          'expectedRevision': 4,
          'ownerId': 'tim',
          'sectionId': 'profile',
          'values': {
            'name': 'Timothy',
            'account-model': {'connectionId': 'work'},
          },
        },
      );
    });

    test('a reset action unsets one setting and carries no values', () {
      expect(
        settingsChangeCommandV1(
          userId: 'tim',
          command: {
            'commandId': 'c2',
            'revision': 4,
            'actionId': 'unset-1-0',
            'input': {'sectionId': 'package.notes', 'fieldId': 'region'},
          },
        ),
        containsPair('unset', ['region']),
      );
    });

    test('a section action carries its kind and nothing else', () {
      const command = {
        'commandId': 'c3',
        'revision': 4,
        'actionId': 'section-2-0',
        'input': {'sectionId': 'provider.ollama', 'kind': 'choose-provider'},
      };
      expect(viewActionKindV1(command), 'choose-provider');
      expect(
        settingsChangeCommandV1(userId: 'tim', command: command),
        containsPair('values', <String, Object?>{}),
      );
    });

    test('an action naming no section is refused before dispatch', () {
      expect(
        () => settingsChangeCommandV1(
          userId: 'tim',
          command: const {
            'commandId': 'c4',
            'revision': 1,
            'actionId': 'save-0',
            'input': <String, Object?>{},
          },
        ),
        throwsFormatException,
      );
    });
  });

  test('a document for another surface fails visibly', () async {
    final store = MemoryStore();
    final state = SettingsController(
      SettingsApi(store, (_, _) async => {...document(), 'surfaceId': 'other'}),
      'tim',
      'application',
    );
    await state.load();
    expect(state.document, isNull);
    expect(state.message, contains('Couldn’t load'));
    state.dispose();
  });

  test('a model catalog page from another revision is refused', () async {
    final store = MemoryStore();
    final state = SettingsController(
      SettingsApi(
        store,
        (_, body) async => body == null
            ? document()
            : {
                'schemaVersion': 1,
                'source': 'account-models',
                'ownerId': 'tim',
                'revision': 99,
                'items': <Object?>[],
              },
      ),
      'tim',
      'application',
    );
    await state.load();
    await expectLater(state.options('', null), throwsFormatException);
    state.dispose();
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'Settings renders the projected document and saves through it ($brightness)',
      (tester) async {
        tester.view.physicalSize = const Size(390, 1400);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final store = MemoryStore();
        final commands = <Map<String, Object?>>[];
        var revision = 1;
        final api = SettingsApi(store, (path, body) async {
          if (body == null) return document(revision: revision);
          final command = Map<String, Object?>.from(body as Map);
          commands.add(command);
          revision = 2;
          return {
            'schemaVersion': 1,
            'commandId': command['commandId'],
            'revision': 2,
            'status': 'applied',
          };
        });
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: SettingsPage(api: api, store: store, userId: 'tim'),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Your profile'), findsOneWidget);
        expect(find.text('Models'), findsOneWidget);
        await tester.enterText(find.byType(TextFormField).first, 'Timothy');
        await tester.tap(find.text('Save profile'));
        await tester.pumpAndSettle();
        expect(commands, hasLength(1));
        expect(commands.first['sectionId'], 'profile');
        expect(commands.first['values'], {
          'name': 'Timothy',
          'account-model': null,
        });
        expect(commands.first['expectedRevision'], 1);
        expect(find.text('Saved.'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('the model field is the host picker, and its choice travels', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final store = MemoryStore();
    final commands = <Map<String, Object?>>[];
    final api = SettingsApi(store, (path, body) async {
      if (path.contains('options')) {
        return {
          'schemaVersion': 1,
          'source': 'account-models',
          'ownerId': 'tim',
          'revision': 1,
          'items': [
            {
              'label': 'Llama 3 · Work',
              'value': {'connectionId': 'work', 'providerModelId': 'llama3'},
            },
          ],
        };
      }
      if (body == null) return document();
      final command = Map<String, Object?>.from(body as Map);
      commands.add(command);
      return {
        'schemaVersion': 1,
        'commandId': command['commandId'],
        'revision': 2,
        'status': 'applied',
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: SettingsPage(api: api, store: store, userId: 'tim'),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Frock AI · Auto'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Llama 3 · Work'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save profile'));
    await tester.pumpAndSettle();
    expect(commands.single['values'], {
      'name': 'Tim',
      'account-model': {'connectionId': 'work', 'providerModelId': 'llama3'},
    });
  });

  testWidgets(
    'model search fences a slow previous query and selecting Auto is not cancel',
    (tester) async {
      final calls = <Completer<wire.SettingsOptionsPage>>[];
      wire.SettingsOptionsPage page(String label, Object? value) =>
          wire.SettingsOptionsPage.fromJson({
            'schemaVersion': 1,
            'source': 'account-models',
            'ownerId': 'tim',
            'revision': 1,
            'items': [
              {'label': label, 'value': value},
            ],
          });
      wire.SettingChoice? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                selected = await Navigator.of(context).push<wire.SettingChoice>(
                  MaterialPageRoute(
                    builder: (_) => ModelPicker(
                      selected: 'old',
                      load: (_, _) {
                        final c = Completer<wire.SettingsOptionsPage>();
                        calls.add(c);
                        return c.future;
                      },
                    ),
                  ),
                );
              },
              child: const Text('Open models'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open models'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'auto');
      await tester.pump(const Duration(milliseconds: 301));
      calls[1].complete(page('Frock AI · Auto', null));
      await tester.pumpAndSettle();
      calls[0].complete(page('Stale model', 'old'));
      await tester.pumpAndSettle();
      expect(find.text('Stale model'), findsNothing);
      await tester.tap(find.text('Frock AI · Auto'));
      await tester.pumpAndSettle();
      expect(selected, isNotNull);
      expect(selected!.value.value, isNull);
    },
  );
}
