import 'package:flutter/material.dart';

import 'frock_page.dart';
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
/// in its own words, then the choice as pills. Tool calls never appear in
/// the thread.
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
                    const FrockSheep(
                      look: SheepLook(
                        background: 'hot-pink',
                        upper: 'upper-neutral',
                        middle: 'rose-heart-sunglasses',
                        lower: 'lower-neutral',
                      ),
                      size: 24,
                      state: BotState.working,
                    ),
                    const SizedBox(width: 8),
                    Text('Bob', style: t.barTitle),
                  ],
                ),
                reserve: FrockTokens.controlMd * 3 + 8,
                trailing: const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    FrockIconButton(
                      Icons.graphic_eq_rounded,
                      semanticLabel: 'Voice',
                    ),
                    FrockIconButton(
                      Icons.grid_view_outlined,
                      semanticLabel: 'Applets',
                    ),
                  ],
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
                          'Found it. She is asking for Q3 by region. I searched Thursday’s thread, read the regions sheet and drafted a reply.',
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
                onDictate: _noop,
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

/// The Inbox: a secondary screen in the page frame. Same content as the
/// system page's "Page frame, lead, notice" component, at phone size.
class FrockInboxScreen extends StatelessWidget {
  const FrockInboxScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: 'Inbox',
      padded: false,
      leading: const FrockIconButton(
        Icons.arrow_back_rounded,
        semanticLabel: 'Back',
      ),
      trailing: const FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh inbox',
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          FrockTokens.edge,
          8,
          FrockTokens.edge,
          FrockTokens.edge,
        ),
        children: [
          const FrockLead(
            'Open a conversation to follow up, or dismiss an update when you’re done.',
          ),
          const FrockEyebrow('Updates'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          FrockGroup(
            children: [
              FrockNotice(
                title: 'Bob finished the Q3 memo',
                body: 'Draft is in your Docs. Two numbers need your eye before it goes to Sarah.',
                stamp: '14:02',
                actions: [
                  const FrockPill(
                    'Open Bot',
                    icon: Icons.chat_bubble_outline_rounded,
                    size: PillSize.sm,
                  ),
                  FrockPill(
                    'Dismiss',
                    kind: PillKind.ghost,
                    size: PillSize.sm,
                    color: t.ink2,
                  ),
                ],
              ),
              FrockNotice(
                title: 'Research couldn’t reach Notion',
                body: 'The connection was removed. Connect Notion again and the Routine will retry.',
                stamp: 'Thu',
                actions: [
                  const FrockPill(
                    'Open Bot',
                    icon: Icons.chat_bubble_outline_rounded,
                    size: PillSize.sm,
                  ),
                  FrockPill(
                    'Dismiss',
                    kind: PillKind.ghost,
                    size: PillSize.sm,
                    color: t.ink2,
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Unread'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          FrockGroup(
            children: [
              FrockRow(
                leading: const FrockIconTile(Icons.mark_chat_unread_outlined),
                title: 'Bob',
                caption: 'Sent the memo to Sarah. Want a summary?',
                trailing: FrockPill(
                  'Read',
                  kind: PillKind.ghost,
                  size: PillSize.sm,
                  color: t.accent,
                ),
                chevron: true,
              ),
              FrockRow(
                leading: const FrockIconTile(Icons.mark_chat_unread_outlined),
                title: 'Research',
                caption: 'Three papers matched. Two look strong.',
                trailing: FrockPill(
                  'Read',
                  kind: PillKind.ghost,
                  size: PillSize.sm,
                  color: t.accent,
                ),
                chevron: true,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Settings home: rows to the sub-screens, then a section as an eyebrow over
/// a group with a primary pill to save.
class FrockSettingsScreen extends StatelessWidget {
  const FrockSettingsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: 'Settings',
      padded: false,
      leading: const FrockIconButton(
        Icons.arrow_back_rounded,
        semanticLabel: 'Back',
      ),
      trailing: const FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh settings',
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          FrockTokens.edge,
          8,
          FrockTokens.edge,
          FrockTokens.edge,
        ),
        children: [
          const FrockGroup(
            children: [
              FrockRow(
                leading: FrockIconTile(Icons.auto_awesome_rounded),
                title: 'Models',
                caption: 'Your default model and provider accounts',
                chevron: true,
              ),
              FrockRow(
                leading: FrockIconTile(Icons.hub_outlined),
                title: 'Connect',
                caption: 'Accounts and services for every Bot',
                chevron: true,
              ),
            ],
          ),
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Profile'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          FrockGroup(
            children: [
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: TextField(
                  decoration: InputDecoration(labelText: 'Name'),
                  controller: null,
                ),
              ),
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: TextField(
                  decoration: InputDecoration(
                    labelText: 'Email',
                    helperText: 'Where your Bots reach you',
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(0, 10, 0, 10),
                child: Wrap(
                  alignment: WrapAlignment.end,
                  children: [
                    FrockPill(
                      'Save profile',
                      kind: PillKind.primary,
                      size: PillSize.sm,
                      onTap: () {},
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Frock AI'),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('Account connected', style: t.caption),
          ),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          const FrockGroup(
            children: [
              FrockRow(
                leading: FrockIconTile(Icons.auto_awesome_rounded),
                title: 'Frock AI · Auto',
                caption: 'Default model for every Bot',
                chevron: true,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Voice, paused with messages waiting: screen 12 on the system page. The
/// whole screen, one sheep, what is waiting as rows, and Resume carrying the
/// count. Pause stops the session outright; Bots don't know.
class FrockVoiceScreen extends StatelessWidget {
  const FrockVoiceScreen({super.key});
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
            bottom + 12,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FrockBar(
                leading: const FrockIconButton(
                  Icons.close_rounded,
                  semanticLabel: 'Leave voice',
                ),
                title: const FrockEyebrow('Voice · paused'),
              ),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Opacity(
                      opacity: 0.7,
                      child: FrockSheep(
                        look: SheepLook(
                          background: 'hot-pink',
                          upper: 'upper-neutral',
                          middle: 'rose-heart-sunglasses',
                          lower: 'lower-neutral',
                        ),
                        size: 112,
                        state: BotState.idle,
                      ),
                    ),
                    const SizedBox(height: 18),
                    const FrockChip('Paused · not listening'),
                    const SizedBox(height: 12),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 300),
                      child: Text(
                        'Nothing is being heard. Your Bots don’t know you stepped away; what they send waits here.',
                        textAlign: TextAlign.center,
                        style: t.message.copyWith(color: t.ink2),
                      ),
                    ),
                  ],
                ),
              ),
              const FrockEyebrow('Waiting for you'),
              FrockGroup(
                children: [
                  FrockRow(
                    leading: const FrockSheep(
                      look: SheepLook(
                        background: 'hot-pink',
                        upper: 'upper-neutral',
                        middle: 'rose-heart-sunglasses',
                        lower: 'lower-neutral',
                      ),
                      size: FrockTokens.avatarMd,
                    ),
                    title: 'Bob',
                    caption: 'Sarah replied. She wants the APAC number split by country.',
                    trailing: const FrockChip('1', tone: TileTone.accent),
                  ),
                  FrockRow(
                    leading: const FrockSheep(size: FrockTokens.avatarMd),
                    title: 'Research',
                    caption: 'Two of the three papers look strong. Summary is ready.',
                    trailing: const FrockChip('1', tone: TileTone.accent),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              FrockPill(
                'Resume · 2 waiting',
                kind: PillKind.primary,
                size: PillSize.lg,
                icon: Icons.play_arrow_rounded,
                expand: true,
                onTap: () {},
              ),
              const SizedBox(height: 10),
              Text(
                'Resuming hands these to the voice agent to work through with you.',
                textAlign: TextAlign.center,
                style: t.caption,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Connect a service: screen 08 on docs/design/frock-ui.html. Services as
/// tiles a person already recognises, the ones they have connected first, and
/// one sentence on whose connections these are. Nothing here says "connector".
class FrockConnectScreen extends StatelessWidget {
  const FrockConnectScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return FrockPage(
      title: 'Connect',
      padded: false,
      leading: const FrockIconButton(
        Icons.arrow_back_rounded,
        semanticLabel: 'Back',
      ),
      trailing: const FrockIconButton(
        Icons.refresh_rounded,
        semanticLabel: 'Refresh services',
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(
          FrockTokens.edge,
          6,
          FrockTokens.edge,
          FrockTokens.edge,
        ),
        children: [
          Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
              color: t.tile,
              borderRadius: BorderRadius.circular(FrockTokens.radiusPill),
              border: Border.all(color: t.line),
            ),
            child: Row(
              children: [
                Icon(Icons.search_rounded, size: 16, color: t.ink3),
                const SizedBox(width: 8),
                Text('Search services', style: t.body.copyWith(color: t.ink3)),
              ],
            ),
          ),
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Connected'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          const FrockTileGrid(
            children: [
              FrockServiceTile(
                name: 'Gmail',
                caption: 'Connected',
                tone: TileTone.good,
                dot: true,
              ),
              FrockServiceTile(
                name: 'Calendar',
                caption: 'Connected',
                tone: TileTone.good,
                dot: true,
              ),
            ],
          ),
          const SizedBox(height: FrockTokens.groupGap),
          const FrockEyebrow('Popular'),
          const SizedBox(height: FrockTokens.eyebrowToGroup),
          const FrockTileGrid(
            children: [
              FrockServiceTile(name: 'Slack', caption: 'Messages, channels'),
              FrockServiceTile(name: 'Notion', caption: 'Pages, databases'),
              FrockServiceTile(name: 'GitHub', caption: 'Issues, PRs'),
              FrockServiceTile(name: 'Linear', caption: 'Issues, cycles'),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            'Connections belong to you, not to a Bot. Any Bot you allow can '
            'use them, and every use shows up as a receipt.',
            style: t.caption.copyWith(height: 17 / 12),
          ),
        ],
      ),
    );
  }
}
