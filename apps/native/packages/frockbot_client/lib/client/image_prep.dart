/// A picked file made ready to send.
///
/// Photos are scaled on the device so the long edge is at most 2,048 pixels:
/// the model sees no more than that, and a phone photo is several times it.
/// The engine decodes the image — HEIC included, wherever the platform can —
/// and a JPEG is written back out; a PNG or a GIF stays a PNG so a
/// screenshot's transparency and sharp edges survive. Anything that is not an
/// image is sent exactly as it is, and the server decides what it is.
library;

import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import 'attachments.dart';

/// The longest edge a photo is sent at.
const int imageLongEdge = 2048;

/// An image under the edge but heavier than this is re-encoded anyway: a
/// 2,048-pixel photo is rarely more than a couple of megabytes as a JPEG.
const int imagePassThroughBytes = 4 * 1024 * 1024;

bool _starts(Uint8List bytes, List<int> prefix) {
  if (bytes.length < prefix.length) return false;
  for (var index = 0; index < prefix.length; index += 1) {
    if (bytes[index] != prefix[index]) return false;
  }
  return true;
}

String _ascii(Uint8List bytes, int start, int length) =>
    bytes.length < start + length
    ? ''
    : String.fromCharCodes(bytes.sublist(start, start + length));

/// What the first bytes say an image is, or null when they are not one.
String? sniffImageType(Uint8List bytes) {
  if (_starts(bytes, const [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (_starts(bytes, const [0xff, 0xd8, 0xff])) return 'image/jpeg';
  final gif = _ascii(bytes, 0, 6);
  if (gif == 'GIF87a' || gif == 'GIF89a') return 'image/gif';
  if (_ascii(bytes, 0, 4) == 'RIFF' && _ascii(bytes, 8, 4) == 'WEBP') {
    return 'image/webp';
  }
  if (_ascii(bytes, 4, 4) == 'ftyp' &&
      RegExp(r'^(heic|heix|hevc|heim|heis|mif1|msf1)$')
          .hasMatch(_ascii(bytes, 8, 4))) {
    return 'image/heic';
  }
  return null;
}

/// The media type a file's name suggests, for the upload's content type. The
/// server trusts the bytes over this; it is a hint for text and documents.
String mediaTypeForName(String name) {
  final dot = name.lastIndexOf('.');
  final extension = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return switch (extension) {
    'pdf' => 'application/pdf',
    'docx' =>
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx' =>
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'csv' => 'text/csv',
    'md' || 'markdown' => 'text/markdown',
    'json' => 'application/json',
    'png' => 'image/png',
    'jpg' || 'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'gif' => 'image/gif',
    'heic' || 'heif' => 'image/heic',
    _ => 'text/plain',
  };
}

String _renamed(String name, String extension) {
  final dot = name.lastIndexOf('.');
  final stem = dot <= 0 ? name : name.substring(0, dot);
  return '${stem.isEmpty ? 'image' : stem}.$extension';
}

/// The work that has to run off the UI thread: a JPEG written from pixels.
Uint8List encodeJpegV1(({int width, int height, Uint8List rgba}) input) {
  final image = img.Image.fromBytes(
    width: input.width,
    height: input.height,
    bytes: input.rgba.buffer,
    bytesOffset: input.rgba.offsetInBytes,
    numChannels: 4,
  );
  return img.encodeJpg(image, quality: 85);
}

/// Scales and re-encodes an image the way [PrepareUpload] promises.
Future<PreparedUpload> prepareUploadV1(PickedFile file) async {
  final sniffed = sniffImageType(file.bytes);
  final named = mediaTypeForName(file.name);
  final type =
      sniffed ??
      (named.startsWith('image/')
          ? named
          : (file.mediaType?.startsWith('image/') ?? false)
          ? file.mediaType!
          : null);
  if (type == null) {
    return PreparedUpload(
      name: file.name,
      mediaType: file.mediaType?.isNotEmpty == true && named == 'text/plain'
          ? file.mediaType!
          : named,
      bytes: file.bytes,
      isImage: false,
    );
  }
  final ui.ImageDescriptor descriptor;
  try {
    final buffer = await ui.ImmutableBuffer.fromUint8List(file.bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
  } catch (_) {
    throw PrepareFailure(
      type == 'image/heic'
          ? 'This device can’t read that HEIC photo. Send it as a JPEG.'
          : 'That image couldn’t be read.',
    );
  }
  try {
    final long = math.max(descriptor.width, descriptor.height);
    final convert = type == 'image/heic';
    if (!convert &&
        long <= imageLongEdge &&
        file.bytes.length <= imagePassThroughBytes) {
      return PreparedUpload(
        name: file.name,
        mediaType: type,
        bytes: file.bytes,
        isImage: true,
      );
    }
    final scale = long <= imageLongEdge ? 1.0 : imageLongEdge / long;
    final width = math.max(1, (descriptor.width * scale).round());
    final height = math.max(1, (descriptor.height * scale).round());
    final codec = await descriptor.instantiateCodec(
      targetWidth: width,
      targetHeight: height,
    );
    final frame = await codec.getNextFrame();
    final image = frame.image;
    try {
      final lossless = type == 'image/png' || type == 'image/gif';
      if (lossless) {
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        if (png == null) {
          throw const PrepareFailure('That image couldn’t be read.');
        }
        return PreparedUpload(
          name: _renamed(file.name, 'png'),
          mediaType: 'image/png',
          bytes: png.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes),
          isImage: true,
        );
      }
      final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (rgba == null) {
        throw const PrepareFailure('That image couldn’t be read.');
      }
      final jpeg = await compute(encodeJpegV1, (
        width: image.width,
        height: image.height,
        rgba: rgba.buffer.asUint8List(rgba.offsetInBytes, rgba.lengthInBytes),
      ));
      return PreparedUpload(
        name: _renamed(file.name, 'jpg'),
        mediaType: 'image/jpeg',
        bytes: jpeg,
        isImage: true,
      );
    } finally {
      image.dispose();
      codec.dispose();
    }
  } finally {
    descriptor.dispose();
  }
}
