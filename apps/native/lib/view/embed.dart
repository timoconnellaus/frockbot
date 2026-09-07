import 'package:flutter/material.dart';

/// The host regions a plugin may name. The plugin names a region; the host
/// decides what goes in it, which is what keeps `embed` from becoming an
/// escape hatch back into plugin-drawn chrome.
const appletViewerFrameV1 = 'applet-viewer';
const computerViewerFrameV1 = 'computer-viewer';

typedef ViewFrameBuilder = Widget Function(BuildContext context, String label);

/// Both names exist now; their widgets arrive with the surfaces that own them.
/// Until then they draw the reserved region, and a name the host does not know
/// draws the unavailable one — never the plugin's idea of either.
final Map<String, ViewFrameBuilder> hostViewFramesV1 = Map.unmodifiable({
  appletViewerFrameV1: (context, label) => ViewRegion(
    label: label,
    icon: Icons.widgets_outlined,
    detail: 'The Applet viewer opens here.',
  ),
  computerViewerFrameV1: (context, label) => ViewRegion(
    label: label,
    icon: Icons.desktop_windows_outlined,
    detail: 'The Computer viewer opens here.',
  ),
});

/// A host-drawn region: the host's border, the host's words, no plugin pixels.
class ViewRegion extends StatelessWidget {
  final String label;
  final String detail;
  final IconData icon;
  final double aspectRatio;
  const ViewRegion({
    super.key,
    required this.label,
    required this.detail,
    required this.icon,
    this.aspectRatio = 16 / 9,
  });

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AspectRatio(
      aspectRatio: aspectRatio,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: scheme.outlineVariant),
        ),
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, color: scheme.onSurfaceVariant),
                const SizedBox(height: 12),
                Text(label, style: Theme.of(context).textTheme.labelLarge),
                const SizedBox(height: 4),
                Text(
                  detail,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
