/// Declarative Package entries, and the pages they open.
///
/// A port of `app/shell/client/package-iframe-entries.ts` over the catalog
/// `/api/bots/:botId/package-ui` answers. An entry is manifest data — an id, a
/// label, an icon name and the page it opens — so a Package puts a control in
/// the shell without shipping a line of code into the app, and nothing here
/// executes Package code.
library;

import '../client/transport.dart';

/// The tool name that carries the Applet focus capability. Focus belongs to
/// the Package that owns the Applet tools and to no other.
const packageIframeFocusToolV2 = 'applet_focus';

/// The host state name that carries the Applets feed to a v2 page.
const packageIframeAppletsStateV2 = 'applets';

/// Slots the shell draws. A page mounts into one; an entry sits in the third.
const packageRightPanelSlotV1 = 'frockbot.right-panel';
const packageBotSettingsSlotV1 = 'frockbot.bot-settings-sections';
const packageSidebarActionsSlotV1 = 'frockbot.sidebar-actions';

String packageIframePageSlotV1(String pageId) => 'frockbot.surface:$pageId';

String packageIframeSurfaceIdV1(String packageId, String pageId) =>
    'package-page:$packageId:$pageId';

/// The order a Package entry takes when its manifest names none.
const packageIframeEntryDefaultOrderV1 = 50;

class PackagePage {
  final String id;
  final String contentHash;
  final List<({String slot, int order})> mounts;
  const PackagePage({
    required this.id,
    required this.contentHash,
    required this.mounts,
  });
}

class PackageEntry {
  final String id;
  final String label;
  final String icon;
  final int? order;

  /// The page id this entry opens.
  final String page;
  const PackageEntry({
    required this.id,
    required this.label,
    required this.icon,
    required this.page,
    this.order,
  });
}

class PackageContribution {
  final String packageId;
  final String displayName;

  /// How the shell attributes the page. `FrockBot` is first-party: it ships in
  /// the deployment rather than as a Composition member.
  final String provenance;
  final List<PackagePage> pages;
  final List<PackageEntry> entries;
  final List<String> declaredTools;
  const PackageContribution({
    required this.packageId,
    required this.displayName,
    required this.provenance,
    required this.pages,
    required this.entries,
    required this.declaredTools,
  });

  /// Where a page came from, said plainly. First-party pages say nothing.
  String? get provenanceLabel => switch (provenance) {
    'Bot-authored' => 'Built by this Bot',
    'User-installed' => 'Added by you',
    _ => null,
  };

  bool allowsTool(String name) => declaredTools.contains(name);
  bool get allowsFocus => allowsTool(packageIframeFocusToolV2);
}

class PackageCatalog {
  final String botId;

  /// Separate, anonymous serving origin; artifact paths are appended by the
  /// host. Never the app's own origin.
  final String artifactOrigin;
  final List<PackageContribution> contributions;
  const PackageCatalog({
    required this.botId,
    required this.artifactOrigin,
    required this.contributions,
  });

  static const empty = PackageCatalog(
    botId: '',
    artifactOrigin: '',
    contributions: [],
  );

  factory PackageCatalog.fromJson(Object? value) {
    final json = (value as Map).cast<String, Object?>();
    final origin = Uri.parse(json['artifactOrigin']! as String);
    if (!origin.isAbsolute || origin.host.isEmpty) {
      throw const FormatException('Invalid artifact origin');
    }
    return PackageCatalog(
      botId: json['botId']! as String,
      artifactOrigin: json['artifactOrigin']! as String,
      contributions: [
        for (final entry in (json['contributions']! as List).cast<Map>())
          PackageContribution(
            packageId: entry['packageId']! as String,
            displayName: entry['displayName']! as String,
            provenance: entry['provenance']! as String,
            declaredTools: [
              for (final tool in (entry['declaredTools']! as List))
                tool! as String,
            ],
            pages: [
              for (final page in (entry['pages']! as List).cast<Map>())
                PackagePage(
                  id: page['id']! as String,
                  contentHash:
                      ((page['artifact']! as Map)['contentHash'])! as String,
                  mounts: [
                    for (final mount in (page['mounts']! as List).cast<Map>())
                      (
                        slot: mount['slot']! as String,
                        order: (mount['order'] as num?)?.toInt() ?? 0,
                      ),
                  ],
                ),
            ],
            entries: [
              for (final item in (entry['entries']! as List).cast<Map>())
                PackageEntry(
                  id: item['id']! as String,
                  label: item['label']! as String,
                  icon: item['icon']! as String,
                  order: (item['order'] as num?)?.toInt(),
                  page: ((item['opens']! as Map)['page'])! as String,
                ),
            ],
          ),
      ],
    );
  }

  /// The URL the anonymous page origin serves one page at.
  String pageUrl(PackagePage page) =>
      '$artifactOrigin/packages/${page.contentHash}.html';

  /// Whether this Bot's Composition has Applets in it at all.
  ///
  /// Derived from manifest facts — a Package declaring the Applet focus tool —
  /// never from a Package id. A deployment or a User without Applets has no
  /// Applet routes, and the shell must not ask for them: an absent capability
  /// is silence, not a failed request.
  bool get appletsAvailable =>
      contributions.any((contribution) => contribution.allowsFocus);

  /// The one origin a page may hand the host to open. A page is served from
  /// the anonymous artifact origin and has no business steering the reader
  /// anywhere else, so anything else is refused rather than sanitized.
  bool allowsExternal(String url) {
    final target = Uri.tryParse(url);
    final origin = Uri.tryParse(artifactOrigin);
    if (target == null || origin == null) return false;
    return target.scheme == origin.scheme &&
        target.host == origin.host &&
        target.port == origin.port;
  }
}

/// One entry, resolved against the page it opens.
class PackageEntryPage {
  final PackageContribution contribution;
  final PackageEntry entry;
  final PackagePage page;
  final String slot;
  final String surfaceId;
  final int order;
  const PackageEntryPage({
    required this.contribution,
    required this.entry,
    required this.page,
    required this.slot,
    required this.surfaceId,
    required this.order,
  });
}

/// Every entry the Bot's active Composition declares, in the order the shell
/// draws them. Ties break on Package id, then entry id, so two Packages asking
/// for the same order draw in a stable sequence rather than in catalog order.
List<PackageEntryPage> packageIframeEntriesV1(PackageCatalog? catalog) {
  final entries = <PackageEntryPage>[];
  for (final contribution
      in catalog?.contributions ?? const <PackageContribution>[]) {
    for (final entry in contribution.entries) {
      // The catalog decoder already refuses an entry whose page does not mount
      // its own surface slot; this keeps the projection total anyway, because
      // a shell that renders half an entry is worse than one that renders none.
      final page = contribution.pages
          .where((candidate) => candidate.id == entry.page)
          .firstOrNull;
      if (page == null) continue;
      entries.add(
        PackageEntryPage(
          contribution: contribution,
          entry: entry,
          page: page,
          slot: packageIframePageSlotV1(page.id),
          surfaceId: packageIframeSurfaceIdV1(contribution.packageId, page.id),
          order: entry.order ?? packageIframeEntryDefaultOrderV1,
        ),
      );
    }
  }
  entries.sort((left, right) {
    final byOrder = left.order.compareTo(right.order);
    if (byOrder != 0) return byOrder;
    final byPackage = left.contribution.packageId.compareTo(
      right.contribution.packageId,
    );
    return byPackage != 0 ? byPackage : left.entry.id.compareTo(right.entry.id);
  });
  return entries;
}

/// One mounted page: which Package's, and where it sits among the slot's
/// other fillers.
class PackageSlotPage {
  final PackageContribution contribution;
  final PackagePage page;
  final int order;
  const PackageSlotPage(this.contribution, this.page, this.order);
}

/// The pages mounted in one slot, in mount order. The right panel and Bot
/// settings both read their pages this way.
List<PackageSlotPage> packageIframePagesForSlotV1(
  PackageCatalog? catalog,
  String slot,
) {
  final pages = <PackageSlotPage>[];
  for (final contribution
      in catalog?.contributions ?? const <PackageContribution>[]) {
    for (final page in contribution.pages) {
      for (final mount in page.mounts) {
        if (mount.slot == slot) {
          pages.add(PackageSlotPage(contribution, page, mount.order));
        }
      }
    }
  }
  pages.sort((left, right) {
    final byOrder = left.order.compareTo(right.order);
    return byOrder != 0
        ? byOrder
        : left.contribution.packageId.compareTo(right.contribution.packageId);
  });
  return pages;
}

/// Reads the catalog. A deployment without Package UI answers with none, and
/// the shell draws nothing rather than an error over the conversation.
Future<PackageCatalog?> readPackageCatalogV1(
  NativeApi api,
  String botId,
) async {
  try {
    return PackageCatalog.fromJson(
      await api.request('/api/bots/${Uri.encodeComponent(botId)}/package-ui'),
    );
  } catch (_) {
    return null;
  }
}

/// Runs one tool a page asked for, through the route that checks the
/// Composition generation before it will run it.
Future<Object?> callPackageToolV1(
  NativeApi api,
  String botId,
  String packageId,
  String name,
  Object? input,
) => api.request(
  '/api/bots/${Uri.encodeComponent(botId)}/package-ui/tools',
  body: {
    'schemaVersion': 1,
    'commandId': randomId(),
    'packageId': packageId,
    'name': name,
    'input': input,
  },
);
