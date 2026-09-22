/// The person's face: a photo when we have one, otherwise their initials.
library;

import 'package:flutter/material.dart';

import '../theme/initials.dart';

export '../theme/initials.dart' show personInitialsV1;

/// One person's avatar. A https photo wins; initials stand in for a name
/// with no picture.
class PersonAvatar extends StatelessWidget {
  final String name;
  final String? imageUrl;
  final double size;
  const PersonAvatar({
    super.key,
    required this.name,
    this.imageUrl,
    this.size = 32,
  });

  String get _letters => personInitialsV1(name);

  Uri? get _photo {
    final url = imageUrl?.trim();
    if (url == null || url.isEmpty) return null;
    final parsed = Uri.tryParse(url);
    if (parsed == null || parsed.scheme != 'https') return null;
    return parsed;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final photo = _photo;
    return ClipOval(
      child: Container(
        width: size,
        height: size,
        color: theme.colorScheme.primary.withValues(alpha: 0.16),
        alignment: Alignment.center,
        child: photo == null
            ? _initials(theme)
            : Image.network(
                photo.toString(),
                width: size,
                height: size,
                fit: BoxFit.cover,
                errorBuilder: (context, error, stack) => _initials(theme),
              ),
      ),
    );
  }

  Widget _initials(ThemeData theme) => Text(
    _letters,
    style: theme.textTheme.labelMedium?.copyWith(
      color: theme.colorScheme.primary,
      fontWeight: FontWeight.w600,
      fontSize: size * 0.38,
      letterSpacing: -0.2,
      height: 1,
    ),
  );
}
