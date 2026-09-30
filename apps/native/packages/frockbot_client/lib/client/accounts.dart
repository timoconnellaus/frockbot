/// The accounts an app holds: each a sign-in to one server.
///
/// The app may be signed in to several at once — frockbot.com, a self-hosted
/// install, a second sign-in to either — and a person switches between them
/// the way they switch Slack workspaces. Each account has its own origin, its
/// own token in the platform keystore, its own caches and its own unread
/// state, all under its own prefix of the app's store (`ScopedStore`), so
/// nothing one account holds is ever read by another and signing out of one
/// leaves the rest. The browser holds one account, the origin it was served
/// from, and never lists this directory.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../brand.dart';
import 'transport.dart';

/// One sign-in to one server.
@immutable
class AccountRecord {
  /// Local and random: it names the account's prefix, never anything a
  /// server sees.
  final String id;
  final String origin;

  /// The product the server said it is when the account was added.
  final String name;

  /// The User the server signed this account in as, once it has.
  final String? userId;
  const AccountRecord({
    required this.id,
    required this.origin,
    required this.name,
    this.userId,
  });

  /// Whether this is the deployment the build was made for: frockbot.com, in
  /// FrockBot's own build.
  bool get hosted => origin == hostedOrigin;

  String get host => Uri.parse(origin).host;

  /// Where the account is, as the switcher shows it: frockbot.com by the name
  /// the brand gives it, any other server by its host.
  String get serverLabel =>
      hosted ? (clientBrand.hostedServiceName ?? host) : host;

  AccountRecord signedInAs(String userId) =>
      AccountRecord(id: id, origin: origin, name: name, userId: userId);

  Map<String, Object?> toJson() => {
    'id': id,
    'origin': origin,
    'name': name,
    'userId': ?userId,
  };

  static AccountRecord? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final origin = value['origin'];
    final name = value['name'];
    final userId = value['userId'];
    if (id is! String || origin is! String || name is! String) return null;
    if (!RegExp(r'^[A-Za-z0-9_-]{1,64}$').hasMatch(id)) return null;
    return AccountRecord(
      id: id,
      origin: origin,
      name: name,
      userId: userId is String ? userId : null,
    );
  }
}

/// The account list and which one is on screen, kept in the app's store
/// outside every account.
class AccountDirectory extends ChangeNotifier {
  static const key = 'accounts.v1';

  /// The account a sign-in in progress is for: an Android sign-in returns as
  /// a link, possibly to a process started afresh, and must find it.
  static const pendingKey = 'accounts.pending.v1';

  final LocalStore store;
  AccountDirectory(this.store);

  List<AccountRecord> accounts = const [];
  String? activeId;

  /// An account being added, not listed until its sign-in completes.
  AccountRecord? pending;
  bool loaded = false;

  AccountRecord? get active {
    for (final account in accounts) {
      if (account.id == activeId) return account;
    }
    return accounts.isEmpty ? null : accounts.first;
  }

  /// Reads the directory. The first run of a build that holds accounts finds
  /// none and clears what the single-account build left outside every prefix:
  /// its session and caches name no account, and nothing is carried over.
  Future<void> load() async {
    final saved = await store.read(key);
    if (saved == null) {
      if (store case AccountsStore accountsStore) {
        await accountsStore.deleteUnscoped({key});
      }
      await _save();
    } else {
      try {
        final decoded = jsonDecode(saved);
        if (decoded is Map && decoded['version'] == 1) {
          accounts = List.unmodifiable([
            for (final entry in (decoded['accounts'] as List? ?? const []))
              ?AccountRecord.fromJson(entry),
          ]);
          final active = decoded['active'];
          activeId = active is String ? active : null;
        }
      } on FormatException {
        accounts = const [];
      }
    }
    final pendingSaved = await store.read(pendingKey);
    if (pendingSaved != null) {
      try {
        pending = AccountRecord.fromJson(jsonDecode(pendingSaved));
      } on FormatException {
        pending = null;
      }
    }
    loaded = true;
    notifyListeners();
  }

  /// Starts adding an account on [origin]. It is listed once signed in.
  Future<AccountRecord> begin(String origin, String name) async {
    final previous = pending;
    if (previous != null) await _forget(previous.id);
    final account = AccountRecord(
      id: randomId().substring(1, 17),
      origin: origin,
      name: name,
    );
    pending = account;
    await store.write(pendingKey, jsonEncode(account.toJson()));
    notifyListeners();
    return account;
  }

  /// The account being added finished signing in as [userId], and is now the
  /// one on screen. Signing in again as an account already listed replaces
  /// the listed one, whose caches go with it: two entries for one account
  /// would be two sets of the same unread.
  Future<AccountRecord> complete(AccountRecord account, String userId) async {
    final signedIn = account.signedInAs(userId);
    final existing = accounts.where(
      (candidate) =>
          candidate.id != account.id &&
          candidate.origin == account.origin &&
          candidate.userId == userId,
    );
    final replaced = existing.isEmpty ? null : existing.first;
    accounts = List.unmodifiable([
      for (final candidate in accounts)
        if (candidate.id != account.id && candidate.id != replaced?.id)
          candidate,
      signedIn,
    ]);
    activeId = signedIn.id;
    if (pending?.id == account.id) {
      pending = null;
      await store.delete(pendingKey);
    }
    await _save();
    if (replaced != null) await _forget(replaced.id);
    notifyListeners();
    return signedIn;
  }

  /// Records who an account turned out to be, when the identity read says.
  Future<void> identify(AccountRecord account, String userId) async {
    if (account.userId == userId) return;
    accounts = List.unmodifiable([
      for (final candidate in accounts)
        candidate.id == account.id ? candidate.signedInAs(userId) : candidate,
    ]);
    await _save();
    notifyListeners();
  }

  Future<void> activate(AccountRecord account) async {
    if (activeId == account.id) return;
    activeId = account.id;
    await _save();
    notifyListeners();
  }

  /// Drops an account and everything cached under it. The session must
  /// already be revoked or refused: this deletes the token.
  Future<void> remove(AccountRecord account) async {
    accounts = List.unmodifiable([
      for (final candidate in accounts)
        if (candidate.id != account.id) candidate,
    ]);
    if (activeId == account.id) {
      activeId = accounts.isEmpty ? null : accounts.last.id;
    }
    if (pending?.id == account.id) {
      pending = null;
      await store.delete(pendingKey);
    }
    await _save();
    await _forget(account.id);
    notifyListeners();
  }

  /// Abandons the account being added.
  Future<void> abandon() async {
    final account = pending;
    if (account == null) return;
    pending = null;
    await store.delete(pendingKey);
    await _forget(account.id);
    notifyListeners();
  }

  /// The store an account reads and writes: its own prefix of the app's.
  LocalStore storeFor(AccountRecord account) => ScopedStore(store, account.id);

  Future<void> _forget(String id) async {
    if (store case AccountsStore accountsStore) {
      await accountsStore.deletePrefix('$accountKeyPrefixV1$id/');
    }
  }

  Future<void> _save() => store.write(
    key,
    jsonEncode({
      'version': 1,
      'active': ?activeId,
      'accounts': [for (final account in accounts) account.toJson()],
    }),
  );
}
