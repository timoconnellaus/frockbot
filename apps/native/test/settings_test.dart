import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/client/transport.dart';
import 'package:frockbot_native/settings/controller.dart';
import 'package:frockbot_native/settings/page.dart';
import 'package:frockbot_native/settings/model_picker.dart';
import 'package:frockbot_native/protocol/client_wire.generated.dart' as wire;
import 'package:frockbot_native/theme/frock_theme.dart';

import 'widget_test.dart' show MemoryStore;

Map<String, Object?> profile({int revision = 1}) => {
  'schemaVersion': 1,
  'home': 'application',
  'ownerId': 'tim',
  'revision': revision,
  'title': 'Settings',
  'sections': [
    {
      'id': 'profile',
      'label': 'Your profile',
      'fields': [
        {
          'id': 'name',
          'label': 'Name',
          'kind': 'text',
          'value': 'Tim',
          'editable': true,
          'required': true,
          'maxLength': 100,
        },
      ],
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
  test(
    'uncertain save persists before dispatch and reconstructs the same command',
    () async {
      final store = MemoryStore();
      final commands = <Map<String, Object?>>[];
      var revision = 1;
      final api = SettingsApi(store, (path, body) async {
        if (body == null) return profile(revision: revision);
        final command = Map<String, Object?>.from(body as Map);
        expect(
          jsonDecode(store.values['settings-pending.tim.application']!),
          command,
        );
        commands.add(command);
        revision = 2;
        if (commands.length == 1) throw const RequestFailure('Network lost');
        return {
          'schemaVersion': 1,
          'commandId': command['commandId'],
          'revision': 2,
          'status': 'applied',
        };
      });
      final first = SettingsController(api, store, 'tim', 'application');
      await first.load();
      await first.save('profile', {'name': 'Timothy'});
      expect(first.pending, isNotNull);
      first.dispose();
      final restored = SettingsController(api, store, 'tim', 'application');
      await restored.load();
      await restored.save('profile', {'name': 'Different'});
      expect(commands, hasLength(1));
      await restored.checkSave();
      expect(commands, [commands.first, commands.first]);
      expect(restored.pending, isNull);
      expect(restored.frame!.revision, 2);
      restored.dispose();
    },
  );
  test(
    'protected storage failure prevents dispatch; wrong receipt stays pending',
    () async {
      final store = MemoryStore()..fail = true;
      var dispatches = 0;
      final api = SettingsApi(store, (_, body) async {
        if (body == null) return profile();
        dispatches++;
        return {
          'schemaVersion': 1,
          'commandId': 'wrong',
          'revision': 2,
          'status': 'applied',
        };
      });
      final state = SettingsController(api, store, 'tim', 'application');
      await state.load();
      await state.save('profile', {'name': 'Timothy'});
      expect(dispatches, 0);
      expect(state.pending, isNotNull);
      store.fail = false;
      await state.checkSave();
      expect(dispatches, 1);
      expect(state.pending, isNotNull);
      state.dispose();
    },
  );
  test(
    'wrong frame owner and mismatched catalog revisions fail visibly',
    () async {
      final store = MemoryStore();
      final bad = SettingsController(
        SettingsApi(store, (_, _) async => {...profile(), 'ownerId': 'other'}),
        store,
        'tim',
        'application',
      );
      await bad.load();
      expect(bad.frame, isNull);
      expect(bad.message, contains('Couldn’t load'));
      bad.dispose();
      final state = SettingsController(
        SettingsApi(
          store,
          (_, body) async => body == null
              ? profile()
              : {
                  'schemaVersion': 1,
                  'source': 'account-models',
                  'ownerId': 'tim',
                  'revision': 99,
                  'items': [],
                },
        ),
        store,
        'tim',
        'application',
      );
      await state.load();
      await expectLater(state.options('', null), throwsFormatException);
      state.dispose();
    },
  );
  for (final brightness in Brightness.values) {
    testWidgets(
      'Settings profile has one scoped Save at 200% text ($brightness)',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final store = MemoryStore();
        final api = SettingsApi(store, (_, _) async => profile());
        await tester.pumpWidget(
          MaterialApp(
            theme: FrockTheme.theme(brightness),
            home: MediaQuery(
              data: const MediaQueryData(textScaler: TextScaler.linear(2)),
              child: SettingsPage(api: api, store: store, userId: 'tim'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Save profile'), findsOneWidget);
        expect(find.text('Models'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }
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
