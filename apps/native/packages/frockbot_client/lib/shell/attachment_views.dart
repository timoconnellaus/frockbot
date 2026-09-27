/// What the person attaches, as the composer and the thread draw it: the tray
/// above the field while files upload, and the files on a sent message.
library;

import 'dart:async';

import 'package:cross_file/cross_file.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pasteboard/pasteboard.dart';

import '../client/attachments.dart';
import '../theme/frock_theme.dart';
import 'semantics.dart';

/// The extensions the picker offers. The server decides what a file is from
/// its bytes; this only keeps the picker from offering what it would refuse.
const List<String> attachableExtensions = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', //
  'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'json', //
  'py', 'js', 'ts', 'tsx', 'jsx', 'dart', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'cs', 'rb', 'php', 'sh', 'sql', 'yaml', 'yml', 'toml',
  'xml', 'html', 'css', 'log',
];

/// Opens the system picker and answers with what was chosen, read into
/// memory. Nothing chosen is an empty list.
Future<List<PickedFile>> pickAttachments() async {
  final picked = await FilePicker.pickFiles(
    // A phone's own picker filters badly by extension, and the server refuses
    // what it cannot send with a sentence of its own.
    type: defaultTargetPlatform == TargetPlatform.android
        ? FileType.any
        : FileType.custom,
    allowedExtensions: defaultTargetPlatform == TargetPlatform.android
        ? null
        : attachableExtensions,
  );
  return [
    for (final file in picked)
      PickedFile(name: file.name, bytes: await file.readAsBytes()),
  ];
}

/// Files a drop or a paste handed over as `XFile`s, read into memory.
Future<List<PickedFile>> readDroppedFiles(Iterable<XFile> files) async => [
  for (final file in files)
    PickedFile(
      name: file.name,
      bytes: await file.readAsBytes(),
      mediaType: file.mimeType,
    ),
];

/// What the clipboard holds that is a file: files copied in the Finder or
/// the Explorer, or else a picture. Empty when it holds only words, which are
/// the text field's to paste.
Future<List<PickedFile>> readClipboardFiles() async {
  if (kIsWeb) return const [];
  try {
    final paths = await Pasteboard.files();
    if (paths.isNotEmpty) {
      return await readDroppedFiles([for (final path in paths) XFile(path)]);
    }
    final image = await Pasteboard.image;
    if (image != null && image.isNotEmpty) {
      return [
        PickedFile(
          name: 'Pasted image.png',
          bytes: image,
          mediaType: 'image/png',
        ),
      ];
    }
  } catch (_) {
    // A clipboard that cannot be read is a paste of words, or of nothing.
  }
  return const [];
}

IconData _documentIcon(String name, String? mediaType) {
  final type = mediaType ?? '';
  final lower = name.toLowerCase();
  if (type == 'application/pdf' || lower.endsWith('.pdf')) {
    return Icons.picture_as_pdf_outlined;
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.csv')) {
    return Icons.table_chart_outlined;
  }
  if (lower.endsWith('.pptx')) return Icons.slideshow_outlined;
  return Icons.description_outlined;
}

/// The files attached to the draft, above the field: a thumbnail for a
/// picture, a card for a document, each with its own way out and, when it
/// failed, its own sentence.
class AttachmentTrayView extends StatelessWidget {
  final AttachmentTray tray;
  const AttachmentTrayView({super.key, required this.tray});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failures = [
      for (final item in tray.items)
        if (item.failed && item.error != null) item,
    ];
    return identified(
      ShellIds.attachmentTray,
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final item in tray.items)
                  identified(
                    ShellIds.attachment(item.id),
                    _TrayItem(
                      key: ValueKey(item.id),
                      item: item,
                      onRemove: () => tray.remove(item.id),
                      onRetry: item.failed && item.source != null
                          ? () => tray.retry(item.id)
                          : null,
                    ),
                  ),
              ],
            ),
            for (final item in failures)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '${item.name}: ${item.error}',
                  key: ValueKey('attachment-error-${item.id}'),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _TrayItem extends StatelessWidget {
  final ComposerAttachment item;
  final VoidCallback onRemove;
  final VoidCallback? onRetry;
  const _TrayItem({
    super.key,
    required this.item,
    required this.onRemove,
    this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final border = Border.all(
      color: item.failed ? scheme.error : FrockTheme.hairline(scheme),
    );
    final preview = item.preview;
    final status = switch (item.status) {
      AttachmentStatus.preparing => 'Preparing…',
      AttachmentStatus.uploading => 'Uploading…',
      AttachmentStatus.failed => 'Couldn’t attach',
      AttachmentStatus.ready => attachmentSizeLabel(item.size),
    };
    final body = preview != null
        ? SizedBox(
            width: 64,
            height: 64,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.memory(
                preview,
                fit: BoxFit.cover,
                gaplessPlayback: true,
                errorBuilder: (_, _, _) => const Icon(Icons.image_outlined),
              ),
            ),
          )
        : SizedBox(
            width: 188,
            height: 64,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 28, 8),
              child: Row(
                children: [
                  Icon(
                    item.isImage
                        ? Icons.image_outlined
                        : _documentIcon(item.name, item.uploaded?.mediaType),
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelMedium,
                        ),
                        Text(
                          status,
                          maxLines: 1,
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: item.failed
                                ? scheme.error
                                : scheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          );
    return Semantics(
      label: '${item.name}, $status',
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          GestureDetector(
            onTap: onRetry,
            child: Container(
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
                border: border,
              ),
              child: body,
            ),
          ),
          if (item.working)
            Positioned.fill(
              child: IgnorePointer(
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      value: MediaQuery.disableAnimationsOf(context)
                          ? 0.75
                          : null,
                    ),
                  ),
                ),
              ),
            ),
          if (item.failed && preview != null)
            Positioned.fill(
              child: IgnorePointer(
                child: Center(
                  child: Icon(Icons.refresh_rounded, color: scheme.error),
                ),
              ),
            ),
          Positioned(
            top: -6,
            right: -6,
            child: Material(
              color: scheme.surfaceContainerHigh,
              shape: const CircleBorder(),
              child: InkWell(
                key: ValueKey('attachment-remove-${item.id}'),
                customBorder: const CircleBorder(),
                onTap: onRemove,
                child: Tooltip(
                  message: 'Remove ${item.name}',
                  child: const Padding(
                    padding: EdgeInsets.all(3),
                    child: Icon(Icons.close_rounded, size: 14),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The files on a message the person sent: pictures as pictures, documents
/// as cards naming them.
class MessageAttachmentsView extends StatelessWidget {
  final List<MessageAttachment> attachments;

  /// Reads an image's bytes. Absent, a picture is drawn as a card.
  final Future<Uint8List> Function(MessageAttachment attachment)? load;
  const MessageAttachmentsView({
    super.key,
    required this.attachments,
    this.load,
  });

  @override
  Widget build(BuildContext context) => Wrap(
    alignment: WrapAlignment.end,
    spacing: 6,
    runSpacing: 6,
    children: [
      for (final attachment in attachments)
        attachment.isImage && load != null
            ? _MessageImage(
                key: ValueKey(attachment.uploadId),
                attachment: attachment,
                load: load!,
              )
            : _MessageDocument(attachment: attachment),
    ],
  );
}

class _MessageDocument extends StatelessWidget {
  final MessageAttachment attachment;
  const _MessageDocument({required this.attachment});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      constraints: const BoxConstraints(maxWidth: 260),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: FrockTheme.hairline(scheme)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            attachment.isImage
                ? Icons.image_outlined
                : _documentIcon(attachment.name, attachment.mediaType),
            size: 20,
            color: scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  attachment.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelMedium,
                ),
                Text(
                  attachmentSizeLabel(attachment.bytes),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageImage extends StatefulWidget {
  final MessageAttachment attachment;
  final Future<Uint8List> Function(MessageAttachment attachment) load;
  const _MessageImage({
    super.key,
    required this.attachment,
    required this.load,
  });

  @override
  State<_MessageImage> createState() => _MessageImageState();
}

class _MessageImageState extends State<_MessageImage> {
  late Future<Uint8List> _bytes = widget.load(widget.attachment);

  @override
  void didUpdateWidget(_MessageImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.attachment != widget.attachment) {
      _bytes = widget.load(widget.attachment);
    }
  }

  void _open(Uint8List bytes) {
    unawaited(
      showDialog<void>(
        context: context,
        builder: (context) => Dialog(
          insetPadding: const EdgeInsets.all(16),
          clipBehavior: Clip.antiAlias,
          child: Stack(
            children: [
              InteractiveViewer(
                maxScale: 6,
                child: Image.memory(bytes, fit: BoxFit.contain),
              ),
              Positioned(
                top: 8,
                right: 8,
                child: IconButton.filledTonal(
                  tooltip: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snapshot) {
        final bytes = snapshot.data;
        final child = bytes == null
            ? Center(
                child: snapshot.hasError
                    ? Icon(Icons.broken_image_outlined, color: scheme.error)
                    : const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
              )
            : Image.memory(
                bytes,
                fit: BoxFit.cover,
                gaplessPlayback: true,
                errorBuilder: (_, _, _) =>
                    Icon(Icons.broken_image_outlined, color: scheme.error),
              );
        return Semantics(
          image: true,
          label: widget.attachment.name,
          button: bytes != null,
          child: GestureDetector(
            onTap: bytes == null ? null : () => _open(bytes),
            child: Container(
              width: 180,
              height: 180,
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(14),
              ),
              child: child,
            ),
          ),
        );
      },
    );
  }
}
