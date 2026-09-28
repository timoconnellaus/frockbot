/// Review stills for Billing, kept outside the repository:
/// `--dart-define=CHAT_SHOTS=<dir>`. Without a directory every scene is
/// skipped: they draw, they do not assert.
library;

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_client/settings/billing.dart';
import 'package:frockbot_client/theme/frock_theme.dart';

import 'billing_test.dart' show billing, subscribed;
import 'settings_test.dart' show SettingsApi;
import 'widget_test.dart' show MemoryStore;

const _out = String.fromEnvironment('CHAT_SHOTS');
final _boundary = GlobalKey();
final _now = DateTime(2026, 9, 25, 12);
final _renews = DateTime.now().millisecondsSinceEpoch + 16 * 86400000;

const _bots = [
  ('bot-bob', 'Bob', 9840000, 94),
  ('bot-scout', 'Scout', 4100000, 61),
  ('bot-juniper', 'Juniper', 2950000, 38),
  ('bot-ledger', 'Ledger', 1210000, 19),
];

Map<String, Object?> _spending(
  Uri uri, {
  bool quiet = false,
  int runsOutIn = 40,
}) {
  final scale = quiet ? 0.27 : 1.0;
  final days = [
    for (var i = 29; i >= 0; i--)
      () {
        final day = _now.subtract(Duration(days: i));
        final wave = (1 + ((i * 7) % 11)) / 11;
        final stack = [
          for (final bot in _bots) (bot.$3 / 30 * wave * 1.4 * scale).round(),
        ];
        return {
          'day':
              '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}',
          'chargeMicros': stack.fold<int>(0, (a, b) => a + b),
          'stack': stack,
        };
      }(),
  ];
  return {
    'groupBy': uri.queryParameters['groupBy'],
    'filters': <Object>[],
    'totalMicros': (18100000 * scale).round(),
    'previousTotalMicros': (15900000 * scale).round(),
    'operations': 640,
    'turns': (212 * scale).round(),
    'days': days,
    'groups': [
      for (final (id, name, micros, turns) in _bots)
        {
          'key': id,
          'label': name,
          'chargeMicros': (micros * scale).round(),
          'operations': turns * 3,
          'turns': (turns * scale).round(),
          'limitScope': 'bot|$id',
          if (id == 'bot-bob')
            'limit': {
              'dailyMicros': 1000000,
              'todayMicros': 400000,
              'reached': false,
            },
          if (id == 'bot-scout')
            'limit': {
              'dailyMicros': 500000,
              'todayMicros': 510000,
              'reached': true,
            },
        },
    ],
    'topCause': {
      'key': 'routine|bot-bob|briefing',
      'label': 'Morning briefing',
      'detail': 'Bob',
      'chargeMicros': 6200000,
      'operations': 90,
      'turns': 30,
    },
    'credit': {
      'availableMicros': 31380000,
      'dailyMicros': 620000,
      'runsOutAt': DateTime.now().millisecondsSinceEpoch + runsOutIn * 86400000,
      'renewsAt': _renews,
    },
    'topTurns': [
      {
        'runId': 'a',
        'botId': 'bot-bob',
        'bot': 'Bob',
        'cause': 'Morning briefing',
        'at': DateTime(2026, 9, 24, 7).millisecondsSinceEpoch,
        'chargeMicros': 840000,
      },
      {
        'runId': 'b',
        'botId': 'bot-juniper',
        'bot': 'Juniper',
        'cause': 'You, in chat',
        'at': DateTime(2026, 9, 23, 21, 14).millisecondsSinceEpoch,
        'chargeMicros': 610000,
      },
      {
        'runId': 'c',
        'botId': 'bot-scout',
        'bot': 'Scout',
        'cause': 'Inbox triage',
        'at': DateTime(2026, 9, 22, 9).millisecondsSinceEpoch,
        'chargeMicros': 550000,
      },
    ],
  };
}

const _rates = {
  '@frock/auto': {
    'inputUsdPerMillion': 0.6,
    'cachedInputUsdPerMillion': 0.15,
    'outputUsdPerMillion': 2.4,
  },
  '@frock/coding': {
    'inputUsdPerMillion': 3,
    'cachedInputUsdPerMillion': 0.3,
    'outputUsdPerMillion': 15,
  },
  '@frock/structured': {
    'inputUsdPerMillion': 0.1,
    'cachedInputUsdPerMillion': 0.025,
    'outputUsdPerMillion': 0.4,
  },
};

Map<String, Object?> _on(
  Map<String, Object?> overrides, {
  String plan = 'standard',
}) => subscribed({'modelRates': _rates, ...overrides}, plan: plan);

final _healthy = _on({
  'includedMicros': 12400000,
  'purchasedMicros': 12400000,
  'reservedMicros': 900000,
});

final _runningOut = _on({'includedMicros': 4100000});

final _reserve = _on({'includedMicros': 0, 'purchasedMicros': 8400000});

final _paused = _on({});

final _trialEnds =
    DateTime.now().millisecondsSinceEpoch + 5 * 86400000 - 3600000;

final _trial = billing({
  'complimentaryMicros': 1900000,
  'subscription': {
    'status': 'trialing',
    'planId': 'standard',
    'periodEnd': _trialEnds,
    'trialEnd': _trialEnds,
    'cancelAtPeriodEnd': false,
  },
  'trial': {'endsAt': _trialEnds, 'creditMicros': 3000000},
});

final _outOfCredit = billing({
  'canSpend': false,
  'payments': [
    {'id': 'complimentary:welcome', 'kind': 'complimentary'},
  ],
});

Future<void> _scene(
  WidgetTester tester,
  String name,
  Map<String, Object?> account, {
  required Size size,
  bool quiet = false,
  bool prices = false,
  bool dollars = false,
  int runsOutIn = 40,
}) async {
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  final store = MemoryStore();
  if (dollars) store.values['spending.dollars'] = 'true';
  final api = SettingsApi(store, (path, _) async {
    if (path.startsWith('/api/billing/spending')) {
      return _spending(Uri.parse(path), quiet: quiet, runsOutIn: runsOutIn);
    }
    return account;
  });
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: FrockTheme.theme(Brightness.dark),
      // Around the navigator, so a page pushed from Billing is drawn too.
      builder: (_, child) => RepaintBoundary(key: _boundary, child: child),
      home: BillingPage(api: api),
    ),
  );
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 300)),
  );
  await tester.pumpAndSettle();
  if (prices) {
    await tester.dragUntilVisible(
      find.text('Prices'),
      find.byType(SingleChildScrollView),
      const Offset(0, -400),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Prices'));
    await tester.pumpAndSettle();
  }
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 500)),
  );
  await tester.pumpAndSettle();
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await File('$_out/billing-$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
  await tester.pumpWidget(const SizedBox());
  api.close();
}

void main() {
  testWidgets('Billing, on a desk and on a phone', (tester) async {
    if (_out.isEmpty) return;
    await tester.runAsync(() async {
      final inter = FontLoader(interFontFamily);
      for (final weight in [400, 500, 600, 700]) {
        inter.addFont(
          rootBundle.load(
            'packages/frockbot_client/assets/fonts/inter-latin-$weight.ttf',
          ),
        );
      }
      await inter.load();
      await (FontLoader(
        'MaterialIcons',
      )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    });
    addTearDown(tester.view.reset);
    await _scene(
      tester,
      'desktop-healthy',
      _healthy,
      size: const Size(1000, 2500),
    );
    await _scene(
      tester,
      'phone-healthy',
      _healthy,
      size: const Size(390, 3300),
    );
    await _scene(
      tester,
      'phone-healthy-dollars',
      _healthy,
      size: const Size(390, 3300),
      dollars: true,
    );
    await _scene(
      tester,
      'phone-running-out',
      _runningOut,
      size: const Size(390, 1100),
      runsOutIn: 6,
    );
    await _scene(
      tester,
      'desktop-running-out',
      _runningOut,
      size: const Size(1000, 1100),
      runsOutIn: 6,
    );
    await _scene(tester, 'phone-reserve', _reserve, size: const Size(390, 900));
    await _scene(tester, 'phone-paused', _paused, size: const Size(390, 900));
    await _scene(tester, 'phone-trial', _trial, size: const Size(390, 1100));
    await _scene(
      tester,
      'desktop-choose-plan',
      _outOfCredit,
      size: const Size(1000, 900),
      quiet: true,
    );
    await _scene(
      tester,
      'phone-choose-plan',
      _outOfCredit,
      size: const Size(390, 1200),
      quiet: true,
    );
    await _scene(
      tester,
      'desktop-plus',
      _on({'includedMicros': 41000000}, plan: 'plus'),
      size: const Size(1000, 1100),
    );
  });
}
