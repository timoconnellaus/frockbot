import 'package:flutter/material.dart';

import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// The Frock UI gallery: reference screens rendered by Flutter so they can be
/// set beside the HTML system page. Launch with
/// `flutter run --dart-define=FROCK_GALLERY=true`; the golden test renders it
/// headlessly into docs/design/evidence/.
class FrockGallery extends StatelessWidget {
  const FrockGallery({super.key});
  @override
  Widget build(BuildContext context) => const FrockTodayScreen();
}

/// Screen 01, Today: the briefing. Same content as docs/design/frock-ui.html.
class FrockTodayScreen extends StatelessWidget {
  const FrockTodayScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Scaffold(
      backgroundColor: t.window,
      body: SafeArea(
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            const Positioned(left: -80, top: 40, child: FrockGlow()),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: FrockTokens.edge),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FrockBar(
                    leading: null,
                    title: Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'SATURDAY · 5 SEP',
                        style: t.eyebrow.copyWith(color: t.accentInk),
                      ),
                    ),
                    trailing: Container(
                      width: FrockTokens.controlMd,
                      height: FrockTokens.controlMd,
                      decoration: BoxDecoration(
                        color: t.tile,
                        shape: BoxShape.circle,
                      ),
                      child: const Center(child: FrockSheep(size: 22)),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text('Good afternoon,\nTim.', style: t.displayStyle),
                  const SizedBox(height: 14),
                  const FrockEyebrow('Needs you'),
                  FrockGroup(
                    needsYou: true,
                    children: [
                      FrockRow(
                        leading: const FrockSheep(
                          size: 32,
                          state: BotState.working,
                        ),
                        title: 'Bob wants to send an email',
                        caption: 'To Sarah · “Re: Thursday\'s numbers” · draft ready',
                        trailing: const FrockPill(
                          'Review',
                          kind: PillKind.primary,
                          size: PillSize.sm,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: FrockTokens.groupGap),
                  const FrockEyebrow('While you were away'),
                  FrockGroup(
                    children: [
                      FrockRow(
                        leading: const FrockIconTile(
                          Icons.check_rounded,
                          tone: TileTone.good,
                        ),
                        title: 'Research finished the draft',
                        caption: 'Q3 pricing memo · 1,240 words',
                        trailing: Text('1h', style: t.monoStyle),
                      ),
                      FrockRow(
                        leading: const FrockIconTile(
                          Icons.mail_outline_rounded,
                          tone: TileTone.accent,
                        ),
                        title: 'Inbox digest ran',
                        caption: '14 emails · 2 need a reply',
                        trailing: Text('2h', style: t.monoStyle),
                      ),
                      FrockRow(
                        leading: const FrockIconTile(Icons.grid_view_rounded),
                        title: 'Weekly Todos updated',
                        caption: 'Added Call mum',
                        trailing: Text('4h', style: t.monoStyle),
                      ),
                    ],
                  ),
                  const SizedBox(height: FrockTokens.groupGap),
                  const FrockEyebrow('Running now'),
                  Row(
                    children: [
                      const FrockSheep(size: 28, state: BotState.working),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Bob · running tests', style: t.row),
                            Text(
                              'bun test · 2m 14s',
                              style: t.monoStyle.copyWith(color: t.ink2),
                            ),
                          ],
                        ),
                      ),
                      const FrockPulse(),
                    ],
                  ),
                  const Spacer(),
                  const FrockComposer(
                    hint: 'Ask any Bot',
                    onVoice: _noop,
                    onSend: _noop,
                  ),
                  const SizedBox(height: 6),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 0),
                    child: FrockDock(
                      active: 0,
                      items: const [
                        (Icons.home_outlined, 'Today'),
                        (Icons.groups_outlined, 'Bots'),
                        (Icons.grid_view_outlined, 'Applets'),
                        (Icons.person_outline_rounded, 'You'),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

void _noop() {}
