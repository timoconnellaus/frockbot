/// Comparing and copying decoded JSON, neither of which Dart gives for free.
///
/// Equality: whether a press being made again is the press whose answer was
/// lost (`press.dart`) is asked of the context that control sent, which is a
/// wire value — a map there is a bag of keys and not an identity, so the
/// question is answered here rather than by whoever happens to ask it.
///
/// Copying: the renderer's data model is a live thing it writes into, and it
/// is handed the maps a read decoded. Without a copy at that handoff the record
/// becomes a mirror of the surface — what a person typed would be written back
/// into the card as read, and a card that has not moved would stop looking like
/// itself.
library;

/// Whether two decoded JSON values are the same value, maps and lists included.
bool sameJsonV1(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !sameJsonV1(a[key], b[key])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!sameJsonV1(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// A decoded JSON value copied down to its leaves, so that whoever is given it
/// can write into it without the original changing underneath.
Object? copyJsonV1(Object? value) {
  if (value is Map) {
    return <String, Object?>{
      for (final entry in value.entries)
        entry.key.toString(): copyJsonV1(entry.value),
    };
  }
  if (value is List) return [for (final item in value) copyJsonV1(item)];
  return value;
}
