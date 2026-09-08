import 'package:flutter/material.dart';

import '../protocol/client_wire.generated.dart' as wire;

/// The host regions a plugin may name. The plugin names a region; the host
/// decides what goes in it, which is what keeps `embed` from becoming an
/// escape hatch back into plugin-drawn chrome.
const appletViewerFrameV1 = 'applet-viewer';
const computerViewerFrameV1 = 'computer-viewer';

typedef ViewFrameBuilder = Widget Function(BuildContext context, String label);

/// A host-owned editor for one `field` node: the field as the document
/// described it, the value it holds now, and the sink the person's answer goes
/// to. The host supplies these; a plugin only names one by `choiceSource`.
typedef ViewFieldBuilder = Widget Function(
  BuildContext context,
  wire.SettingField field,
  String id,
  Object? value,

  /// Null when the field is not editable, or while a command is in flight.
  void Function(Object? value)? onChanged,
);

/// What a host has actually put in each named region, for the surface it is
/// under.
///
/// The Applet canvas and the Computer viewer are host chrome: they hold a
/// scoped viewer credential, which is minted per reader and can never be in a
/// document that may be read twice. So the region a plugin names is filled by
/// whatever host surface is above it, and by nothing at all elsewhere — which
/// is the same rule as before, with the reserved region as the default rather
/// than as the only answer.
class HostViewFrames extends InheritedWidget {
  final Map<String, WidgetBuilder> frames;
  const HostViewFrames({super.key, required this.frames, required super.child});

  static WidgetBuilder? lookup(BuildContext context, String name) => context
      .dependOnInheritedWidgetOfExactType<HostViewFrames>()
      ?.frames[name];

  @override
  bool updateShouldNotify(HostViewFrames old) => frames != old.frames;
}

Widget _hostFrame(
  BuildContext context,
  String name,
  String label,
  IconData icon,
  String detail,
) {
  final draw = HostViewFrames.lookup(context, name);
  return draw == null
      ? ViewRegion(label: label, icon: icon, detail: detail)
      : draw(context);
}

/// The two names a plugin may put an `embed` on. A name the host does not know
/// draws the unavailable region — never the plugin's idea of either.
final Map<String, ViewFrameBuilder> hostViewFramesV1 = Map.unmodifiable({
  appletViewerFrameV1: (context, label) => _hostFrame(
    context,
    appletViewerFrameV1,
    label,
    Icons.widgets_outlined,
    'The Applet viewer opens here.',
  ),
  computerViewerFrameV1: (context, label) => _hostFrame(
    context,
    computerViewerFrameV1,
    label,
    Icons.desktop_windows_outlined,
    'The Computer viewer opens here.',
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
