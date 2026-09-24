/// Files the person attaches to a message, from the moment they are chosen to
/// the moment the message that carries them is sent.
///
/// A file is uploaded as soon as it is attached, not when Send is pressed:
/// the upload route admits the bytes durably and answers with their hash,
/// and the message names that hash. So by the time a message is sent, every
/// file in it is already the Bot's, and Send only ever carries references.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

/// Most files one message carries. The server's rule; the tray enforces it
/// first so the person is told before anything is sent.
const int attachmentLimit = 5;

/// The largest file an upload may be.
const int uploadMaxBytes = 20 * 1024 * 1024;

/// A file already uploaded to a Bot: what a message names and a Run carries.
@immutable
class MessageAttachment {
  final String uploadId;
  final String kind;
  final String name;
  final String mediaType;
  final int bytes;
  const MessageAttachment({
    required this.uploadId,
    required this.kind,
    required this.name,
    required this.mediaType,
    required this.bytes,
  });

  bool get isImage => kind == 'image';

  Map<String, Object?> toJson() => {
    'uploadId': uploadId,
    'kind': kind,
    'name': name,
    'mediaType': mediaType,
    'bytes': bytes,
  };

  /// One attachment, or null for anything that is not one. The wire decoder
  /// has already validated what the server sent; this also reads what this
  /// client stored itself.
  static MessageAttachment? decode(Object? value) {
    if (value is! Map) return null;
    final uploadId = value['uploadId'];
    final kind = value['kind'];
    final name = value['name'];
    final mediaType = value['mediaType'];
    final bytes = value['bytes'];
    if (uploadId is! String ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(uploadId) ||
        (kind != 'image' && kind != 'document') ||
        name is! String ||
        mediaType is! String ||
        bytes is! num) {
      return null;
    }
    return MessageAttachment(
      uploadId: uploadId,
      kind: kind as String,
      name: name,
      mediaType: mediaType,
      bytes: bytes.toInt(),
    );
  }

  static List<MessageAttachment> decodeList(Object? value) => [
    if (value is List)
      for (final item in value) ?decode(item),
  ];

  @override
  bool operator ==(Object other) =>
      other is MessageAttachment && other.uploadId == uploadId;

  @override
  int get hashCode => uploadId.hashCode;
}

/// `1.2 MB`, `340 KB`: how big a file is, the way the thread says it.
String attachmentSizeLabel(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(bytes / 1024).ceil().clamp(1, 1024)} KB';
}

/// A file as the picker, a drop or a paste hands it over.
@immutable
class PickedFile {
  final String name;
  final Uint8List bytes;

  /// What the platform said it is, where it said anything.
  final String? mediaType;
  const PickedFile({required this.name, required this.bytes, this.mediaType});
}

/// Where uploads go and come back from.
abstract interface class UploadTransport {
  /// Admits one file's bytes to a Bot, answering with the reference a
  /// message names it by. Refusals carry the server's own sentence.
  Future<MessageAttachment> upload(
    String botId, {
    required String name,
    required String mediaType,
    required Uint8List bytes,
  });

  /// An uploaded file's bytes, for a thumbnail or a closer look.
  Future<Uint8List> download(String botId, String uploadId);
}

enum AttachmentStatus { preparing, uploading, ready, failed }

/// One file in the tray above the composer.
class ComposerAttachment {
  final String id;
  final String name;
  final PickedFile? source;
  AttachmentStatus status;
  String? error;

  /// The image as it will be sent, drawn as the tray's thumbnail.
  Uint8List? preview;
  MessageAttachment? uploaded;
  ComposerAttachment({
    required this.id,
    required this.name,
    this.source,
    this.status = AttachmentStatus.preparing,
    this.error,
    this.preview,
    this.uploaded,
  });

  bool get working =>
      status == AttachmentStatus.preparing ||
      status == AttachmentStatus.uploading;
  bool get failed => status == AttachmentStatus.failed;
  int get size => uploaded?.bytes ?? source?.bytes.length ?? 0;
  bool get isImage =>
      uploaded?.isImage ??
      (preview != null || (source?.mediaType ?? '').startsWith('image/'));
}

/// What a picked file becomes before it is sent: a photo scaled to 2,048
/// pixels and re-encoded, HEIC converted, anything else as it is.
typedef PrepareUpload = Future<PreparedUpload> Function(PickedFile file);

@immutable
class PreparedUpload {
  final String name;
  final String mediaType;
  final Uint8List bytes;
  final bool isImage;
  const PreparedUpload({
    required this.name,
    required this.mediaType,
    required this.bytes,
    required this.isImage,
  });
}

/// A file the device could not turn into something sendable. The message is
/// the person's sentence.
class PrepareFailure implements Exception {
  final String message;
  const PrepareFailure(this.message);
  @override
  String toString() => message;
}

/// The files attached to one Bot's draft, and their uploads.
///
/// Belongs to the Bot, like the draft: switching away and back keeps them,
/// and a refused send hands its files back here.
class AttachmentTray extends ChangeNotifier {
  final Future<MessageAttachment> Function({
    required String name,
    required String mediaType,
    required Uint8List bytes,
  })
  upload;
  final PrepareUpload prepare;
  AttachmentTray({required this.upload, required this.prepare});

  final List<ComposerAttachment> _items = [];
  int _next = 0;
  bool _disposed = false;

  List<ComposerAttachment> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;

  /// Something is still being read or uploaded, so Send waits for it.
  bool get busy => _items.any((item) => item.working);

  /// The files that will go with the message.
  List<MessageAttachment> get ready => [
    for (final item in _items)
      if (item.status == AttachmentStatus.ready && item.uploaded != null)
        item.uploaded!,
  ];

  int get room => attachmentLimit - _items.length;

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// Attaches files and starts their uploads. Answers with a sentence when
  /// some of them could not be attached at all.
  String? add(Iterable<PickedFile> files) {
    final picked = files.toList();
    if (picked.isEmpty) return null;
    var refused = 0;
    for (final file in picked) {
      if (room <= 0) {
        refused += 1;
        continue;
      }
      final item = ComposerAttachment(
        id: 'attachment-${_next++}',
        name: file.name,
        source: file,
      );
      _items.add(item);
      if (file.bytes.isEmpty) {
        item
          ..status = AttachmentStatus.failed
          ..error = 'That file is empty.';
        continue;
      }
      unawaited(_start(item));
    }
    _changed();
    if (refused == 0) return null;
    return 'A message can carry $attachmentLimit files. '
        '${refused == 1 ? 'One was' : '$refused were'} left out.';
  }

  Future<void> _start(ComposerAttachment item) async {
    final source = item.source;
    if (source == null) return;
    item
      ..status = AttachmentStatus.preparing
      ..error = null;
    _changed();
    try {
      final prepared = await prepare(source);
      if (!_items.contains(item)) return;
      if (prepared.bytes.length > uploadMaxBytes) {
        throw PrepareFailure(
          'That file is larger than ${uploadMaxBytes ~/ (1024 * 1024)} MB.',
        );
      }
      if (prepared.isImage) item.preview = prepared.bytes;
      item.status = AttachmentStatus.uploading;
      _changed();
      final uploaded = await upload(
        name: prepared.name,
        mediaType: prepared.mediaType,
        bytes: prepared.bytes,
      );
      if (!_items.contains(item)) return;
      // The same file attached twice is one file.
      if (_items.any(
        (other) =>
            other != item && other.uploaded?.uploadId == uploaded.uploadId,
      )) {
        _items.remove(item);
      } else {
        item
          ..uploaded = uploaded
          ..status = AttachmentStatus.ready;
      }
    } catch (error) {
      if (!_items.contains(item)) return;
      item
        ..status = AttachmentStatus.failed
        ..error = error is PrepareFailure
            ? error.message
            : error.toString().isEmpty
            ? 'That file couldn’t be attached.'
            : error.toString();
    }
    _changed();
  }

  void remove(String id) {
    _items.removeWhere((item) => item.id == id);
    _changed();
  }

  /// Tries a failed file again.
  void retry(String id) {
    for (final item in _items) {
      if (item.id == id && item.failed && item.source != null) {
        unawaited(_start(item));
      }
    }
  }

  /// The files that go with a message, taken out of the tray. What failed
  /// goes too: the person was told, and it is not part of what they sent.
  List<MessageAttachment> take() {
    final taken = ready;
    _items.clear();
    _changed();
    return taken;
  }

  /// Hands a refused message's files back, ahead of anything attached since.
  void restore(
    List<MessageAttachment> attachments, {
    Uint8List? Function(String uploadId)? preview,
  }) {
    if (attachments.isEmpty) return;
    final kept = [
      for (final attachment in attachments)
        if (!_items.any((item) => item.uploaded == attachment))
          ComposerAttachment(
            id: 'attachment-${_next++}',
            name: attachment.name,
            status: AttachmentStatus.ready,
            uploaded: attachment,
            preview: preview?.call(attachment.uploadId),
          ),
    ];
    _items.insertAll(0, kept);
    while (_items.length > attachmentLimit) {
      _items.removeLast();
    }
    _changed();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
