import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/hot_panel.dart';

class _Leaf extends StatefulWidget {
  final String name;
  const _Leaf(this.name);

  @override
  State<_Leaf> createState() => _LeafState();
}

class _LeafState extends State<_Leaf> {
  static final Map<String, int> mounts = {};
  static final Map<String, int> disposals = {};

  @override
  void initState() {
    super.initState();
    mounts[widget.name] = (mounts[widget.name] ?? 0) + 1;
  }

  @override
  void dispose() {
    disposals[widget.name] = (disposals[widget.name] ?? 0) + 1;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      Text('${widget.name} visible=${PanelVisibility.of(context)}');
}

void main() {
  setUp(() {
    _LeafState.mounts.clear();
    _LeafState.disposals.clear();
  });

  testWidgets('a visited hot door stays mounted when another is shown', (
    tester,
  ) async {
    var shown = 'routines';
    final kept = <String>['bot-page', 'routines'];

    Widget stack() => MaterialApp(
      home: HotPanelStack(
        shown: shown,
        kept: kept,
        builder: (key) => _Leaf(key),
      ),
    );

    await tester.pumpWidget(stack());
    expect(find.text('routines visible=true'), findsOneWidget);
    expect(
      find.text('bot-page visible=false', skipOffstage: false),
      findsOneWidget,
    );
    expect(_LeafState.mounts['routines'], 1);
    expect(_LeafState.mounts['bot-page'], 1);

    shown = 'bot-page';
    await tester.pumpWidget(stack());
    expect(find.text('bot-page visible=true'), findsOneWidget);
    expect(
      find.text('routines visible=false', skipOffstage: false),
      findsOneWidget,
    );
    expect(_LeafState.mounts['routines'], 1);
    expect(_LeafState.disposals['routines'], isNull);
    expect(_LeafState.mounts['bot-page'], 1);
  });

  testWidgets('a door that is not kept remounts when it returns', (
    tester,
  ) async {
    var shown = 'voice';
    await tester.pumpWidget(
      MaterialApp(
        home: HotPanelStack(
          shown: shown,
          kept: const [],
          builder: (key) => _Leaf(key),
        ),
      ),
    );
    expect(_LeafState.mounts['voice'], 1);

    shown = 'bot-page';
    await tester.pumpWidget(
      MaterialApp(
        home: HotPanelStack(
          shown: shown,
          kept: const ['bot-page'],
          builder: (key) => _Leaf(key),
        ),
      ),
    );
    expect(_LeafState.disposals['voice'], 1);

    shown = 'voice';
    await tester.pumpWidget(
      MaterialApp(
        home: HotPanelStack(
          shown: shown,
          kept: const ['bot-page'],
          builder: (key) => _Leaf(key),
        ),
      ),
    );
    expect(_LeafState.mounts['voice'], 2);
  });

  testWidgets('a hidden kept door cannot take keyboard focus', (tester) async {
    var shown = 'routines';
    final routines = FocusNode();
    final plugins = FocusNode();
    addTearDown(routines.dispose);
    addTearDown(plugins.dispose);

    Widget stack() => MaterialApp(
      home: Scaffold(
        body: HotPanelStack(
          shown: shown,
          kept: const ['routines', 'plugins'],
          builder: (key) =>
              TextField(focusNode: key == 'routines' ? routines : plugins),
        ),
      ),
    );

    await tester.pumpWidget(stack());
    routines.requestFocus();
    await tester.pump();
    expect(routines.hasFocus, isTrue);

    shown = 'plugins';
    await tester.pumpWidget(stack());
    await tester.pump();
    expect(routines.hasFocus, isFalse);
    plugins.requestFocus();
    await tester.pump();
    expect(plugins.hasFocus, isTrue);
    expect(routines.hasFocus, isFalse);
  });
}
