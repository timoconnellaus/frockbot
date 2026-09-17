// Probe: does a Bot switch paint the character's catalog colour before the
// Bot's own colour lands? Prints the dominant avatar pixels per frame.
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/flock/avatar.dart';
import 'package:integration_test/integration_test.dart';

const _boundary = ValueKey('probe-boundary');
const _sibling = ValueKey('probe-sibling');

class _Probe extends StatefulWidget {
  const _Probe();
  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  String character = 'pixel';
  String primary = '#1d7f4f'; // deliberately far from every catalog colour

  void swap(String c, String p) => setState(() {
    character = c;
    primary = p;
  });

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      backgroundColor: Colors.black,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            RepaintBoundary(
              key: _boundary,
              child: CharacterAvatar(
                key: ValueKey('bot-$primary'),
                size: 160,
                characterId: character,
                primary: primary,
                motion: CharacterMotion.active,
              ),
            ),
            RepaintBoundary(
              key: _sibling,
              child: CharacterAvatar(
                size: 160,
                characterId: 'pixel',
                primary: '#e0a000',
                motion: CharacterMotion.active,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<String> _sample(WidgetTester tester, [Key key = _boundary]) async {
  final object = tester.renderObject(find.byKey(key));
  final image = await (object as RenderRepaintBoundary).toImage();
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final bytes = data!.buffer.asUint8List();
  final counts = <int, int>{};
  for (var i = 0; i < bytes.length; i += 4) {
    if (bytes[i + 3] < 200) continue;
    final rgb = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    counts[rgb] = (counts[rgb] ?? 0) + 1;
  }
  final top = counts.entries.toList()
    ..sort((a, b) => b.value.compareTo(a.value));
  return top
      .take(3)
      .map((e) => '#${e.key.toRadixString(16).padLeft(6, '0')}x${e.value}')
      .join(' ');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('bot switch colour timeline', (tester) async {
    debugForceRiveInTests = true;
    debugUseFlutterRiveFactory = true;
    await tester.pumpWidget(const _Probe());
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    debugPrint(
      'PROBE settled: ${await _sample(tester)} '
      '| sibling ${await _sample(tester, _sibling)}',
    );

    final state = tester.state<_ProbeState>(find.byType(_Probe));

    // Same character, new Bot colour.
    state.swap('pixel', '#7a2ad6');
    for (var i = 0; i < 12; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      debugPrint(
        'PROBE same-character f$i: ${await _sample(tester)} '
        '| sibling ${await _sample(tester, _sibling)}',
      );
    }

    // Different character, new Bot colour.
    state.swap('sunny', '#0d3b8c');
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      debugPrint(
        'PROBE new-character f$i: ${await _sample(tester)} '
        '| sibling ${await _sample(tester, _sibling)}',
      );
    }
  });
}
