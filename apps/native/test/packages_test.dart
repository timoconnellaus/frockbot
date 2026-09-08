import 'package:flutter_test/flutter_test.dart';
import 'package:frockbot_native/packages/catalog.dart';

/// The shape `/api/bots/:botId/package-ui` answers with, written by hand so
/// the Flutter side is pinned to `PackageIframeCatalogV1` rather than to a
/// fixture the server could change without anything noticing.
Map<String, Object?> catalog({
  List<String> tools = const ['applet_focus'],
  int? order,
  String provenance = 'FrockBot',
}) => {
  'schemaVersion': 1,
  'botId': 'bot-1',
  'artifactOrigin': 'https://ui.bot.frockbot.com',
  'contributions': [
    {
      'packageId': 'applets',
      'displayName': 'Applets',
      'provenance': provenance,
      'declaredTools': tools,
      'pages': [
        {
          'id': 'list',
          'artifact': {
            'contentHash': 'a' * 64,
            'size': 100,
            'mediaType': 'text/html',
            'bundlerVersion': '1',
          },
          'mounts': [
            {'slot': 'frockbot.surface:list'},
          ],
        },
        {
          'id': 'canvas',
          'artifact': {
            'contentHash': 'b' * 64,
            'size': 100,
            'mediaType': 'text/html',
            'bundlerVersion': '1',
          },
          'mounts': [
            {'slot': 'frockbot.right-panel', 'order': 3},
          ],
        },
      ],
      'entries': [
        {
          'id': 'open',
          'slot': 'frockbot.sidebar-actions',
          'order': ?order,
          'label': 'Applets',
          'icon': 'applets',
          'opens': {'kind': 'surface', 'page': 'list'},
        },
      ],
    },
  ],
};

void main() {
  test('an entry resolves to the page it opens, and where it is mounted', () {
    final entries = packageIframeEntriesV1(PackageCatalog.fromJson(catalog()));
    final entry = entries.single;
    expect(entry.entry.label, 'Applets');
    expect(entry.page.id, 'list');
    expect(entry.slot, 'frockbot.surface:list');
    expect(entry.surfaceId, 'package-page:applets:list');
    // The order a manifest names none takes.
    expect(entry.order, packageIframeEntryDefaultOrderV1);
  });

  test('an entry whose page is missing renders none rather than half', () {
    final json = catalog();
    ((json['contributions']! as List).first as Map)['entries'] = [
      {
        'id': 'open',
        'slot': 'frockbot.sidebar-actions',
        'label': 'Gone',
        'icon': 'applets',
        'opens': {'kind': 'surface', 'page': 'nowhere'},
      },
    ];
    expect(packageIframeEntriesV1(PackageCatalog.fromJson(json)), isEmpty);
  });

  test('the pages in one slot come back in mount order', () {
    final held = PackageCatalog.fromJson(catalog());
    expect(
      packageIframePagesForSlotV1(
        held,
        packageRightPanelSlotV1,
      ).map((mounted) => mounted.page.id),
      ['canvas'],
    );
    expect(
      packageIframePagesForSlotV1(held, packageBotSettingsSlotV1),
      isEmpty,
    );
  });

  test('Applets are available on a declared tool, never on a Package id', () {
    expect(PackageCatalog.fromJson(catalog()).appletsAvailable, isTrue);
    expect(
      PackageCatalog.fromJson(catalog(tools: const [])).appletsAvailable,
      isFalse,
    );
    expect(
      PackageCatalog.fromJson(catalog(tools: const []))
          .contributions
          .single
          .allowsFocus,
      isFalse,
    );
  });

  test('a page is served from the anonymous origin, by its hash', () {
    final held = PackageCatalog.fromJson(catalog());
    expect(
      held.pageUrl(held.contributions.single.pages.first),
      'https://ui.bot.frockbot.com/packages/${'a' * 64}.html',
    );
  });

  test('a page may only open its own origin', () {
    final held = PackageCatalog.fromJson(catalog());
    expect(held.allowsExternal('https://ui.bot.frockbot.com/x.html'), isTrue);
    expect(held.allowsExternal('https://bot.frockbot.com/'), isFalse);
    expect(held.allowsExternal('javascript:alert(1)'), isFalse);
  });

  test('provenance is said plainly, and first-party says nothing', () {
    String? label(String provenance) =>
        PackageCatalog.fromJson(catalog(provenance: provenance))
            .contributions
            .single
            .provenanceLabel;
    expect(label('Bot-authored'), 'Built by this Bot');
    expect(label('User-installed'), 'Added by you');
    expect(label('FrockBot'), isNull);
  });

  test('a catalog with no serving origin is refused whole', () {
    final json = catalog();
    json['artifactOrigin'] = '/packages';
    expect(
      () => PackageCatalog.fromJson(json),
      throwsA(isA<FormatException>()),
    );
  });
}
