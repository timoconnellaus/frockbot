import 'package:flutter/material.dart';

import 'frock_theme.dart';

/// Host-owned empty and failure states, also usable when every extension fails.
class FrockEmptyState extends StatelessWidget {
  final String title;
  final String detail;
  final String action;
  final VoidCallback onAction;
  final IconData? icon;
  const FrockEmptyState({
    super.key,
    required this.title,
    required this.detail,
    required this.action,
    required this.onAction,
    this.icon,
  });

  @override
  Widget build(BuildContext context) => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(32),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (icon == null)
              const SheepAvatar(size: 64)
            else
              Icon(
                icon,
                size: 40,
                color: Theme.of(context).colorScheme.primary,
              ),
            const SizedBox(height: 24),
            Text(title, style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 12),
            Text(
              detail,
              style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(onPressed: onAction, child: Text(action)),
          ],
        ),
      ),
    ),
  );
}

class FrockLoading extends StatelessWidget {
  final String label;
  const FrockLoading({super.key, required this.label});
  @override
  Widget build(BuildContext context) => Semantics(
    label: label,
    liveRegion: true,
    child: const Padding(
      padding: EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FrockSkeleton(width: 180, height: 20),
          SizedBox(height: 24),
          FrockSkeleton(height: 64),
          SizedBox(height: 12),
          FrockSkeleton(height: 64),
        ],
      ),
    ),
  );
}
