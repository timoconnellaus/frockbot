import 'package:flutter/widgets.dart';

/// Doors the panel keeps mounted after the first visit.
///
/// Audit, Templates, Voice, Look and framed WebViews stay out: they are
/// not the thing someone flips back to, and a WebView that stays alive is
/// a tab nobody asked to keep.
const hotPanelDoors = {'bot-page', 'routines', 'plugins', 'bot-settings'};

/// Whether the panel page under this context is the one on screen.
///
/// Absent means the page is the only one, so it is visible.
class PanelVisibility extends InheritedWidget {
  final bool visible;

  const PanelVisibility({
    super.key,
    required this.visible,
    required super.child,
  });

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PanelVisibility>()?.visible ??
      true;

  @override
  bool updateShouldNotify(PanelVisibility old) => visible != old.visible;
}

/// Keeps visited hot doors mounted, and shows only [shown].
///
/// Leaving All Routines used to dispose the list. Coming back remounted it
/// even when last-known was in memory. The doors named in [hotPanelDoors]
/// stay in the tree so a return is the same page, not a new one.
class HotPanelStack extends StatelessWidget {
  final String shown;
  final List<String> kept;
  final Widget Function(String key) builder;

  const HotPanelStack({
    super.key,
    required this.shown,
    required this.kept,
    required this.builder,
  });

  @override
  Widget build(BuildContext context) {
    final keys = [...kept];
    if (!keys.contains(shown)) keys.add(shown);
    return Stack(
      fit: StackFit.expand,
      children: [
        for (final key in keys)
          Offstage(
            offstage: key != shown,
            child: TickerMode(
              enabled: key == shown,
              child: PanelVisibility(
                visible: key == shown,
                child: KeyedSubtree(key: ValueKey(key), child: builder(key)),
              ),
            ),
          ),
      ],
    );
  }
}
