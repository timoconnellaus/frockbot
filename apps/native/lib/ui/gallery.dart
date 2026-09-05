import 'package:flutter/material.dart';

import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// The Frock UI gallery: reference screens rendered by Flutter so they can be
/// set beside the HTML system page. Launch with
/// `flutter run --dart-define=FROCK_GALLERY=true`; the render test writes it
/// headlessly into docs/design/evidence/.
class FrockGallery extends StatelessWidget {
  const FrockGallery({super.key});
  @override
  Widget build(BuildContext context) => const FrockChatScreen();
}

/// Chat with a Bot: the primary screen. Same content as screen 04 on
/// docs/design/frock-ui.html. The Bot's reply is prose with its work shown
/// inline as receipts, then the choice as pills.
///
/// Safe areas: the status bar, notch and display cutouts are kept clear by
/// `SafeArea` at the top and sides; the composer keeps the bottom inset (home
/// indicator, gesture bar) clear. The keyboard inset is handled by `Scaffold`.
class FrockChatScreen extends StatelessWidget {
  const FrockChatScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Scaffold(
      backgroundColor: t.window,
      body: SafeArea(
        bottom: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            FrockTokens.edge,
            0,
            FrockTokens.edge,
            bottom + 8,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FrockBar(
                leading: const FrockIconButton(
                  Icons.menu_rounded,
                  semanticLabel: 'Your Bots',
                ),
                title: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const FrockSheep(size: 24, state: BotState.working),
                    const SizedBox(width: 8),
                    Text('Bob', style: t.barTitle),
                  ],
                ),
                trailing: const FrockIconButton(
                  Icons.grid_view_outlined,
                  semanticLabel: 'Applets',
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.only(top: 8),
                  children: [
                    Center(
                      child: Text(
                        'Today 13:36',
                        style: t.monoStyle.copyWith(fontSize: 11),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const FrockUserMessage(
                      'Find Sarah\'s email about Thursday\'s numbers and draft a reply with the totals from the sheet.',
                    ),
                    const SizedBox(height: 12),
                    FrockBotMessage(
                      children: [
                        const Text(
                          'Found it. She is asking for Q3 by region. Here is what I did:',
                        ),
                        const SizedBox(height: 6),
                        const FrockReceipt(
                          icon: Icons.mail_outline_rounded,
                          text: 'Searched Gmail',
                          detail: '“Thursday numbers”',
                          time: '3 hits',
                        ),
                        const FrockReceipt(
                          icon: Icons.table_chart_outlined,
                          text: 'Read',
                          detail: 'Q3 regions.xlsx',
                          time: '4 sheets',
                        ),
                        const FrockReceipt(
                          icon: Icons.check_rounded,
                          tone: TileTone.good,
                          text: 'Drafted reply',
                          detail: '214 words',
                          time: 'ready',
                        ),
                        const SizedBox(height: 10),
                        Text.rich(
                          TextSpan(
                            children: [
                              const TextSpan(
                                text: 'APAC is up 18%, EMEA flat, Americas down 4%. The draft leads with APAC and flags the Americas dip as timing. Want me to send it',
                              ),
                              WidgetSpan(
                                alignment: PlaceholderAlignment.middle,
                                child: Padding(
                                  padding: const EdgeInsets.only(left: 2),
                                  child: Container(
                                    width: 7,
                                    height: 15,
                                    decoration: BoxDecoration(
                                      color: t.accent.withValues(alpha: 0.85),
                                      borderRadius: BorderRadius.circular(2),
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                          style: t.message,
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    const Row(
                      children: [
                        FrockPill(
                          'Send it',
                          kind: PillKind.primary,
                          size: PillSize.sm,
                        ),
                        SizedBox(width: 8),
                        FrockPill('Show draft', size: PillSize.sm),
                        SizedBox(width: 8),
                        FrockPill(
                          'Edit',
                          kind: PillKind.ghost,
                          size: PillSize.sm,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              const FrockComposer(
                hint: 'Message Bob',
                onVoice: _noop,
                onSend: _noop,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

void _noop() {}
