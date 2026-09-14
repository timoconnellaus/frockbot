/// The application icon's unread badge: one counting rule, and a thin adapter
/// per platform that draws it.
///
/// The count is the cloud's unread fan-out, read through the same focus rule
/// the sidebar applies, over the Bots a person would want to be told about:
/// not archived, and not muted. A muted Bot still counts on its own row —
/// muting silences alerting, and the icon is an alert — and a Bot marked
/// unread by hand adds nothing, because that flag is a reminder with no count.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../protocol/client_wire.generated.dart' as wire;
import '../shell/focus.dart';

/// Where the dock label stops counting, matching the sidebar's "99+".
const appBadgeCap = 99;

/// One Bot's contribution to the application badge.
@immutable
class BotBadge {
  /// Unread messages after the focus rule; the cloud caps it at 99.
  final int count;

  /// Whether the cloud said the real count is above [count].
  final bool capped;
  const BotBadge(this.count, {this.capped = false});

  /// The best number a launcher can show for this Bot: a capped count is at
  /// least one more than the cap, and that lower bound is all that is known.
  int get launcherCount => capped ? count + 1 : count;

  @override
  bool operator ==(Object other) =>
      other is BotBadge && other.count == count && other.capped == capped;

  @override
  int get hashCode => Object.hash(count, capped);
}

@immutable
class AppBadge {
  /// Every eligible Bot the fan-out reported, including those at zero, so an
  /// adapter can tell "nothing unread" from "not reported".
  final Map<String, BotBadge> bots;

  /// Bots whose alerts must not contribute: muted, or archived.
  final Set<String> silenced;
  const AppBadge({this.bots = const {}, this.silenced = const {}});

  static const empty = AppBadge();

  int get total => bots.values.fold(0, (sum, bot) => sum + bot.count);

  /// The dock's text, or null for no badge.
  String? get label {
    if (total == 0) return null;
    final saturated =
        total > appBadgeCap || bots.values.any((bot) => bot.capped);
    return saturated ? '$appBadgeCap+' : '$total';
  }

  /// Each Bot's best launcher number, the shape the Android channel takes.
  Map<String, int> get launcherCounts => {
    for (final entry in bots.entries) entry.key: entry.value.launcherCount,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppBadge &&
          mapEquals(bots, other.bots) &&
          setEquals(silenced, other.silenced);

  @override
  int get hashCode => Object.hash(
    Object.hashAllUnordered([
      for (final entry in bots.entries) Object.hash(entry.key, entry.value),
    ]),
    Object.hashAllUnordered(silenced),
  );
}

/// The badge for this account right now.
///
/// [botIds] is the non-archived directory, so it is the whole of what counts.
/// [archived] is silenced rather than counted: an archived Bot can still hold
/// an alert posted before it was archived, and that alert would badge the
/// launcher for a count this rule does not include. A Bot the fan-out mentions
/// outside both directories is left alone rather than guessed at.
/// [focusedBotId] is the Bot the shell says is being read, whose count the
/// read receipt in flight is about to clear.
AppBadge appBadgeFor({
  required Map<String, wire.UnreadView> unread,
  required Iterable<String> botIds,
  Set<String> archived = const {},
  required String? focusedBotId,
}) {
  final bots = <String, BotBadge>{};
  final silenced = <String>{...archived};
  for (final botId in botIds) {
    final view = unread[botId];
    if (view == null) continue;
    if (!view.notificationsEnabled) {
      silenced.add(botId);
      continue;
    }
    final focused = botId == focusedBotId;
    bots[botId] = BotBadge(
      sidebarUnreadFor(view, focused: focused).count,
      capped: !focused && view.capped,
    );
  }
  return AppBadge(bots: bots, silenced: silenced);
}

/// What draws the badge on one platform.
abstract interface class AppBadgePresenter {
  Future<void> show(AppBadge badge);

  /// Takes this account's badge away: sign-out, or the shell torn down.
  Future<void> clear();
}

/// The macOS dock tile. The label is decided here, so the dock and the
/// sidebar saturate the same way.
class DockBadgePresenter implements AppBadgePresenter {
  final MethodChannel channel;
  const DockBadgePresenter({
    this.channel = const MethodChannel('com.frockbot/badge'),
  });

  @override
  Future<void> show(AppBadge badge) =>
      channel.invokeMethod<void>('set', {'label': badge.label});

  @override
  Future<void> clear() => channel.invokeMethod<void>('set', {'label': null});
}

/// Android launchers badge from active notifications, which the platform owns.
///
/// Nothing here posts a notification to force a badge: it reconciles the
/// ones that already exist with the cloud — each one's number becomes the
/// Bot's unread count, and a silenced Bot's notification goes. A Bot at zero
/// is left alone; only a read cursor discards an alert, and swiping one away
/// never marks the conversation read. Some launchers only draw a dot.
class LauncherBadgePresenter implements AppBadgePresenter {
  final MethodChannel channel;
  final bool Function() ready;
  const LauncherBadgePresenter({
    required this.ready,
    this.channel = const MethodChannel('frockbot/push'),
  });

  @override
  Future<void> show(AppBadge badge) async {
    if (!ready()) return;
    await channel.invokeMethod<void>('badge', {
      'bots': badge.launcherCounts,
      'silenced': badge.silenced.toList()..sort(),
    });
  }

  /// Sign-out's `logout` call already cancels every notification the account
  /// held. A shell torn down while still signed in keeps them: the device is
  /// still registered, and they are still true.
  @override
  Future<void> clear() async {}
}

/// The presenter for this platform, or none.
AppBadgePresenter? appBadgePresenterFor({required bool Function() pushReady}) {
  if (kIsWeb) return null;
  return switch (defaultTargetPlatform) {
    TargetPlatform.macOS => const DockBadgePresenter(),
    TargetPlatform.android => LauncherBadgePresenter(ready: pushReady),
    _ => null,
  };
}

/// Sends a badge only when it changed, in order, and never after [clear].
///
/// One per signed-in shell. The icon has one badge, so the shell that drew it
/// last owns it: a shell being replaced by another account's clears nothing
/// the new one has already drawn.
class AppBadgeSync {
  static AppBadgeSync? _owner;
  final AppBadgePresenter? presenter;
  AppBadgeSync(this.presenter);
  AppBadge? _sent;
  bool _cleared = false;
  Future<void> _queue = Future.value();

  /// Makes the next [update] cross the channel even when its value is equal.
  /// Android uses this after push setup becomes ready: an earlier render may
  /// have calculated the right badge before the account-scoped channel could
  /// safely reconcile native notifications.
  void invalidate() => _sent = null;

  /// Reconciles a value only after the cloud has supplied the account's unread
  /// fan-out. The shell builds once before that first load; treating its empty
  /// local map as an authoritative zero would clear a badge another shell
  /// state just drew while the real unread counts are still in flight.
  void reconcile(AppBadge badge, {required bool authoritative}) {
    if (!authoritative) return;
    update(badge);
  }

  void update(AppBadge badge) {
    final presenter = this.presenter;
    if (presenter == null || _cleared) return;
    if (identical(_owner, this) && badge == _sent) return;
    _owner = this;
    _sent = badge;
    _enqueue(() => presenter.show(badge));
  }

  Future<void> clear() {
    final presenter = this.presenter;
    if (presenter == null || _cleared) return _queue;
    _cleared = true;
    _sent = null;
    if (_owner != null && !identical(_owner, this)) return _queue;
    _owner = null;
    return _enqueue(presenter.clear);
  }

  Future<void> _enqueue(Future<void> Function() call) {
    _queue = _queue.then((_) async {
      try {
        await call();
      } catch (_) {
        // A badge is a courtesy: the next change sends it again.
      }
    });
    return _queue;
  }
}
