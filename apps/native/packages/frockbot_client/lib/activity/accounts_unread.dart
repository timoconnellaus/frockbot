/// What the app's other accounts have unread, for the switcher's counts and
/// the application badge.
///
/// Only the account on screen has a shell, a state channel and a push
/// registration of its own; each other account's unread fan-out is read here
/// with its own client, when the list changes, every minute, and whenever
/// [refresh] is asked. A muted Bot adds nothing, as on the badge.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../client/accounts.dart';
import '../client/transport.dart';
import 'controller.dart';

class AccountsUnread extends ChangeNotifier {
  final NativeApi Function(AccountRecord account) apiFor;
  final Duration interval;
  AccountsUnread({
    required this.apiFor,
    this.interval = const Duration(minutes: 1),
  });

  final Map<String, ({NativeApi api, ActivityController activity})> _watched =
      {};
  Timer? _timer;
  bool _disposed = false;

  /// Watches exactly [accounts], reading any it was not watching yet.
  void watch(Iterable<AccountRecord> accounts) {
    if (_disposed) return;
    final wanted = {for (final account in accounts) account.id: account};
    for (final id in _watched.keys.toList()) {
      if (!wanted.containsKey(id)) _drop(id);
    }
    for (final account in wanted.values) {
      if (_watched.containsKey(account.id)) continue;
      final api = apiFor(account);
      final activity = ActivityController(api)..addListener(notifyListeners);
      _watched[account.id] = (api: api, activity: activity);
      unawaited(activity.load());
    }
    _timer?.cancel();
    _timer = _watched.isEmpty
        ? null
        : Timer.periodic(interval, (_) => refresh());
    notifyListeners();
  }

  Future<void> refresh() async {
    await Future.wait([
      for (final watched in _watched.values) watched.activity.load(),
    ]);
  }

  /// The count an account's switcher row shows.
  int unreadOf(String accountId) {
    final activity = _watched[accountId]?.activity;
    if (activity == null) return 0;
    return activity.unread.values.fold(
      0,
      (sum, view) => sum + (view.notificationsEnabled ? view.count : 0),
    );
  }

  /// Every watched account's count together, which the badge adds.
  int get total =>
      _watched.keys.fold(0, (sum, id) => sum + unreadOf(id));

  void _drop(String id) {
    final watched = _watched.remove(id);
    if (watched == null) return;
    watched.activity.removeListener(notifyListeners);
    watched.activity.dispose();
    watched.api.close();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    for (final id in _watched.keys.toList()) {
      _drop(id);
    }
    super.dispose();
  }
}
