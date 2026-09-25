/// Review stills of Activity at phone and desktop widths, kept outside the
/// repository: `--dart-define=ACTIVITY_SHOTS=<dir>`. Without a directory the
/// scenes are skipped: they draw, they do not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/audit/page.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

import 'native_session.dart';
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('ACTIVITY_SHOTS');
final _boundary = GlobalKey();
final _now = DateTime(2026, 9, 25, 11, 30);

Map<String, Object?> _bot(
  String id,
  String name,
  String character,
  String primary,
) => {
  'schemaVersion': 1,
  'botId': id,
  'registeredAt': '2026-09-01T00:00:00.000Z',
  'initialName': name,
  'avatar': {'schemaVersion': 1, 'characterId': character, 'primary': primary},
};

Map<String, Object?> _row(
  String botId,
  String name,
  DateTime at,
  String text,
  String place, {
  bool approved = false,
  bool quiet = false,
  String? note,
  bool opens = true,
}) => {
  'botId': botId,
  'botName': name,
  'at': at.toUtc().toIso8601String(),
  'text': text,
  'place': place,
  if (approved) 'approved': true,
  if (quiet) 'quiet': true,
  'note': ?note,
  if (opens) 'runId': 'run-${at.millisecondsSinceEpoch}',
};

final _page = {
  'schemaVersion': 1,
  'rows': [
    _row(
      'scout',
      'Scout',
      DateTime(2026, 9, 25, 10, 42),
      'sent an email',
      'Email',
      approved: true,
    ),
    _row(
      'bob',
      'Bob',
      DateTime(2026, 9, 25, 9, 15),
      'called Notion: create page',
      'Notion',
    ),
    _row(
      'bob',
      'Bob',
      DateTime(2026, 9, 25, 7, 2),
      'ran 6 commands on its Computer',
      'Computer',
      note: '1 failed',
    ),
    _row(
      'juniper',
      'Juniper',
      DateTime(2026, 9, 25, 6, 50),
      'used the microphone for 2 min, through Tuner',
      'Android',
      opens: false,
    ),
    _row(
      'bob',
      'Bob',
      DateTime(2026, 9, 24, 17, 40),
      'ran “git pull” on your computer',
      'Your computer',
      note: 'Outcome unknown',
    ),
    _row(
      'ledger',
      'Ledger',
      DateTime(2026, 9, 24, 16, 4),
      'updated its memory 3 times',
      'Memory',
    ),
    _row(
      'scout',
      'Scout',
      DateTime(2026, 9, 24, 9),
      'made 12 calls to Gmail',
      'Gmail',
      quiet: true,
    ),
    _row(
      'ledger',
      'Ledger',
      DateTime(2026, 9, 22, 14, 12),
      'took 4 steps in the web browser on its Computer',
      'Computer',
    ),
  ],
  'nextCursor': 'c2',
  'indexState': 'ready',
};

Future<void> _shoot(
  WidgetTester tester, {
  required Size size,
  required double ratio,
  required String name,
}) async {
  await tester.runAsync(() async {
    final inter = FontLoader('Inter');
    for (final weight in [400, 500, 600, 700]) {
      inter.addFont(rootBundle.load('assets/fonts/inter-latin-$weight.ttf'));
    }
    await inter.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  tester.view.physicalSize = size * ratio;
  tester.view.devicePixelRatio = ratio;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final store = MemoryStore();
  final api = NativeSessionApi(store, (path, _) async {
    if (path == '/api/bots') {
      return {
        'schemaVersion': 1,
        'revision': 0,
        'bots': [
          _bot('bob', 'Bob', 'pixel', '#fc85ae'),
          _bot('scout', 'Scout', 'guardian', '#7fd8c4'),
          _bot('juniper', 'Juniper', 'sunny', '#ffc928'),
          _bot('ledger', 'Ledger', 'chill', '#9db4ff'),
        ],
      };
    }
    return _page;
  });
  addTearDown(api.close);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.dark),
      home: RepaintBoundary(
        key: _boundary,
        child: AuditPage(
          api: api,
          store: store,
          userId: 'tim',
          now: () => _now,
        ),
      ),
    ),
  );
  // The avatars' artwork decodes off the test clock, in two rounds: the
  // directory, then each character.
  for (var round = 0; round < 3; round++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 400)),
    );
    await tester.pump(const Duration(milliseconds: 300));
  }
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: ratio);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_out/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  testWidgets('Activity on a phone', (tester) async {
    if (_out.isEmpty) return;
    await _shoot(
      tester,
      size: const Size(390, 1180),
      ratio: 3,
      name: 'activity-phone',
    );
  });

  testWidgets('Activity on a desktop', (tester) async {
    if (_out.isEmpty) return;
    await _shoot(
      tester,
      size: const Size(1280, 1000),
      ratio: 2,
      name: 'activity-desktop',
    );
  });
}
