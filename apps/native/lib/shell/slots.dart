/// Where a feature may render inside the shell.
///
/// The Vue shell has `<k-slot name="frockbot.right-panel">` and its siblings:
/// named regions the shell draws and a feature fills, so the shell never
/// imports the feature. This is the same idea with Flutter's vocabulary — a
/// registry a feature registers a builder into, and a [SlotRegion] the shell
/// places where the region belongs.
///
/// Three regions, because three is what the shell actually opens. Trust chrome
/// is never a slot: the transcript, the composer and the Bot list are the
/// shell's own and no entry can displace them.
library;

import 'package:flutter/widgets.dart';

import 'semantics.dart';

enum ShellSlot {
  /// The right-hand column at wide widths; a drawer below them.
  rightPanel('right-panel'),

  /// Full-window layers: dialogs, sheets, the search overlay.
  overlays('overlays'),

  /// Actions beside the conversation title.
  headerActions('header-actions');

  const ShellSlot(this.id);

  /// The kebab-case name, which is also the region's semantics identifier.
  final String id;
}

/// One thing a feature put in a region: what to draw, and what to call it
/// where the region shows one entry at a time.
typedef ShellSlotEntry = ({String? label, WidgetBuilder builder});

/// The entries each region holds, in registration order.
class ShellSlots extends ChangeNotifier {
  final Map<ShellSlot, Map<String, ShellSlotEntry>> _entries = {
    for (final slot in ShellSlot.values) slot: <String, ShellSlotEntry>{},
  };

  /// Registers under [key], replacing any entry the same key already holds.
  ///
  /// [label] is what a region that shows one entry at a time calls this one.
  /// A region that draws every entry — the header actions — ignores it.
  void register(
    ShellSlot slot,
    String key,
    WidgetBuilder builder, {
    String? label,
  }) {
    _entries[slot]![key] = (label: label, builder: builder);
    notifyListeners();
  }

  void remove(ShellSlot slot, String key) {
    if (_entries[slot]!.remove(key) != null) notifyListeners();
  }

  bool filled(ShellSlot slot) => _entries[slot]!.isNotEmpty;

  /// The keys a region holds, in registration order.
  List<String> keys(ShellSlot slot) => _entries[slot]!.keys.toList();

  String? labelOf(ShellSlot slot, String key) => _entries[slot]![key]?.label;

  /// One entry, or nothing where the region does not hold that key.
  Widget? buildOne(BuildContext context, ShellSlot slot, String key) {
    final entry = _entries[slot]![key];
    return entry == null
        ? null
        : KeyedSubtree(key: ValueKey(key), child: entry.builder(context));
  }

  List<Widget> build(BuildContext context, ShellSlot slot) => [
    for (final entry in _entries[slot]!.entries)
      KeyedSubtree(
        key: ValueKey(entry.key),
        child: entry.value.builder(context),
      ),
  ];

  static ShellSlots of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<ShellSlotScope>();
    assert(scope != null, 'No ShellSlotScope above this widget');
    return scope!.notifier!;
  }
}

class ShellSlotScope extends InheritedNotifier<ShellSlots> {
  const ShellSlotScope({
    super.key,
    required ShellSlots slots,
    required super.child,
  }) : super(notifier: slots);
}

/// Draws one region. An empty region draws nothing at all, so the shell's own
/// layout does not reserve space for a feature that is not there.
class SlotRegion extends StatelessWidget {
  final ShellSlot slot;
  final Axis direction;
  final double gap;
  const SlotRegion(
    this.slot, {
    super.key,
    this.direction = Axis.vertical,
    this.gap = 12,
  });

  @override
  Widget build(BuildContext context) {
    final slots = ShellSlots.of(context);
    final children = slots.build(context, slot);
    if (children.isEmpty) return const SizedBox.shrink();
    final spaced = <Widget>[];
    for (final child in children) {
      if (spaced.isNotEmpty) {
        spaced.add(
          direction == Axis.vertical
              ? SizedBox(height: gap)
              : SizedBox(width: gap),
        );
      }
      spaced.add(child);
    }
    return identified(
      ShellIds.slot(slot.id),
      direction == Axis.vertical
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: spaced,
            )
          : Row(mainAxisSize: MainAxisSize.min, children: spaced),
    );
  }
}
