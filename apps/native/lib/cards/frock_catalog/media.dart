/// The media family: pictures, files and links.
///
/// Every one of these can be pressed, and none of them raises a card action:
/// opening a link is the host's business, so it goes through `links.dart` and
/// costs the Bot no Turn and the surface no revision. A press that the *Bot*
/// should hear about is a `Button` with an action name, which is a different
/// thing and lives in `actions.md`.
library;

import 'package:flutter/material.dart';
import 'package:genui/genui.dart';

import '../../theme/frock_theme.dart';
import 'common.dart';
import 'links.dart';

/// The rows of a gallery, with anything that is not an https picture dropped.
List<Map<String, Object?>> _images(Object? value) => [
  for (final image in frockRows(value, max: 8))
    if ((frockString(image['url']) ?? '').startsWith('https://')) image,
];

/// Several pictures in one component.
final frockImageGallery = CatalogItem(
  name: 'ImageGallery',
  dataSchema: frockSchemaOf('ImageGallery'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    return FrockImageGalleryView(images: _images(data['images']));
  },
);

class FrockImageGalleryView extends StatelessWidget {
  final List<Map<String, Object?>> images;
  const FrockImageGalleryView({super.key, required this.images});

  /// The picture, at whatever size the place it is drawn in asks for. The
  /// `alt` text is the Semantics label, so a card's pictures are readable the
  /// way the rest of the app's are.
  Widget _picture(BuildContext context, Map<String, Object?> image) {
    final theme = Theme.of(context);
    return Semantics(
      image: true,
      label: frockString(image['alt']) ?? frockString(image['caption']) ?? '',
      child: Image.network(
        frockString(image['url'])!,
        fit: BoxFit.cover,
        // A picture that will not load is a picture-shaped hole, not a broken
        // card: the rest of the surface is still worth reading.
        errorBuilder: (context, error, stack) => Container(
          color: theme.colorScheme.surface,
          alignment: Alignment.center,
          child: Icon(
            Icons.broken_image_outlined,
            size: 20,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        loadingBuilder: (context, child, progress) => progress == null
            ? child
            : Container(color: theme.colorScheme.surface),
      ),
    );
  }

  void _open(BuildContext context, Map<String, Object?> image) {
    showDialog<void>(
      context: context,
      builder: (context) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        backgroundColor: Colors.transparent,
        child: GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(FrockTheme.radiusCard),
            child: _picture(context, image),
          ),
        ),
      ),
    );
  }

  Widget _tile(
    BuildContext context,
    Map<String, Object?> image, {
    required double? width,
  }) {
    final theme = Theme.of(context);
    final caption = frockString(image['caption']);
    return SizedBox(
      width: width,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
            child: AspectRatio(
              aspectRatio: 4 / 3,
              child: InkWell(
                onTap: () => _open(context, image),
                child: _picture(context, image),
              ),
            ),
          ),
          if (caption != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                caption,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (images.isEmpty) return const SizedBox.shrink();
    // One picture is the card's picture and takes the width. Several are a
    // strip: a grid of thumbnails at phone width makes every picture too small
    // to be worth drawing, and the strip keeps them all the same size.
    if (images.length == 1) {
      return _tile(context, images.first, width: null);
    }
    return SizedBox(
      height: 168,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: images.length,
        separatorBuilder: (context, index) => const SizedBox(width: 8),
        itemBuilder: (context, index) =>
            _tile(context, images[index], width: 180),
      ),
    );
  }
}

/// What the host draws each kind of file as.
IconData frockFileIconV1(String? kind) => switch (kind) {
  'document' => Icons.description_outlined,
  'spreadsheet' => Icons.grid_on_outlined,
  'image' => Icons.image_outlined,
  'audio' => Icons.graphic_eq,
  'video' => Icons.movie_outlined,
  'archive' => Icons.folder_zip_outlined,
  'code' => Icons.code,
  _ => Icons.insert_drive_file_outlined,
};

/// A file the card is about.
final frockFileAttachment = CatalogItem(
  name: 'FileAttachment',
  dataSchema: frockSchemaOf('FileAttachment'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final url = frockString(data['url']);
    final openable = url != null && url.startsWith('https://');
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
        border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
      ),
      child: Row(
        children: [
          Icon(
            frockFileIconV1(frockString(data['kind'])),
            size: 20,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  frockString(data['name']) ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium,
                ),
                if (data['detail'] != null)
                  FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['detail'],
                    maxLines: 1,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
          ),
          if (openable)
            TextButton(
              onPressed: () => frockOpenLinkV1(url),
              child: const Text('Open'),
            ),
        ],
      ),
    );
  },
);

/// One link, with enough of what is behind it to decide by.
final frockLinkPreview = CatalogItem(
  name: 'LinkPreview',
  dataSchema: frockSchemaOf('LinkPreview'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    final url = frockString(data['url']) ?? '';
    final image = frockString(data['imageUrl']);
    final site =
        [
          frockString(data['site']),
          Uri.tryParse(url)?.host,
        ].firstWhere((it) => it != null && it.isNotEmpty, orElse: () => null) ??
        'the web';
    return InkWell(
      onTap: url.startsWith('https://') ? () => frockOpenLinkV1(url) : null,
      borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
          border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (image != null && image.startsWith('https://')) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: SizedBox(
                  width: 56,
                  height: 56,
                  child: Image.network(
                    image,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stack) =>
                        Container(color: theme.colorScheme.surface),
                  ),
                ),
              ),
              const SizedBox(width: 10),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    site,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  FrockBoundText(
                    dataContext: itemContext.dataContext,
                    value: data['title'],
                    maxLines: 2,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (data['description'] != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: FrockBoundText(
                        dataContext: itemContext.dataContext,
                        value: data['description'],
                        maxLines: 2,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Icon(
              Icons.open_in_new,
              size: 16,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  },
);

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockMediaItemsV1 = List.unmodifiable([
  frockImageGallery,
  frockFileAttachment,
  frockLinkPreview,
]);
