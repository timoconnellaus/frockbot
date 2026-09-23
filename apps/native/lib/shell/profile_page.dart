/// You: who is signed in, what is the account's, what is every Bot's, and the
/// door out.
///
/// On a phone it is a list and each row opens its page over it, so Back
/// returns here. Wider, the rows are a column beside the page they open, the
/// way the shell's Bot list sits beside a conversation: another row swaps the
/// page in place rather than going back to choose again.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/frock_theme.dart';
import '../theme/rows.dart';
import 'desktop_layout.dart';
import 'semantics.dart';

/// One place the page leads: a row, and what it opens.
class ProfileSection {
  final String id;
  final IconData icon;
  final String title;
  final Widget Function() page;

  /// Run once the page is left: Billing reads the balance again.
  final Future<void> Function()? onLeave;
  const ProfileSection({
    required this.id,
    required this.icon,
    required this.title,
    required this.page,
    this.onLeave,
  });
}

/// Rows with the name of what they have in common.
class ProfileGroup {
  final String? title;
  final List<ProfileSection> sections;
  const ProfileGroup(this.title, this.sections);
}

class ProfilePage extends StatefulWidget {
  /// Who is signed in, at the top.
  final Widget identity;

  /// What the account can spend, under the name, pressed to open
  /// [creditSection]; null on a deployment that does not meter.
  final Widget? Function(VoidCallback onTap) credit;
  final String creditSection;

  final List<ProfileGroup> groups;

  /// The door out; null where there is nothing to sign out of.
  final VoidCallback? onSignOut;

  /// The last line: which program this is.
  final Widget version;

  /// Pushes a page over this one: the phone's way into a row.
  final Future<void> Function(Widget page) open;

  /// The row chosen when the page is two columns; the first when null.
  final String? initialSection;

  const ProfilePage({
    super.key,
    required this.identity,
    required this.credit,
    required this.creditSection,
    required this.groups,
    required this.version,
    required this.open,
    this.onSignOut,
    this.initialSection,
  });

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  late String chosen = _section(widget.initialSection)?.id ?? _first.id;
  GlobalKey<NavigatorState> pane = GlobalKey();
  bool split = false;

  ProfileSection get _first => widget.groups.expand((g) => g.sections).first;

  ProfileSection? _section(String? id) => widget.groups
      .expand((group) => group.sections)
      .where((section) => section.id == id)
      .firstOrNull;

  @override
  void dispose() {
    if (split) unawaited(_section(chosen)?.onLeave?.call());
    super.dispose();
  }

  Future<void> _press(String id) async {
    final section = _section(id);
    if (section == null) return;
    if (!split) {
      await widget.open(section.page());
      await section.onLeave?.call();
      if (mounted) setState(() {});
      return;
    }
    if (id == chosen) {
      // The chosen row again goes back to the top of its page.
      pane.currentState?.popUntil((route) => route.isFirst);
      return;
    }
    final left = _section(chosen);
    setState(() {
      chosen = id;
      pane = GlobalKey();
    });
    await left?.onLeave?.call();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    split =
        shellTierForWidth(MediaQuery.sizeOf(context).width) != ShellTier.single;
    return split ? _columns(context) : _list(context);
  }

  List<Widget> _top() => [
    widget.identity,
    // What the account can spend, first, because it is the one thing on
    // this page that decides whether a Bot replies at all.
    ?widget.credit(() => unawaited(_press(widget.creditSection))),
  ];

  Widget _list(BuildContext context) => Scaffold(
    appBar: DesktopHeader(child: AppBar(title: const Text('You'))),
    body: identified(
      SettingsIds.profileMenu,
      SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ..._top(),
                  for (final group in widget.groups)
                    _card(group.title, [
                      for (final section in group.sections)
                        identified(
                          section.id,
                          FrockRow(
                            icon: section.icon,
                            title: section.title,
                            onTap: () => unawaited(_press(section.id)),
                          ),
                        ),
                    ]),
                  if (widget.onSignOut != null)
                    _card(null, [_signOut(context, card: true)]),
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: widget.version,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );

  /// One card of rows, with the name of what they have in common above it.
  Widget _card(String? title, List<Widget> rows) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (title != null)
        FrockSectionLabel(title)
      else
        const SizedBox(height: 18),
      FrockRowGroup(rows: rows),
    ],
  );

  Widget _signOut(BuildContext context, {required bool card}) => identified(
    SettingsIds.profileSignOut,
    _NavItem(
      card: card,
      child: FrockRow(
        icon: Icons.logout_rounded,
        title: 'Sign out',
        color: Theme.of(context).colorScheme.error,
        chevron: false,
        onTap: () {
          Navigator.of(context).pop();
          widget.onSignOut!();
        },
      ),
    ),
  );

  /// The rows as a column beside the page the chosen one opens. The page
  /// keeps its own stack, so what it opens comes back to it, and a Back —
  /// the system's or the browser's — leaves that stack before it leaves You.
  Widget _columns(BuildContext context) {
    final theme = Theme.of(context);
    final section = _section(chosen) ?? _first;
    return Scaffold(
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: shellSidebarWidth,
            decoration: BoxDecoration(
              border: Border(
                right: BorderSide(
                  color: FrockTheme.hairline(theme.colorScheme),
                ),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DesktopHeader(child: AppBar(title: const Text('You'))),
                Expanded(
                  child: identified(
                    SettingsIds.profileMenu,
                    ListView(
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                      children: [
                        ..._top(),
                        for (final group in widget.groups) ...[
                          if (group.title case final String title)
                            FrockSectionLabel(title)
                          else
                            const SizedBox(height: 18),
                          for (final item in group.sections)
                            _navRow(context, item, item.id == section.id),
                        ],
                        if (widget.onSignOut != null) ...[
                          const SizedBox(height: 18),
                          _signOut(context, card: false),
                        ],
                        Padding(
                          padding: const EdgeInsets.only(top: 24),
                          child: widget.version,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: NavigatorPopHandler<void>(
              onPopWithResult: (_) => pane.currentState?.maybePop(),
              child: Navigator(
                key: pane,
                onGenerateRoute: (settings) => MaterialPageRoute<void>(
                  settings: settings,
                  // The theme spaces a title for the Back before it; the page
                  // a row opens has none, so its title steps in from the rule.
                  // What it pushes is built above this and keeps the theme's.
                  builder: (context) => Theme(
                    data: theme.copyWith(
                      appBarTheme: theme.appBarTheme.copyWith(
                        titleSpacing: NavigationToolbar.kMiddleSpacing,
                      ),
                    ),
                    child: section.page(),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _navRow(BuildContext context, ProfileSection item, bool selected) {
    final scheme = Theme.of(context).colorScheme;
    return identified(
      item.id,
      Semantics(
        selected: selected,
        child: _NavItem(
          card: false,
          selected: selected,
          child: FrockRow(
            icon: item.icon,
            title: item.title,
            chevron: false,
            color: selected ? scheme.primary : null,
            onTap: () => unawaited(_press(item.id)),
          ),
        ),
      ),
    );
  }
}

/// A row in the column: its own rounded ground, tinted while it is the one
/// open, the way the sidebar's active control is. On a card it is the card's.
class _NavItem extends StatelessWidget {
  final bool card;
  final bool selected;
  final Widget child;
  const _NavItem({
    required this.card,
    required this.child,
    this.selected = false,
  });

  @override
  Widget build(BuildContext context) {
    if (card) return child;
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected
            ? scheme.primary.withValues(alpha: 0.14)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        clipBehavior: Clip.antiAlias,
        child: child,
      ),
    );
  }
}
