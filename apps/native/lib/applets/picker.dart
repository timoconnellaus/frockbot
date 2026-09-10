import 'package:flutter/material.dart';

import 'canvas.dart';
import '../shell/semantics.dart';

class AppletPicker extends StatefulWidget {
  final AppletCanvasController controller;
  const AppletPicker({super.key, required this.controller});

  @override
  State<AppletPicker> createState() => _AppletPickerState();
}

class _AppletPickerState extends State<AppletPicker> {
  String? deleting;
  String? error;

  @override
  void initState() {
    super.initState();
    widget.controller.load();
  }

  Future<void> remove(String id, String name) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete $name?'),
        content: const Text(
          'This permanently deletes its data and versions for all your Bots. This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      deleting = id;
      error = null;
    });
    try {
      final controller = widget.controller;
      await controller.applets.delete(id);
      await controller.load();
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Couldn’t delete this Applet. Try again.');
      }
    } finally {
      if (mounted) setState(() => deleting = null);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (context, _) {
      final controller = widget.controller;
      return AlertDialog(
        title: const Text('Applets'),
        content: SizedBox(
          width: 440,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (error != null) Text(error!),
                if (controller.loading && controller.directory.isEmpty)
                  const LinearProgressIndicator(),
                if (!controller.loading &&
                    controller.directoryFailure == null &&
                    controller.directory.isEmpty)
                  const Text('No Applets yet. Ask a Bot to build one.'),
                if (controller.directoryFailure != null)
                  TextButton(
                    onPressed: controller.retry,
                    child: const Text('Couldn’t load Applets · Retry'),
                  ),
                for (final applet in controller.directory)
                  Row(
                    children: [
                      Expanded(
                        child: identified(
                          'applet-choice-${applet.appletId}',
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(applet.displayName),
                            onTap: deleting == null
                                ? () => Navigator.pop(context, applet.appletId)
                                : null,
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Delete ${applet.displayName}',
                        onPressed: deleting == null
                            ? () => remove(applet.appletId, applet.displayName)
                            : null,
                        icon: const Icon(Icons.delete_outline),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      );
    },
  );
}
