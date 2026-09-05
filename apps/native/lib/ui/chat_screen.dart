import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;
import 'flock_drawer.dart';
import 'frock_tokens.dart';
import 'frock_widgets.dart';

/// The app's one room: a 44px bar (menu, the Bot, applets) over the
/// conversation. The flock sits in a drawer on a phone and beside the chat on
/// a wide window. There is no tab bar: chat is the app.
///
/// Safe areas: the bar keeps clear of the status bar, notch and cutouts through
/// `SafeArea`; the body keeps the bottom inset (home indicator) clear itself
/// so the composer sits exactly above it; the keyboard inset is `Scaffold`'s.
class ChatScreen extends StatelessWidget {
  const ChatScreen({
    super.key,
    required this.bots,
    required this.selected,
    required this.selectedState,
    required this.onSelect,
    required this.onRefresh,
    required this.onSignOut,
    required this.onApplets,
    required this.body,
    this.extraActions = const [],
    this.scaffoldKey,
  });
  final GlobalKey<ScaffoldState>? scaffoldKey;
  final List<wire.BotRegistration> bots;
  final wire.BotRegistration? selected;
  final BotState selectedState;
  final ValueChanged<wire.BotRegistration> onSelect;
  final VoidCallback onRefresh;
  final VoidCallback onSignOut;
  final VoidCallback onApplets;
  final Widget body;
  final List<Widget> extraActions;

  static const wideBreakpoint = 800.0;

  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    final wide = MediaQuery.sizeOf(context).width >= wideBreakpoint;
    final bottom = MediaQuery.paddingOf(context).bottom;
    final flock = FlockDrawer(
      bots: bots,
      selectedId: selected?.botId.value,
      stateOf: (id) =>
          id == selected?.botId.value ? selectedState : BotState.none,
      onSelect: onSelect,
      onRefresh: onRefresh,
      onSignOut: onSignOut,
    );
    final room = Padding(
      padding: EdgeInsets.fromLTRB(
        FrockTokens.edge,
        0,
        FrockTokens.edge,
        bottom + 8,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Builder(
            builder: (context) => FrockBar(
              leading: wide
                  ? null
                  : FrockIconButton(
                      Icons.menu_rounded,
                      semanticLabel: 'Your Bots',
                      onTap: () => Scaffold.of(context).openDrawer(),
                    ),
              title: selected == null
                  ? Text('FrockBot', style: t.barTitle)
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        FrockSheep(
                          look: lookOf(selected!.sheep),
                          size: FrockTokens.avatarSm,
                          state: selectedState,
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            selected!.initialName,
                            style: t.barTitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
              trailing: extraActions.isEmpty
                  ? FrockIconButton(
                      Icons.grid_view_outlined,
                      semanticLabel: 'Applets',
                      onTap: onApplets,
                    )
                  : Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ...extraActions,
                        FrockIconButton(
                          Icons.grid_view_outlined,
                          semanticLabel: 'Applets',
                          onTap: onApplets,
                        ),
                      ],
                    ),
            ),
          ),
          Expanded(child: body),
        ],
      ),
    );
    return Scaffold(
      key: scaffoldKey,
      backgroundColor: t.window,
      drawer: wide
          ? null
          : Drawer(
              backgroundColor: t.ground,
              width: 300,
              shape: const RoundedRectangleBorder(),
              child: flock,
            ),
      body: SafeArea(
        bottom: false,
        child: wide
            ? Row(
                children: [
                  SizedBox(
                    width: 280,
                    child: ColoredBox(color: t.ground, child: flock),
                  ),
                  Container(width: 1, color: t.line),
                  Expanded(child: room),
                ],
              )
            : room,
      ),
    );
  }
}

/// No Bot chosen yet: the room before anyone is in it.
class ChatEmpty extends StatelessWidget {
  const ChatEmpty({
    super.key,
    required this.title,
    required this.detail,
    required this.action,
    required this.onAction,
  });
  final String title;
  final String detail;
  final String action;
  final VoidCallback onAction;
  @override
  Widget build(BuildContext context) {
    final t = FrockTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const FrockSheep(size: FrockTokens.avatarLg),
          const SizedBox(height: 16),
          Text(title, style: t.nameStyle),
          const SizedBox(height: 6),
          Text(detail, style: t.body),
          const SizedBox(height: 16),
          Row(
            children: [
              FrockPill(action, kind: PillKind.primary, onTap: onAction),
            ],
          ),
        ],
      ),
    );
  }
}
