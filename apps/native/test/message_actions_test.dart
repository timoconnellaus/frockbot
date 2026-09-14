import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/shell/message_actions.dart';
import 'package:frockbot_native/shell/transcript.dart';
import 'package:frockbot_native/theme/frock_theme.dart';

void main() {
  Widget conversation(void Function(String?) selected, {bool busy = false}) =>
      MaterialApp(
        theme: FrockTheme.theme(Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TranscriptView(
              lines: const [
                TranscriptLine(
                  id: 'run:user',
                  runId: 'run',
                  role: LineRole.user,
                  text: 'Review this message',
                  status: LineStatus.completed,
                ),
              ],
              loading: false,
              hasEarlier: false,
              storageKey: 'context-actions',
              onOpenRun: (_) {},
              onRefresh: ({bool older = false}) async {},
              onMessageActions: (line, {position}) async {
                selected(
                  await showMessageActions(
                    context: context,
                    position: position,
                    canCopy: true,
                    canMarkUnread: true,
                    hasUnread: true,
                    readActionsEnabled: !busy,
                  ),
                );
              },
            ),
          ),
        ),
      );

  testWidgets('secondary click opens an anchored menu and invokes an action', (
    tester,
  ) async {
    String? selected;
    await tester.pumpWidget(conversation((value) => selected = value));
    await tester.pumpAndSettle();
    final target = find.text('Review this message');
    final point = tester.getCenter(target);
    await tester.tap(target, buttons: kSecondaryMouseButton);
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.byType(PopupMenuItem<String>), findsNWidgets(4));
    expect(
      (tester.getTopLeft(find.text('Copy')).dx - point.dx).abs(),
      lessThan(260),
    );
    await tester.tap(find.text('Copy'));
    await tester.pumpAndSettle();
    expect(selected, 'copy');
  });

  testWidgets('long press retains the phone sheet and disabled read actions', (
    tester,
  ) async {
    String? selected;
    await tester.pumpWidget(
      conversation((value) => selected = value, busy: true),
    );
    await tester.pumpAndSettle();
    await tester.longPress(find.text('Review this message'));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(
      tester
          .widget<ListTile>(
            find.widgetWithText(ListTile, 'Mark unread from here'),
          )
          .enabled,
      isFalse,
    );
    await tester.tap(find.text('Work details'));
    await tester.pumpAndSettle();
    expect(selected, 'work');
  });
}
