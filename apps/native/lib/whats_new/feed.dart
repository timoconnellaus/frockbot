/// The What’s New feed the sidebar's megaphone and its page read.
library;

import '../client/transport.dart';

const whatsNewSeenKeyV1 = 'whats-new/seen';

class WhatsNewImage {
  final String src;
  final String alt;
  const WhatsNewImage({required this.src, required this.alt});
}

class WhatsNewEntry {
  final String id;
  final String title;
  final String summary;
  final String kind;

  /// UTC calendar day `YYYY-MM-DD` of the first production tag, when known.
  final String? publishedAt;
  final WhatsNewImage? image;
  const WhatsNewEntry({
    required this.id,
    required this.title,
    required this.summary,
    required this.kind,
    this.publishedAt,
    this.image,
  });

  /// What the row shows instead of inventing a merge day.
  String get when {
    final day = publishedAt;
    if (day == null || day.length < 10) return 'New';
    const months = <String>[
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    final year = int.tryParse(day.substring(0, 4));
    final month = int.tryParse(day.substring(5, 7));
    final date = int.tryParse(day.substring(8, 10));
    if (year == null || month == null || date == null) return 'New';
    if (month < 1 || month > 12) return 'New';
    return '$date ${months[month - 1]} $year';
  }
}

class WhatsNewFeed {
  final List<WhatsNewEntry> entries;
  const WhatsNewFeed({this.entries = const []});

  factory WhatsNewFeed.decode(Object? value) {
    if (value is! Map) return const WhatsNewFeed();
    final rows = value['entries'];
    if (rows is! List) return const WhatsNewFeed();
    return WhatsNewFeed(
      entries: [
        for (final row in rows)
          if (row is Map) ?_entry(row),
      ],
    );
  }

  String? get newestId => entries.firstOrNull?.id;

  int unseenCount(String? seenId) {
    if (seenId == null) return entries.length;
    var count = 0;
    for (final entry in entries) {
      if (entry.id == seenId) break;
      count += 1;
    }
    return count;
  }

  /// Newer than the last seen id. The list is newest-first.
  bool isUnread(String id, String? seenId) {
    if (seenId == null) return true;
    final seenAt = entries.indexWhere((entry) => entry.id == seenId);
    final at = entries.indexWhere((entry) => entry.id == id);
    if (at < 0) return false;
    if (seenAt < 0) return true;
    return at < seenAt;
  }
}

WhatsNewEntry? _entry(Map<Object?, Object?> row) {
  final id = row['id'];
  final title = row['title'];
  final summary = row['summary'];
  final kind = row['kind'];
  if (id is! String ||
      title is! String ||
      summary is! String ||
      kind is! String) {
    return null;
  }
  if (id.isEmpty || title.isEmpty || summary.isEmpty) return null;
  final published = row['publishedAt'];
  final image = row['image'];
  return WhatsNewEntry(
    id: id,
    title: title,
    summary: summary,
    kind: kind,
    publishedAt: published is String && published.isNotEmpty ? published : null,
    image: image is Map ? _image(image) : null,
  );
}

WhatsNewImage? _image(Map<Object?, Object?> row) {
  final src = row['src'];
  final alt = row['alt'];
  if (src is! String || alt is! String) return null;
  if (!src.startsWith('/whats-new/') || alt.isEmpty) return null;
  return WhatsNewImage(src: src, alt: alt);
}

String whatsNewImageUrlV1(String origin, String src) => '$origin$src';

Future<WhatsNewFeed> readWhatsNewFeedV1(NativeApi api) async {
  try {
    return WhatsNewFeed.decode(await api.request('/api/whats-new'));
  } on Object {
    return const WhatsNewFeed();
  }
}
